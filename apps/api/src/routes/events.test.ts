import { type AllowanceEvent, apiErrorSchema, listEventsResponseSchema } from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app.js'
import { type FeedPage, InvalidCursorError } from '../feed.js'
import { createLogger } from '../logger.js'
import { createStreamHub } from '../stream.js'

/**
 * `GET /v1/allowances/:pda/events` — `T041`. The query itself is checked on
 * PGlite (`feed.pglite.test.ts`); here: the contract, the trust flags and the
 * edges of the input.
 */

const PDA = 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2'
const NOW = Date.parse('2026-10-03T12:00:30.000Z')
const SLOT = 506_340_647

const REFUSAL: AllowanceEvent = {
  id: '42',
  allowancePda: PDA,
  kind: 'rejected',
  amount: '10000000',
  reason: 'merchant_account_missing',
  signature:
    '2Z8w3XkjqwnhyLxJxYBESora4nKthwMoMJk1MzJ9NSq9spb6t4LWfwUxUw95mdma771522pU45EStDh5LLnv67Mj',
  slot: SLOT,
  blockTime: '2026-09-30T10:00:00.000Z',
  chargesStopAt: null,
}

const TRACKED: FeedPage = { tracked: true, items: [REFUSAL], nextCursor: null, truncatedAt: null }

function app(events: Partial<AppDeps['events']> = {}) {
  return createApp({
    logger: createLogger('silent'),
    health: {
      ping: async () => {},
      currentSlot: async () => SLOT,
      cachedAt: async () => null,
      startedAt: NOW,
      now: () => NOW,
    },
    allowances: {
      list: async () => ({
        slot: SLOT,
        syncedAt: '2026-10-03T12:00:00.000Z',
        allowances: [],
        unreadable: [],
      }),
      get: async () => ({
        slot: SLOT,
        syncedAt: '2026-10-03T12:00:00.000Z',
        allowance: null,
        unreadable: null,
      }),
      cached: async () => null,
      settlementMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    },
    events: {
      feed: async () => TRACKED,
      aliveAt: async () => '2026-10-03T12:00:15.000Z',
      retention: async () => ({
        enforced: true,
        days: 90,
        keptSince: '2026-07-05T12:00:00.000Z',
      }),
      now: () => NOW,
      ...events,
    },
    stream: { hub: idleHub() },
    signatures: {
      history: async () => ({ items: [], syncedAt: '2026-10-03T12:00:00.000Z', more: false }),
    },
    // Only `createApp` needs these; no check here reaches them.
    merchants: {
      jwtSecret: 'test-secret-at-least-32-characters',
      domain: 'localhost',
      plan: async () => {
        throw new Error('the merchant routes take no part in these checks')
      },
      save: async () => {},
      verifySignature: async () => false,
    },
    plans: {
      plan: async () => {
        throw new Error('the plan route takes no part in these checks')
      },
      catalog: async () => null,
      settlementMint: 'So11111111111111111111111111111111111111112',
      subscriber: async () => {
        throw new Error('the plan route takes no part in these checks')
      },
    },
    blockhash: {
      latestBlockhash: async () => ({
        blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
        lastValidBlockHeight: 492_096_495n,
        slot: SLOT,
      }),
    },
  })
}

async function get(application: ReturnType<typeof app>, query = '') {
  const response = await application.request(`/v1/allowances/${PDA}/events${query}`)
  return { status: response.status, body: (await response.json()) as unknown }
}

describe('GET /v1/allowances/:pda/events', () => {
  it('the feed, with its category in place and the indexer vouching for it', async () => {
    const { status, body } = await get(app())
    expect(status).toBe(200)
    expect(listEventsResponseSchema.parse(body)).toEqual({
      ...TRACKED,
      syncedAt: '2026-10-03T12:00:15.000Z',
      retention: { enforced: true, days: 90, keptSince: '2026-07-05T12:00:00.000Z' },
      stale: false,
    })
  })

  it('asks the store for exactly the page the client named, 50 by default', async () => {
    const asked: { pda: string; page: object }[] = []
    const application = app({
      feed: async (pda, page) => {
        asked.push({ pda, page })
        return TRACKED
      },
    })
    await get(application)
    await get(application, '?limit=2&cursor=abc')
    expect(asked).toEqual([
      { pda: PDA, page: { limit: 50 } },
      { pda: PDA, page: { limit: 2, cursor: 'abc' } },
    ])
  })

  it('a permission the indexer never saw: 200 and tracked false, not 404', async () => {
    const { status, body } = await get(
      app({
        feed: async () => ({ tracked: false, items: [], nextCursor: null, truncatedAt: null }),
      }),
    )
    expect(status).toBe(200)
    expect(body).toMatchObject({ tracked: false, items: [] })
  })

  it('stale when the last heartbeat is older than SC-006 allows', async () => {
    const { body } = await get(app({ aliveAt: async () => '2026-10-03T11:59:59.000Z' }))
    expect(body).toMatchObject({ stale: true, syncedAt: '2026-10-03T11:59:59.000Z' })
  })

  it('stale, with no time to show, when the indexer never ran', async () => {
    const { body } = await get(app({ aliveAt: async () => null }))
    expect(body).toMatchObject({ stale: true, syncedAt: null })
  })

  it('names the depth the worker last enforced (T044, FR-029)', async () => {
    const { body } = await get(app())
    expect(body).toMatchObject({
      retention: { enforced: true, days: 90, keptSince: '2026-07-05T12:00:00.000Z' },
    })
  })

  it('says when nothing is deleted, and when no retention pass has reported yet', async () => {
    expect((await get(app({ retention: async () => ({ enforced: false }) }))).body).toMatchObject({
      retention: { enforced: false },
    })
    expect((await get(app({ retention: async () => null }))).body).toMatchObject({
      retention: null,
    })
  })

  it('a cursor the feed did not issue is the client’s mistake: 400, not 500', async () => {
    const { status, body } = await get(
      app({
        feed: async () => {
          throw new InvalidCursorError()
        },
      }),
      '?cursor=forged',
    )
    expect(status).toBe(400)
    expect(apiErrorSchema.parse(body).error.code).toBe('INVALID_INPUT')
  })

  it('refuses a page over 100 and an address that is not one', async () => {
    expect((await get(app(), '?limit=101')).status).toBe(400)
    const response = await app().request('/v1/allowances/not-an-address/events')
    expect(response.status).toBe(400)
  })
})

/** A stream hub nobody notifies: the stream route exists, nothing flows. */
function idleHub() {
  return createStreamHub({
    read: { allowance: async () => null, event: async () => null },
    logger: createLogger('silent'),
  })
}
