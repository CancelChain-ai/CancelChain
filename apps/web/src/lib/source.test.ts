import type { Address } from '@cancelchain/shared'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type ApiClient,
  ApiRequestError,
  type GetAllowanceResponse,
  type ListAllowancesResponse,
} from './api'
import { PERMISSIONS } from './mockData'
import {
  createApiSource,
  createMockSource,
  createSource,
  mockData,
  sourceKindFromEnv,
  UnknownSourceError,
  WalletRequiredError,
} from './source'

const OWNER = '4DYhzGx6J2xgJWs7nSCnTXgBdEnoQ9VnKfarJVz2Jj96' as Address
const PDA = '3amcyam5KhjbWJLAMNPiAwpYPcV1atWSppEZK1ABoWBR'
const OTHER_PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH'
const MERCHANT = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const OTHER_MINT = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

function item(over: Partial<ListAllowancesResponse['items'][number]> = {}) {
  return {
    pda: PDA,
    owner: OWNER,
    delegate: MERCHANT,
    mint: USDC,
    kind: 'recurring' as const,
    capAmount: '24000000',
    periodSeconds: 2_592_000,
    spentInPeriod: '0',
    periodStartedAt: '2026-08-07T00:00:00.000Z',
    expiresAt: null,
    pausedAt: null,
    endsAt: null,
    status: 'active' as const,
    planPda: null,
    lastSlot: 400_000_000,
    syncedAt: '2026-09-02T10:00:00.000Z',
    assetSupported: true,
    ...over,
  }
}

function clientReturning(response: ListAllowancesResponse): ApiClient {
  return {
    listAllowances: () => Promise.resolve(response),
    getAllowance: () => Promise.reject(new Error('the list tests do not ask for one allowance')),
    getBlockhash: () => Promise.reject(new Error('the list tests do not build a transaction')),
    listSignatures: () => Promise.reject(new Error('the list tests do not ask for history')),
  }
}

describe('sourceKindFromEnv', () => {
  it('is the API when nothing is said', () => {
    // Замовчування на моці означало б, що випадково зібраний застосунок показує
    // вигадані числа як дозволи цього гаманця.
    expect(sourceKindFromEnv({})).toBe('api')
    expect(sourceKindFromEnv({ VITE_DATA_SOURCE: '' })).toBe('api')
  })

  it('takes the mock only when it is asked for', () => {
    expect(sourceKindFromEnv({ VITE_DATA_SOURCE: 'mock' })).toBe('mock')
  })

  it('refuses a name it does not know instead of guessing a side', () => {
    expect(() => sourceKindFromEnv({ VITE_DATA_SOURCE: 'fixture' })).toThrow(UnknownSourceError)
  })
})

describe('createSource', () => {
  it('builds the API source by default and the mock on request', () => {
    expect(createSource({}, fetch).kind).toBe('api')
    expect(createSource({ VITE_DATA_SOURCE: 'mock' }, fetch).kind).toBe('mock')
  })

  it('says whether there is a network behind it', () => {
    expect(createSource({}, fetch).onNetwork).toBe(true)
    expect(createSource({ VITE_DATA_SOURCE: 'mock' }, fetch).onNetwork).toBe(false)
  })
})

describe('the mock source', () => {
  afterEach(() => {
    // Мок живий, і тест, який його змінив, не має права лишати це наступному.
    for (const permission of PERMISSIONS) {
      mockData.update(permission.id, () => permission)
    }
  })

  it('needs no wallet — and says so, instead of showing an empty list', async () => {
    const source = createMockSource()
    expect(source.requiresWallet).toBe(false)
    const list = await source.listAllowances(null)
    expect(list.items).toHaveLength(PERMISSIONS.length)
  })

  it('has nothing it failed to read', async () => {
    const list = await createMockSource().listAllowances(null)
    expect(list.unreadable).toEqual([])
    expect(list.stale).toBe(false)
  })

  it('shows what the demo changed by clicking', async () => {
    const first = PERMISSIONS[0]
    expect(first).toBeDefined()
    const id = (first as (typeof PERMISSIONS)[number]).id
    mockData.update(id, (permission) => ({ ...permission, state: 'cancelled' }))

    const list = await createMockSource().listAllowances(null)
    expect(list.items.find((view) => view.id === id)?.status).toBe('revoked')
    // Константа мока при цьому лишається цілою.
    expect(PERMISSIONS.find((p) => p.id === id)?.state).not.toBe('cancelled')
  })
})

describe('the API source', () => {
  it('is a list of one wallet, and refuses to pretend otherwise', async () => {
    const source = createApiSource(
      clientReturning({
        items: [],
        syncedAt: '2026-09-02T10:00:00.000Z',
        stale: false,
        unreadable: [],
      }),
    )
    expect(source.requiresWallet).toBe(true)
    await expect(source.listAllowances(null)).rejects.toBeInstanceOf(WalletRequiredError)
  })

  it('keeps an allowance in an unsupported asset in the list', async () => {
    const source = createApiSource(
      clientReturning({
        items: [
          item(),
          item({ pda: OTHER_PDA, mint: OTHER_MINT, assetSupported: false, capAmount: '500' }),
        ],
        syncedAt: '2026-09-02T10:00:00.000Z',
        stale: false,
        unreadable: [],
      }),
    )

    const list = await source.listAllowances(OWNER)
    expect(list.items).toHaveLength(2)
    expect(list.items[1]?.assetSupported).toBe(false)
  })

  it('carries the accounts it could not read through untouched', async () => {
    // `FR-006`: список не має права тихо коротшати. Те, що не стало карткою,
    // мусить дійти до екрана з назвою причини.
    const source = createApiSource(
      clientReturning({
        items: [item()],
        syncedAt: '2026-09-02T10:00:00.000Z',
        stale: true,
        unreadable: [{ address: OTHER_PDA, reason: 'version' }],
      }),
    )

    const list = await source.listAllowances(OWNER)
    expect(list.unreadable).toEqual([{ address: OTHER_PDA, reason: 'version' }])
    expect(list.stale).toBe(true)
    expect(list.syncedAt).toBe('2026-09-02T10:00:00.000Z')
  })
})

function card(over: Partial<GetAllowanceResponse> = {}): GetAllowanceResponse {
  return {
    ...item(),
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
    ...over,
  }
}

function cardClient(answer: () => Promise<GetAllowanceResponse>): ApiClient {
  return {
    listAllowances: () => Promise.reject(new Error('the card tests do not ask for the list')),
    getAllowance: answer,
    getBlockhash: () => Promise.reject(new Error('the card tests do not build a transaction')),
    listSignatures: () => Promise.reject(new Error('these tests ask for history explicitly')),
  }
}

describe('one allowance from the mock', () => {
  it('finds the one the demo opened', async () => {
    const first = PERMISSIONS[0]
    expect(first).toBeDefined()
    const detail = await createMockSource().getAllowance((first as (typeof PERMISSIONS)[number]).id)
    expect(detail?.id).toBe((first as (typeof PERMISSIONS)[number]).id)
    expect(detail?.networkState).toBe('none')
  })

  it('answers "there is none" instead of inventing one', async () => {
    expect(await createMockSource().getAllowance('sub-does-not-exist')).toBeNull()
  })
})

describe('one allowance from the API', () => {
  it('reads the card and judges the period by the moment it was read', async () => {
    const source = createApiSource(
      cardClient(() =>
        Promise.resolve(
          card({
            syncedAt: '2026-09-02T10:00:00.000Z',
            periodStartedAt: '2026-08-07T00:00:00.000Z',
          }),
        ),
      ),
    )
    const detail = await source.getAllowance(PDA)
    expect(detail?.address).toBe(PDA)
    expect(detail?.syncedAt.toISOString()).toBe('2026-09-02T10:00:00.000Z')
    expect(detail?.periodElapsed).toBe(false)
  })

  it('turns NOT_FOUND into an answer, not into a failure', async () => {
    // «За цією адресою дозволу немає ніде» — це відповідь. Показати замість неї
    // «не вдалося завантажити» означало б назвати збоєм єдину річ, заради якої
    // продукт існує (`FR-022`).
    const source = createApiSource(
      cardClient(() =>
        Promise.reject(new ApiRequestError(404, 'NOT_FOUND', 'no allowance at this address')),
      ),
    )
    expect(await source.getAllowance(OTHER_PDA)).toBeNull()
  })

  it('does not swallow any other failure the same way', async () => {
    const source = createApiSource(
      cardClient(() => Promise.reject(new ApiRequestError(500, 'INTERNAL', 'account unreadable'))),
    )
    await expect(source.getAllowance(PDA)).rejects.toBeInstanceOf(ApiRequestError)
  })

  it('keeps a permission in a foreign asset readable, with cancelling the only thing left', async () => {
    const source = createApiSource(
      cardClient(() =>
        Promise.resolve(card({ mint: OTHER_MINT, assetSupported: false, capAmount: '500' })),
      ),
    )
    const detail = await source.getAllowance(PDA)
    expect(detail?.assetSupported).toBe(false)
    expect(detail?.cap.decimals).toBeNull()
  })
})

/**
 * Історія адреси (`T030`). Мок мережі не має, і саме тому віддає `null`, а не
 * порожній масив: порожня стрічка була б твердженням про історію, якої ніхто
 * не читав.
 */
describe('the history behind one allowance', () => {
  const SIGNATURE =
    '5wHu1qwD4kLwYbtcSNVXrGwEA5gXtWFCbGwYRnYQ2rMFcvCqDbwWLKJHVsUqM3zJ7z3rHmxsHTvQ4rC1BEuFyRxk'

  function historyClient(response: {
    items: { signature: string; slot: number; blockTime: string | null; failed: boolean }[]
    syncedAt: string
    more: boolean
  }): ApiClient {
    return {
      listAllowances: () => Promise.reject(new Error('the history tests do not ask for the list')),
      getAllowance: () => Promise.reject(new Error('the history tests do not ask for the card')),
      getBlockhash: () => Promise.reject(new Error('the history tests do not build a transaction')),
      listSignatures: () => Promise.resolve(response),
    }
  }

  it('the mock has none, and says so as an answer', async () => {
    const first = PERMISSIONS[0]
    expect(first).toBeDefined()
    expect(await createMockSource().getHistory(first?.id ?? '')).toBeNull()
  })

  it('turns the answer into dates the screen can format', async () => {
    const source = createApiSource(
      historyClient({
        items: [
          {
            signature: SIGNATURE,
            slot: 400_000_001,
            blockTime: '2026-09-03T09:00:00.000Z',
            failed: true,
          },
          {
            signature: `${SIGNATURE.slice(0, 87)}z`,
            slot: 400_000_000,
            blockTime: null,
            failed: false,
          },
        ],
        syncedAt: '2026-09-03T10:00:00.000Z',
        more: true,
      }),
    )
    const history = await source.getHistory(PDA)

    expect(history?.rows).toHaveLength(2)
    expect(history?.rows[0]?.when?.toISOString()).toBe('2026-09-03T09:00:00.000Z')
    expect(history?.rows[0]?.failed).toBe(true)
    // Невідомий час блоку лишається невідомим — не «зараз» і не час читання.
    expect(history?.rows[1]?.when).toBeNull()
    expect(history?.more).toBe(true)
  })
})
