import { events, eventsRetention, pushDeliveries } from '@cancelchain/db'
import { MIN_FEED_RETENTION_DAYS } from '@cancelchain/shared'
import { inArray, lt, sql } from 'drizzle-orm'
import type { StoreDb } from './store.js'

/**
 * The feed's retention (`T044`, `FR-029`, `SC-013`): events older than the
 * window leave our store, and the cut is written down for the API to show.
 *
 * Deleting here loses nothing that cannot be had again: `events` is a cache of
 * public chain history, and the page links to the full trail on the network
 * wherever ours ends. What it saves is the free tier's 500 MB.
 *
 * The cut is a row (`events_retention`) and not the configuration because the
 * page has to name what was done: a worker that stopped running retention, or
 * an API configured with another number, would otherwise name a depth nobody
 * enforces.
 */

export const RETENTION_NAME = 'events'

/** `FR-029`: the feed keeps at least this many days — the contract's own number. */
export const MIN_RETENTION_DAYS = MIN_FEED_RETENTION_DAYS

/** Once a day, as `PLAN.md` says; the first pass runs at start. */
export const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Rows per delete. A month of a busy program in one statement would hold a
 * lock on the feed and a pooled connection the API shares for that long.
 */
export const RETENTION_BATCH = 5_000

export type RetentionResult = {
  /** `null` — retention is off and nothing was deleted. */
  keptSince: string | null
  deletedEvents: number
  deletedDeliveries: number
}

export type RetentionOptions = {
  db: StoreDb
  /** `null` — off: every indexed event is kept, and the page says so. */
  days: number | null
  now?: () => Date
  batch?: number
}

export async function runRetention(options: RetentionOptions): Promise<RetentionResult> {
  const { db, days } = options
  const now = (options.now ?? (() => new Date()))()
  const batch = options.batch ?? RETENTION_BATCH

  if (days === null) {
    await record(db, { days: null, keptSince: null, ranAt: now.toISOString() })
    return { keptSince: null, deletedEvents: 0, deletedDeliveries: 0 }
  }
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS) {
    throw new RangeError(`retention of ${days} days is shorter than FR-029 allows`)
  }

  const keptSince = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

  let deletedEvents = 0
  for (;;) {
    const deleted = await db
      .delete(events)
      .where(
        inArray(
          events.id,
          db
            .select({ id: events.id })
            .from(events)
            .where(lt(events.blockTime, keptSince))
            .limit(batch),
        ),
      )
      .returning({ id: events.id })
    deletedEvents += deleted.length
    if (deleted.length < batch) break
  }

  // A delivery older than the window names an event or a period that is gone:
  // nothing could be sent for it again, and the row is only weight.
  const deliveries = await db
    .delete(pushDeliveries)
    .where(lt(pushDeliveries.sentAt, keptSince))
    .returning({ ref: pushDeliveries.ref })

  await record(db, { days, keptSince, ranAt: now.toISOString() })
  return { keptSince, deletedEvents, deletedDeliveries: deliveries.length }
}

async function record(
  db: StoreDb,
  row: { days: number | null; keptSince: string | null; ranAt: string },
): Promise<void> {
  await db
    .insert(eventsRetention)
    .values({ name: RETENTION_NAME, ...row })
    .onConflictDoUpdate({
      target: eventsRetention.name,
      set: row,
      // Two workers during a rolling deploy: the later cut wins, never the older.
      setWhere: sql`${eventsRetention.ranAt} <= ${row.ranAt}`,
    })
}
