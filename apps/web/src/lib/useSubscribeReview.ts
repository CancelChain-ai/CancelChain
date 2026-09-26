import { useQuery } from '@tanstack/react-query'
import { ApiRequestError, describeFailure } from './api.js'
import { source } from './source.js'
import { reviewSubscription, type SubscribeReview } from './subscribeReview.js'

/**
 * The subscribe screen's state (`T036`). As with the card, "no plan at this
 * address" is its own state, not an error: a link to a deleted plan is an
 * answer the screen has to give in words.
 */
export type SubscribeReviewState =
  /** The page was opened without a plan address. */
  | { status: 'no-plan' }
  | { status: 'loading' }
  | { status: 'missing'; plan: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; review: SubscribeReview }

const RETRY_ATTEMPTS = 1

/** `describeFailure` speaks of permissions; a refused plan read is about the plan. */
function describePlanFailure(error: unknown): string {
  if (
    error instanceof ApiRequestError &&
    error.code !== 'RATE_LIMITED' &&
    error.code !== 'INVALID_INPUT'
  ) {
    return `CancelChain could not read this plan: ${error.message}`
  }
  return describeFailure(error)
}

export function useSubscribeReview(
  plan: string | null,
  owner: string | null,
): SubscribeReviewState {
  const reader = source.plans
  const query = useQuery({
    // The wallet is part of the key: the transaction is built for it, and a
    // review built for another wallet must never be shown for this one.
    queryKey: ['plan', source.kind, plan, owner],
    queryFn: async ({ signal }) => {
      if (plan === null || reader === null) return null
      const view = await reader.get(plan, owner, signal)
      return view === null ? null : reviewSubscription(view)
    },
    enabled: plan !== null && reader !== null,
    staleTime: 0,
    retry: RETRY_ATTEMPTS,
  })

  if (plan === null) return { status: 'no-plan' }
  if (query.isPending) return { status: 'loading' }
  if (query.isError) return { status: 'error', message: describePlanFailure(query.error) }
  if (query.data === null) return { status: 'missing', plan }
  return { status: 'ready', review: query.data }
}
