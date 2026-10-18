import type { RecordedResponse } from '@cancelchain/shared/snapshot'
import { describe, expect, it } from 'vitest'
import {
  RecordedContractError,
  recordStage,
  stagePaths,
  UnsettledAnswerError,
  unmetExpectations,
} from './record.js'

const API = 'https://api.test'
const OWNER = '5nhMcYQg8oUDvrAoVALzRYHbFkBjn8H76noiUMAWCy7a'
const A = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const B = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'
const SIGNATURE =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
const AT = '2026-10-18T10:00:00.000Z'

const NOT_FOUND = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no permission' } } }

function event(pda: string, kind: string, id: string) {
  return {
    id,
    allowancePda: pda,
    kind,
    amount: null,
    reason: kind === 'rejected' ? 'revoked' : null,
    signature: SIGNATURE,
    slot: 1,
    blockTime: AT,
    chargesStopAt: null,
  }
}

function feed(pda: string, kinds: string[], nextCursor: string | null = null): RecordedResponse {
  return {
    status: 200,
    body: {
      items: kinds.map((kind, index) => event(pda, kind, String(index + 1))),
      nextCursor,
      truncatedAt: null,
      tracked: true,
      syncedAt: AT,
      stale: false,
      retention: null,
    },
  }
}

const EMPTY_SIGNATURES = { status: 200, body: { items: [], syncedAt: AT, more: false } }

/** The list as the API answers it; only `pda` matters to the expectations. */
function list(pdas: string[]): RecordedResponse {
  return { status: 200, body: { items: pdas.map((pda) => ({ pda })), syncedAt: AT } }
}

describe('stagePaths', () => {
  it('builds the paths the API client asks for', () => {
    expect(stagePaths(OWNER, [A])).toEqual({
      list: `/v1/allowances?owner=${OWNER}`,
      cards: [`/v1/allowances/${A}`],
      signatures: [`/v1/allowances/${A}/signatures`],
      feeds: [`/v1/allowances/${A}/events`],
    })
  })
})

describe('recordStage', () => {
  it('refuses a body the client would refuse, while devnet is still there to record again', async () => {
    const paths = stagePaths(OWNER, [])
    await expect(recordStage(API, paths, async () => ({ status: 200, body: {} }))).rejects.toThrow(
      RecordedContractError,
    )
  })

  it('refuses an error answer that is not in the error format', async () => {
    const paths = stagePaths(OWNER, [])
    await expect(
      recordStage(API, paths, async () => ({ status: 400, body: 'Bad request' })),
    ).rejects.toThrow(RecordedContractError)
  })

  it.each([429, 502, 503])('does not record a %i — the stage is read again', async (status) => {
    const paths = stagePaths(OWNER, [])
    await expect(
      recordStage(API, paths, async () => ({ status, body: '<html>502</html>' })),
    ).rejects.toThrow(UnsettledAnswerError)
  })

  it('follows a feed to its next pages', async () => {
    const paths = { ...stagePaths(OWNER, [A]), list: '', cards: [], signatures: [] }
    const asked: string[] = []
    const answers: Record<string, RecordedResponse> = {
      [`${API}/v1/allowances/${A}/events`]: feed(A, ['rejected'], 'page 2'),
      [`${API}/v1/allowances/${A}/events?cursor=page%202`]: feed(A, ['created']),
    }
    const responses = await recordStage(
      API,
      { ...paths, list: `/v1/allowances?owner=${OWNER}` },
      async (url) => {
        asked.push(url)
        if (url.includes('?owner=')) {
          return {
            status: 200,
            body: { items: [], syncedAt: AT, stale: false, unreadable: [] },
          }
        }
        const answer = answers[url]
        if (answer === undefined) throw new Error(`unexpected ${url}`)
        return answer
      },
    )
    expect(Object.keys(responses)).toEqual([
      `/v1/allowances?owner=${OWNER}`,
      `/v1/allowances/${A}/events`,
      `/v1/allowances/${A}/events?cursor=page%202`,
    ])
    expect(asked).toHaveLength(3)
  })

  it('records a 404 card as an answer', async () => {
    const paths = { ...stagePaths(OWNER, [A]), feeds: [], signatures: [] }
    const responses = await recordStage(API, paths, async (url) =>
      url.includes('?owner=')
        ? { status: 200, body: { items: [], syncedAt: AT, stale: false, unreadable: [] } }
        : NOT_FOUND,
    )
    expect(responses[`/v1/allowances/${A}`]).toEqual(NOT_FOUND)
  })
})

describe('unmetExpectations', () => {
  const paths = stagePaths(OWNER, [A, B])

  it('is empty when the stage shows everything it must', () => {
    const responses = {
      [paths.list]: list([B]),
      [`/v1/allowances/${A}`]: NOT_FOUND,
      [`/v1/allowances/${A}/events`]: feed(A, ['rejected', 'revoked', 'created']),
      [`/v1/allowances/${A}/signatures`]: EMPTY_SIGNATURES,
    }
    expect(
      unmetExpectations(responses, paths, {
        listed: [B],
        cancelled: [A],
        feeds: { [A]: ['created', 'revoked', 'rejected'] },
      }),
    ).toEqual([])
  })

  it('names what the API has not caught up with', () => {
    const responses = {
      [paths.list]: list([A]),
      [`/v1/allowances/${A}`]: { status: 200, body: {} },
      [`/v1/allowances/${B}/events`]: feed(B, ['created']),
    }
    expect(
      unmetExpectations(responses, paths, {
        listed: [B],
        cancelled: [A],
        feeds: { [B]: ['created', 'rejected'] },
      }),
    ).toEqual([
      `${B} is not listed yet`,
      `${A} is still listed`,
      `the card of ${A} does not say revoked yet`,
      `the feed of ${B} has no rejected event yet`,
    ])
  })

  it('takes a card marked revoked as cancelled, and an active one as not yet', () => {
    const card = (status: string) => ({ status: 200, body: { pda: A, status } })
    const expectation = { listed: [], cancelled: [A], feeds: {} }
    expect(
      unmetExpectations(
        { [paths.list]: list([]), [`/v1/allowances/${A}`]: card('revoked') },
        paths,
        expectation,
      ),
    ).toEqual([])
    expect(
      unmetExpectations(
        { [paths.list]: list([]), [`/v1/allowances/${A}`]: card('active') },
        paths,
        expectation,
      ),
    ).toEqual([`the card of ${A} does not say revoked yet`])
  })

  it('counts a feed the API refused as an empty one', () => {
    const responses = { [paths.list]: list([]), [`/v1/allowances/${A}/events`]: NOT_FOUND }
    expect(
      unmetExpectations(responses, paths, {
        listed: [],
        cancelled: [],
        feeds: { [A]: ['created'] },
      }),
    ).toEqual([`the feed of ${A} has no created event yet`])
  })
})
