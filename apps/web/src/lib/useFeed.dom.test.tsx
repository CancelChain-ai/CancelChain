// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFeed } from './useFeed'
import type { AddressHistoryView, EventPageView, FeedEvent } from './view'

/**
 * `useFeed` (`T041a`). Checked: the two promises stay apart — the address
 * history is read only for a permission the indexer has not seen (it costs
 * node requests) — and older pages follow the cursor.
 */

const mocks = vi.hoisted(() => ({
  getEvents: vi.fn<(id: string, cursor: string | null) => Promise<EventPageView | null>>(),
  getHistory: vi.fn<(id: string) => Promise<AddressHistoryView | null>>(),
}))

vi.mock('./source', () => ({
  source: { kind: 'api', getEvents: mocks.getEvents, getHistory: mocks.getHistory },
}))

const PDA = '3amcyam5KhjbWJLAMNPiAwpYPcV1atWSppEZK1ABoWBR'
const NOW = new Date('2026-10-03T10:00:00.000Z')

function event(id: string): FeedEvent {
  return {
    id,
    kind: 'charged',
    when: NOW,
    signature: `sig-${id}`,
    slot: Number(id),
    amount: 1n,
    reason: null,
    chargesStopAt: null,
  }
}

function page(over: Partial<EventPageView> = {}): EventPageView {
  return {
    tracked: true,
    events: [],
    nextCursor: null,
    truncatedAt: null,
    syncedAt: NOW,
    stale: false,
    ...over,
  }
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  mocks.getEvents.mockReset()
  mocks.getHistory.mockReset()
})

afterEach(cleanup)

describe('useFeed', () => {
  it('shows events of a tracked permission and never reads the address history', async () => {
    mocks.getEvents.mockResolvedValue(page({ events: [event('2'), event('1')] }))
    const { result } = renderHook(() => useFeed(PDA), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('tracked'))
    const state = result.current
    if (state.status !== 'tracked') throw new Error('expected a tracked feed')
    expect(state.events.map((e) => e.id)).toEqual(['2', '1'])
    expect(state.older.status).toBe('all')
    expect(mocks.getEvents).toHaveBeenCalledWith(PDA, null, expect.anything())
    expect(mocks.getHistory).not.toHaveBeenCalled()
  })

  it('follows the cursor for older events and appends them', async () => {
    mocks.getEvents.mockImplementation((_id, cursor) =>
      Promise.resolve(
        cursor === null
          ? page({ events: [event('3')], nextCursor: 'c1' })
          : page({ events: [event('1')], truncatedAt: new Date('2026-09-01T00:00:00.000Z') }),
      ),
    )
    const { result } = renderHook(() => useFeed(PDA), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('tracked'))
    const first = result.current
    if (first.status !== 'tracked' || first.older.status !== 'more') {
      throw new Error('expected older events to load')
    }
    const { load } = first.older
    act(() => load())

    await waitFor(() => {
      const state = result.current
      expect(state.status === 'tracked' && state.older.status).toBe('all')
    })
    const state = result.current
    if (state.status !== 'tracked') throw new Error('expected a tracked feed')
    expect(state.events.map((e) => e.id)).toEqual(['3', '1'])
    expect(state.truncatedAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(mocks.getEvents).toHaveBeenLastCalledWith(PDA, 'c1', expect.anything())
  })

  it('falls back to the address history for a permission the indexer has not seen', async () => {
    mocks.getEvents.mockResolvedValue(page({ tracked: false, stale: true, syncedAt: null }))
    mocks.getHistory.mockResolvedValue({ rows: [], syncedAt: NOW, more: false })
    const { result } = renderHook(() => useFeed(PDA), { wrapper })

    await waitFor(() => {
      const state = result.current
      expect(state.status === 'untracked' && state.history.status).toBe('ready')
    })
    const state = result.current
    if (state.status !== 'untracked') throw new Error('expected an untracked feed')
    expect(state.freshness).toEqual({ syncedAt: null, stale: true })
    expect(mocks.getHistory).toHaveBeenCalledOnce()
  })

  it('is unavailable for a source without a network', async () => {
    mocks.getEvents.mockResolvedValue(null)
    const { result } = renderHook(() => useFeed(PDA), { wrapper })
    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(mocks.getHistory).not.toHaveBeenCalled()
  })

  it('names the failure of the feed', async () => {
    mocks.getEvents.mockRejectedValue(new Error('the indexer store is down'))
    const { result } = renderHook(() => useFeed(PDA), { wrapper })
    await waitFor(() =>
      expect(result.current).toEqual({
        status: 'error',
        message: 'the indexer store is down',
      }),
    )
  })

  it('reads nothing without a permission', () => {
    const { result } = renderHook(() => useFeed(null), { wrapper })
    expect(result.current.status).toBe('loading')
    expect(mocks.getEvents).not.toHaveBeenCalled()
  })
})
