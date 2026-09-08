import type { Address } from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import {
  ApiContractError,
  ApiRequestError,
  ApiUnreachableError,
  createApiClient,
  describeFailure,
  type FetchLike,
} from './api'

const OWNER = '4DYhzGx6J2xgJWs7nSCnTXgBdEnoQ9VnKfarJVz2Jj96' as Address
const PDA = '3amcyam5KhjbWJLAMNPiAwpYPcV1atWSppEZK1ABoWBR'
const MERCHANT = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'

const ITEM = {
  pda: PDA,
  owner: OWNER,
  delegate: MERCHANT,
  mint: USDC,
  kind: 'recurring',
  capAmount: '24000000',
  periodSeconds: 2_592_000,
  spentInPeriod: '0',
  periodStartedAt: '2026-08-07T00:00:00.000Z',
  expiresAt: null,
  pausedAt: null,
  endsAt: null,
  status: 'active',
  planPda: null,
  lastSlot: 400_000_000,
  syncedAt: '2026-09-02T10:00:00.000Z',
  assetSupported: true,
}

const BODY = {
  items: [ITEM],
  syncedAt: '2026-09-02T10:00:00.000Z',
  stale: false,
  unreadable: [],
}

type Call = { url: string; init: unknown }

function respondWith(status: number, body: unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
  return { fetch: fetchImpl, calls }
}

describe('createApiClient', () => {
  it('asks for one owner and parses the answer against the shared contract', async () => {
    const { fetch, calls } = respondWith(200, BODY)
    const result = await createApiClient('http://localhost:8080', fetch).listAllowances(OWNER)

    expect(calls[0]?.url).toBe(`http://localhost:8080/v1/allowances?owner=${OWNER}`)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.assetSupported).toBe(true)
    expect(result.unreadable).toEqual([])
  })

  it('talks to its own origin when no API URL is configured', async () => {
    const { fetch, calls } = respondWith(200, BODY)
    await createApiClient('', fetch).listAllowances(OWNER)
    expect(calls[0]?.url).toBe(`/v1/allowances?owner=${OWNER}`)
  })

  it('does not double the slash on a base URL that ends with one', async () => {
    const { fetch, calls } = respondWith(200, BODY)
    await createApiClient('http://localhost:8080/', fetch).listAllowances(OWNER)
    expect(calls[0]?.url).toBe(`http://localhost:8080/v1/allowances?owner=${OWNER}`)
  })

  it('keeps the named error code the server sent', async () => {
    const { fetch } = respondWith(400, {
      error: { code: 'INVALID_INPUT', message: 'owner is not an address' },
    })
    const failure = await createApiClient('', fetch)
      .listAllowances(OWNER)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect((failure as ApiRequestError).code).toBe('INVALID_INPUT')
    expect((failure as ApiRequestError).status).toBe(400)
    expect((failure as ApiRequestError).message).toBe('owner is not an address')
  })

  it('still fails loudly when the error body is not our format', async () => {
    // Проксі й балансувальники відповідають своїм HTML — код тоді невідомий,
    // але це не робить відмову менш реальною.
    const { fetch } = respondWith(502, { nginx: true })
    const failure = await createApiClient('', fetch)
      .listAllowances(OWNER)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect((failure as ApiRequestError).code).toBeNull()
    expect((failure as ApiRequestError).status).toBe(502)
  })

  it('separates "we could not reach it" from "it said no"', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'))
    const failure = await createApiClient('http://localhost:8080', fetchImpl)
      .listAllowances(OWNER)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiUnreachableError)
    expect((failure as ApiUnreachableError).message).toContain('http://localhost:8080')
  })

  it('separates a body that does not match the contract from both', async () => {
    const { fetch } = respondWith(200, { items: [{ ...ITEM, capAmount: 24 }] })
    const failure = await createApiClient('', fetch)
      .listAllowances(OWNER)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiContractError)
  })

  it('does not dress up a cancelled request as a failure', async () => {
    const controller = new AbortController()
    const fetchImpl: FetchLike = () =>
      Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
    const failure = await createApiClient('', fetchImpl)
      .listAllowances(OWNER, controller.signal)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DOMException)
    expect(failure).not.toBeInstanceOf(ApiUnreachableError)
  })

  it('passes the abort signal down to fetch', async () => {
    const { fetch, calls } = respondWith(200, BODY)
    const controller = new AbortController()
    await createApiClient('', fetch).listAllowances(OWNER, controller.signal)
    const init = calls[0]?.init as { signal?: AbortSignal } | undefined
    expect(init?.signal).toBe(controller.signal)
  })
})

describe('describeFailure', () => {
  it('never blames the wallet for our own outage', () => {
    const message = describeFailure(new ApiUnreachableError('http://localhost:8080', null))
    expect(message).toContain('we failed to load')
  })

  it('says a contract mismatch is a version problem, not a retry problem', () => {
    expect(describeFailure(new ApiContractError('/v1/allowances', null))).toContain('out of date')
  })

  it('repeats what the server named', () => {
    expect(describeFailure(new ApiRequestError(429, 'RATE_LIMITED', 'slow down'))).toContain(
      'Too many requests',
    )
    expect(
      describeFailure(new ApiRequestError(400, 'INVALID_INPUT', 'owner is not an address')),
    ).toContain('owner is not an address')
  })
})

const CARD = {
  ...ITEM,
  chainState: {
    status: 'active',
    capAmount: '24000000',
    spentInPeriod: '0',
    periodStartedAt: '2026-08-07T00:00:00.000Z',
    pausedAt: null,
    endsAt: null,
    slot: 400_000_000,
  },
  diverged: false,
}

describe('one allowance by address', () => {
  it('asks for the address itself, without a wallet', async () => {
    // Дозволи публічні в мережі: гаманця тут не питають, бо `pda` вже й є тим,
    // що ідентифікує запис.
    const { fetch, calls } = respondWith(200, CARD)
    const card = await createApiClient('http://localhost:8879', fetch).getAllowance(PDA)

    expect(calls[0]?.url).toBe(`http://localhost:8879/v1/allowances/${PDA}`)
    expect(card.pda).toBe(PDA)
    expect(card.chainState?.slot).toBe(400_000_000)
    expect(card.diverged).toBe(false)
  })

  it('carries the state the network is missing as a state, not as a hole', async () => {
    const { fetch } = respondWith(200, {
      ...CARD,
      chainState: null,
      status: 'revoked',
      diverged: true,
    })
    const card = await createApiClient('', fetch).getAllowance(PDA)
    expect(card.chainState).toBeNull()
    expect(card.status).toBe('revoked')
  })

  it('leaves NOT_FOUND a named failure for the source to read', async () => {
    // Клієнт лишається тонкою межею з HTTP: «за цією адресою нічого немає» стає
    // відповіддю вище, у джерелі, а не тут.
    const { fetch } = respondWith(404, {
      error: { code: 'NOT_FOUND', message: 'no allowance at this address' },
    })
    const failure = await createApiClient('', fetch)
      .getAllowance(PDA)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiRequestError)
    expect((failure as ApiRequestError).code).toBe('NOT_FOUND')
  })

  it('fails loudly when the card does not match the contract', async () => {
    const { fetch } = respondWith(200, { ...CARD, diverged: 'no' })
    await expect(createApiClient('', fetch).getAllowance(PDA)).rejects.toBeInstanceOf(
      ApiContractError,
    )
  })
})
