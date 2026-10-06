import { useInfiniteQuery } from '@tanstack/react-query'
import { describeFailure } from './api.js'
import { source } from './source.js'
import { type HistoryState, useHistory } from './useHistory.js'
import type { EventPageView, FeedEvent, FeedRetentionView } from './view.js'

/**
 * The card's feed (`T041a`, `FR-005`): the indexer's events of the permission,
 * newest first, with "show older" by cursor.
 *
 * Two promises are kept apart. A tracked permission shows events — what each
 * transaction did. A permission the indexer has never seen falls back to the
 * address history of `T030` — which transactions touched the address — and says
 * why; the two are never mixed into one list. The address history is read only
 * in that case: it costs node requests, and the public node runs out first.
 *
 * Like `useHistory`, a state of its own: a failed feed must not take the five
 * fields of `FR-002` off the screen.
 */

/** How far the feed is vouched for: the indexer's heartbeat. */
export interface FeedFreshness {
  syncedAt: Date | null
  stale: boolean
}

export type OlderState =
  | { status: 'all' }
  | { status: 'more'; load: () => void }
  | { status: 'loading' }
  | { status: 'failed'; message: string; load: () => void }

export type FeedState =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'untracked'; freshness: FeedFreshness; history: HistoryState }
  | {
      status: 'tracked'
      freshness: FeedFreshness
      events: FeedEvent[]
      /** From the last loaded page; shown only once nothing older is left to load. */
      truncatedAt: Date | null
      /** The store's depth (`T044`), from the first page — the freshest word on it. */
      retention: FeedRetentionView | null
      older: OlderState
    }

export function feedKey(id: string | null): readonly unknown[] {
  return ['feed', source.kind, id]
}

const RETRY_ATTEMPTS = 1

export function useFeed(id: string | null): FeedState {
  const query = useInfiniteQuery({
    queryKey: feedKey(id),
    queryFn: ({ pageParam, signal }): Promise<EventPageView | null> =>
      id === null ? Promise.resolve(null) : source.getEvents(id, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last?.nextCursor ?? null,
    enabled: id !== null,
    // No polling: `SC-006` is kept by the stream (`T042`), not by re-reading here.
    staleTime: 0,
    retry: RETRY_ATTEMPTS,
  })

  const first = query.data?.pages[0]
  const history = useHistory(id, first?.tracked === false)

  if (first === null) return { status: 'unavailable' }
  if (first === undefined) {
    if (query.isError) return { status: 'error', message: describeFailure(query.error) }
    return { status: 'loading' }
  }

  // The head of the feed is what freshness speaks about, so it is the first page's.
  const freshness = { syncedAt: first.syncedAt, stale: first.stale }
  if (!first.tracked) return { status: 'untracked', freshness, history }

  const pages = query.data?.pages.filter((page): page is EventPageView => page !== null) ?? []
  const load = () => void query.fetchNextPage()
  const older: OlderState = query.isFetchingNextPage
    ? { status: 'loading' }
    : query.isFetchNextPageError
      ? { status: 'failed', message: describeFailure(query.error), load }
      : query.hasNextPage
        ? { status: 'more', load }
        : { status: 'all' }

  return {
    status: 'tracked',
    freshness,
    events: pages.flatMap((page) => page.events),
    truncatedAt: pages.at(-1)?.truncatedAt ?? null,
    retention: first.retention,
    older,
  }
}
