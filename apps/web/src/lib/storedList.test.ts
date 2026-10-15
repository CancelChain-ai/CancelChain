import type { ListedAllowance } from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import type { ListAllowancesResponse } from './api'
import { createListStore, listDivergence, STORED_LIST_PREFIX } from './storedList'
import { viewFromAllowance } from './view'

/**
 * The browser's copy of the last list (`SC-008`). It is shown before the network
 * answers, so what it must never do is pass off a broken or foreign value as a
 * wallet's permissions: a copy that does not parse is no copy.
 */

const OWNER = '4DYhzGx6J2xgJWs7nSCnTXgBdEnoQ9VnKfarJVz2Jj96'
const OTHER_OWNER = 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe'
const PDA = '3amcyam5KhjbWJLAMNPiAwpYPcV1atWSppEZK1ABoWBR'
const OTHER_PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH'
const THIRD_PDA = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const NOW = new Date('2026-10-15T10:00:00.000Z')

function listed(over: Partial<ListedAllowance> = {}): ListedAllowance {
  return {
    pda: PDA,
    owner: OWNER,
    delegate: OTHER_OWNER,
    mint: USDC,
    kind: 'recurring',
    capAmount: '24000000',
    periodSeconds: 30 * 86_400,
    spentInPeriod: '12000000',
    periodStartedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: null,
    pausedAt: null,
    endsAt: null,
    status: 'active',
    planPda: null,
    lastSlot: 400_000_000,
    syncedAt: NOW.toISOString(),
    assetSupported: true,
    ...over,
  }
}

function response(items: ListedAllowance[] = [listed()]): ListAllowancesResponse {
  return { items, syncedAt: NOW.toISOString(), stale: false, unreadable: [] }
}

function memoryStorage(): Storage {
  const entries = new Map<string, string>()
  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, String(value)),
  }
}

describe('createListStore', () => {
  it('gives back the response it saved, for that wallet only', () => {
    const store = createListStore(memoryStorage())
    store.save(OWNER, response())
    expect(store.read(OWNER)).toEqual(response())
    expect(store.read(OTHER_OWNER)).toBeNull()
  })

  it('keeps the latest response of a wallet, not the first', () => {
    const store = createListStore(memoryStorage())
    store.save(OWNER, response())
    store.save(OWNER, response([]))
    expect(store.read(OWNER)?.items).toEqual([])
  })

  it.each([
    ['not JSON', '{'],
    ['another shape', JSON.stringify({ version: 1, response: { items: 'none' } })],
    ['another version of the copy', JSON.stringify({ version: 2, response: response() })],
    [
      'an item that breaks the schema',
      JSON.stringify({ version: 1, response: response([listed({ capAmount: '-1' })]) }),
    ],
  ])('reads a copy that is %s as no copy, and drops it', (_, raw) => {
    const storage = memoryStorage()
    storage.setItem(`${STORED_LIST_PREFIX}${OWNER}`, raw)
    const store = createListStore(storage)
    expect(store.read(OWNER)).toBeNull()
    expect(storage.getItem(`${STORED_LIST_PREFIX}${OWNER}`)).toBeNull()
  })

  it('forgets every wallet on clear and leaves other keys alone', () => {
    const storage = memoryStorage()
    storage.setItem('cancelchain:selected-wallet', 'Stub Wallet:x')
    const store = createListStore(storage)
    store.save(OWNER, response())
    store.save(OTHER_OWNER, response([]))
    store.clear()
    expect(store.read(OWNER)).toBeNull()
    expect(store.read(OTHER_OWNER)).toBeNull()
    expect(storage.getItem('cancelchain:selected-wallet')).toBe('Stub Wallet:x')
  })

  it('lives without storage at all, and with storage that throws', () => {
    const none = createListStore(null)
    none.save(OWNER, response())
    expect(none.read(OWNER)).toBeNull()

    const throwing = memoryStorage()
    throwing.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    throwing.getItem = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    const store = createListStore(throwing)
    expect(() => store.save(OWNER, response())).not.toThrow()
    expect(store.read(OWNER)).toBeNull()
    expect(() => store.clear()).not.toThrow()
  })
})

describe('listDivergence', () => {
  const view = (over: Partial<ListedAllowance>) => viewFromAllowance(listed(over), NOW)
  const list = (items: ReturnType<typeof view>[]) => ({
    items,
    syncedAt: NOW.toISOString(),
    stale: false,
    unreadable: [],
  })

  it('counts nothing for the same permissions in the same state', () => {
    expect(listDivergence(list([view({})]), list([view({ lastSlot: 400_000_100 })]))).toEqual({
      added: 0,
      gone: 0,
      changed: 0,
    })
  })

  it('counts permissions gone, new and changed', () => {
    const saved = list([view({}), view({ pda: OTHER_PDA })])
    const fresh = list([view({ spentInPeriod: '24000000' }), view({ pda: THIRD_PDA })])
    expect(listDivergence(saved, fresh)).toEqual({ added: 1, gone: 1, changed: 1 })
  })

  it.each<[string, Partial<ListedAllowance>]>([
    ['status', { status: 'paused', pausedAt: '2026-10-10T00:00:00.000Z' }],
    ['cap', { capAmount: '1' }],
    ['end date', { kind: 'subscription', planPda: OTHER_PDA, endsAt: '2026-11-01T00:00:00.000Z' }],
    ['expiry', { expiresAt: '2027-01-01T00:00:00.000Z' }],
    ['next charge', { periodStartedAt: '2026-10-02T00:00:00.000Z' }],
  ])('sees a change of %s', (_, over) => {
    expect(listDivergence(list([view({})]), list([view(over)])).changed).toBe(1)
  })
})
