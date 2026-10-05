import type { Allowance, StreamMessage } from '@cancelchain/shared'
import { QueryClient, type QueryKey } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSlotFloors, type SlotFloors } from './slotFloors'
import { createStreamCache } from './streamCache'

/**
 * `createStreamCache` (`T042a`) against a real `QueryClient`: which reads each
 * message marks for a re-read, that nothing outside them is touched, that a
 * burst becomes one re-read, and that the slot floor is raised before it.
 */

const OWNER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH'
const OTHER_PDA = 'Stake11111111111111111111111111111111111111'

function allowance(overrides: Partial<Allowance> = {}): Allowance {
  return {
    pda: PDA,
    owner: OWNER,
    delegate: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    kind: 'fixed',
    capAmount: '25000000',
    periodSeconds: null,
    spentInPeriod: '0',
    periodStartedAt: null,
    expiresAt: null,
    pausedAt: null,
    endsAt: null,
    status: 'revoked',
    planPda: null,
    lastSlot: 412_345_678,
    syncedAt: '2026-10-05T10:00:00.000Z',
    ...overrides,
  }
}

/** Every read the page may hold, with the keys the hooks build. */
const KEYS = {
  list: ['allowances', 'api', OWNER, 0],
  card: ['allowance', 'api', PDA, 0],
  otherCard: ['allowance', 'api', OTHER_PDA, 0],
  feed: ['feed', 'api', PDA],
  otherFeed: ['feed', 'api', OTHER_PDA],
  history: ['history', 'api', PDA],
  plan: ['plan', 'api', 'PlanPda', OWNER],
  blockhash: ['blockhash', 'api'],
  mockList: ['allowances', 'mock', OWNER, 0],
} satisfies Record<string, QueryKey>

type Name = keyof typeof KEYS

let queryClient: QueryClient
let floors: SlotFloors
let flushes: (() => void)[]

function cache() {
  return createStreamCache({
    queryClient,
    kind: 'api',
    owner: OWNER,
    floors,
    flushMs: 100,
    timers: {
      setTimeout: (callback) => flushes.push(callback),
      clearTimeout: () => {
        flushes = []
      },
    },
  })
}

function flush() {
  const waiting = flushes
  flushes = []
  for (const callback of waiting) callback()
}

function invalidated(): Name[] {
  return (Object.keys(KEYS) as Name[]).filter(
    (name) => queryClient.getQueryState(KEYS[name])?.isInvalidated === true,
  )
}

beforeEach(() => {
  queryClient = new QueryClient()
  floors = createSlotFloors()
  flushes = []
  for (const key of Object.values(KEYS)) queryClient.setQueryData(key, { read: true })
})

describe('createStreamCache', () => {
  it('allowance.updated: the list and that card, read from at least its slot', () => {
    const stream = cache()
    stream.push({ type: 'allowance.updated', allowance: allowance() })

    expect(invalidated()).toEqual([])
    expect(floors.list(OWNER)).toBe(412_345_678)
    expect(floors.card(PDA)).toBe(412_345_678)
    flush()

    expect(invalidated()).toEqual(['list', 'card'])
  })

  it('a subscription also re-reads the plan screen, which says "already subscribed"', () => {
    const stream = cache()
    stream.push({
      type: 'allowance.updated',
      allowance: allowance({ kind: 'subscription', planPda: OTHER_PDA }),
    })
    flush()

    expect(invalidated()).toEqual(['list', 'card', 'plan'])
  })

  it('event.appended: that feed only', () => {
    const stream = cache()
    stream.push(appended(PDA))
    flush()

    expect(invalidated()).toEqual(['feed'])
    expect(floors.list(OWNER)).toBeUndefined()
  })

  it.each(['ready', 'resync'] as const)('%s: every read the stream speaks for', (type) => {
    const stream = cache()
    stream.push({ type })
    flush()

    expect(invalidated()).toEqual([
      'list',
      'card',
      'otherCard',
      'feed',
      'otherFeed',
      'history',
      'plan',
    ])
  })

  it('ping: nothing, and nothing scheduled', () => {
    const stream = cache()
    stream.push({ type: 'ping' })

    expect(flushes).toHaveLength(0)
  })

  it('a burst is one re-read per query, not one per message', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries')
    const stream = cache()
    stream.push({ type: 'allowance.updated', allowance: allowance({ lastSlot: 10 }) })
    stream.push(appended(PDA))
    stream.push({ type: 'allowance.updated', allowance: allowance({ lastSlot: 12 }) })
    stream.push(appended(PDA))

    expect(flushes).toHaveLength(1)
    flush()

    expect(spy.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ['allowances', 'api', OWNER],
      ['allowance', 'api', PDA],
      ['feed', 'api', PDA],
    ])
    expect(floors.card(PDA)).toBe(12)
  })

  it('an older change does not lower the floor', () => {
    const stream = cache()
    stream.push({ type: 'allowance.updated', allowance: allowance({ lastSlot: 12 }) })
    stream.push({ type: 'allowance.updated', allowance: allowance({ lastSlot: 10 }) })

    expect(floors.list(OWNER)).toBe(12)
  })

  it('cancel drops what was waiting', () => {
    const stream = cache()
    stream.push({ type: 'resync' })
    stream.cancel()
    flush()

    expect(invalidated()).toEqual([])
  })
})

function appended(pda: string): StreamMessage {
  return {
    type: 'event.appended',
    allowancePda: pda,
    event: {
      id: '7',
      allowancePda: pda,
      kind: 'rejected',
      amount: null,
      reason: 'revoked',
      signature: '5'.repeat(88),
      slot: 412_345_679,
      blockTime: '2026-10-05T10:00:00.000Z',
      chargesStopAt: null,
    },
  }
}
