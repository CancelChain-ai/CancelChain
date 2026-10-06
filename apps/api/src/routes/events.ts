import type { Address, FeedRetention } from '@cancelchain/shared'
import {
  EVENTS_STALE_AFTER_MS,
  getAllowanceParamsSchema,
  listEventsQuerySchema,
  listEventsResponseSchema,
} from '@cancelchain/shared'
import { Hono } from 'hono'
import { fail } from '../errors.js'
import { type FeedPage, InvalidCursorError } from '../feed.js'
import type { AppEnv } from '../types.js'
import { validate } from '../validate.js'

/**
 * `GET /v1/allowances/:pda/events` — the indexer's feed of one permission
 * (`T041`, `FR-005`): what each transaction did, charges with amounts and
 * refusals with a category. `/signatures` (`T030`) stays what it is — which
 * transactions touched the address.
 *
 * The feed is a cache and says how far to trust it. A permission the indexer
 * has never seen answers `200` with `tracked: false`, not `404`: the store not
 * knowing it does not mean the network has no history of it. `stale` comes from
 * the indexer's heartbeat, not from the cursor — the cursor moves only when the
 * program has transactions.
 */

export type EventsDeps = {
  feed: (pda: Address, page: { cursor?: string; limit: number }) => Promise<FeedPage>
  /** The indexer's last heartbeat, `null` when it never ran. */
  aliveAt: () => Promise<string | null>
  /** The depth the worker last enforced (`T044`); `null` — none reported yet. */
  retention: () => Promise<FeedRetention | null>
  now?: () => number
}

export function eventsRoute(deps: EventsDeps): Hono<AppEnv> {
  const now = deps.now ?? Date.now
  return new Hono<AppEnv>().get(
    '/v1/allowances/:pda/events',
    validate('param', getAllowanceParamsSchema),
    validate('query', listEventsQuerySchema),
    async (c) => {
      const { pda } = c.req.valid('param')
      const { cursor, limit } = c.req.valid('query')
      let page: FeedPage
      try {
        page = await deps.feed(pda, { ...(cursor === undefined ? {} : { cursor }), limit })
      } catch (error) {
        if (error instanceof InvalidCursorError) return fail(c, 'INVALID_INPUT', error.message)
        throw error
      }
      const [syncedAt, retention] = await Promise.all([deps.aliveAt(), deps.retention()])
      return c.json(
        listEventsResponseSchema.parse({
          ...page,
          syncedAt,
          stale: syncedAt === null || now() - Date.parse(syncedAt) > EVENTS_STALE_AFTER_MS,
          retention,
        }),
      )
    },
  )
}
