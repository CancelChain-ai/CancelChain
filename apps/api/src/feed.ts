import {
  allowances,
  type EventRow,
  events,
  eventsRetention,
  indexerHeartbeat,
  PROGRAM_LOGS,
  watchedWallets,
} from '@cancelchain/db'
import {
  type AllowanceEvent,
  eventSchema,
  type FeedRetention,
  feedRetentionSchema,
  fromU64,
} from '@cancelchain/shared'
import { and, desc, eq, min, type SQL, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { z } from 'zod'

/**
 * The indexer's feed of one permission, read from the store (`T041`).
 *
 * Order is the chain's: slot, then the instruction's place in its transaction,
 * newest first; the row id only breaks ties between transactions of one slot.
 * The id alone would not do — catch-up stores older transactions after newer
 * ones.
 *
 * Only the **current** permission at the address is returned: the same seeds
 * give the same address again after a close, and an earlier permission there is
 * another permission (owner's decision, 2026-10-03). It starts at the latest
 * `created`. When the store holds no creation — the permission predates the
 * indexer — the feed is cut at its oldest stored event, and says so.
 */

/** Any drizzle Postgres handle: postgres-js in production, PGlite in tests. */
export type FeedDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>

export type FeedPage = {
  tracked: boolean
  items: AllowanceEvent[]
  nextCursor: string | null
  truncatedAt: string | null
}

type Key = { slot: number; position: number; id: bigint }

const cursorSchema = z.object({
  s: z.number().int().nonnegative(),
  p: z.number().int().nonnegative(),
  i: z.string().regex(/^\d+$/),
})

export class InvalidCursorError extends Error {
  constructor() {
    super('cursor is not one this feed issued')
    this.name = 'InvalidCursorError'
  }
}

export function encodeCursor(key: Key): string {
  const json = JSON.stringify({ s: key.slot, p: key.position, i: key.id.toString() })
  return Buffer.from(json, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): Key {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    return { slot: parsed.s, position: parsed.p, id: BigInt(parsed.i) }
  } catch {
    throw new InvalidCursorError()
  }
}

/** Postgres answers `2026-10-03 12:00:00+00`; the contract speaks ISO 8601. */
export function iso(moment: string): string {
  return new Date(moment).toISOString()
}

export async function readFeed(
  db: FeedDb,
  pda: string,
  page: { cursor?: string; limit: number },
): Promise<FeedPage> {
  const after = page.cursor === undefined ? null : decodeCursor(page.cursor)

  const tracked = await db
    .select({ pda: allowances.pda })
    .from(allowances)
    .where(eq(allowances.pda, pda))
    .limit(1)
  if (tracked.length === 0) {
    return { tracked: false, items: [], nextCursor: null, truncatedAt: null }
  }

  const [creation] = await db
    .select({ slot: events.slot, position: events.position })
    .from(events)
    .where(and(eq(events.allowancePda, pda), eq(events.kind, 'created')))
    .orderBy(desc(events.slot), desc(events.position))
    .limit(1)

  const conditions: SQL[] = [eq(events.allowancePda, pda)]
  if (creation !== undefined) {
    conditions.push(
      sql`(${events.slot}, ${events.position}) >= (${creation.slot}, ${creation.position})`,
    )
  }
  if (after !== null) {
    conditions.push(
      sql`(${events.slot}, ${events.position}, ${events.id}) < (${after.slot}, ${after.position}, ${after.id})`,
    )
  }
  const rows = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.slot), desc(events.position), desc(events.id))
    .limit(page.limit + 1)

  const shown = rows.slice(0, page.limit)
  const last = shown.at(-1)
  const nextCursor =
    rows.length > page.limit && last !== undefined
      ? encodeCursor({ slot: last.slot, position: last.position, id: last.id })
      : null

  let truncatedAt: string | null = null
  if (creation === undefined) {
    const [oldest] = await db
      .select({ at: min(events.blockTime) })
      .from(events)
      .where(eq(events.allowancePda, pda))
    truncatedAt = oldest?.at === null || oldest?.at === undefined ? null : iso(oldest.at)
  }

  return {
    tracked: true,
    items: shown.map(eventFromRow),
    nextCursor,
    truncatedAt,
  }
}

/** One stored row in the contract's shape. It was written by another process; its shape is checked, not trusted. */
function eventFromRow(row: EventRow): AllowanceEvent {
  return eventSchema.parse({
    id: row.id.toString(),
    allowancePda: row.allowancePda,
    kind: row.kind,
    amount: row.amount === null ? null : fromU64(row.amount),
    reason: row.reason,
    signature: row.signature,
    slot: row.slot,
    blockTime: iso(row.blockTime),
    chargesStopAt: row.chargesStopAt === null ? null : iso(row.chargesStopAt),
  })
}

/** One event by its id, for the live stream (`T042`); `null` when the store has no such row. */
export async function readEvent(db: FeedDb, id: string): Promise<AllowanceEvent | null> {
  const [row] = await db
    .select()
    .from(events)
    .where(eq(events.id, BigInt(id)))
    .limit(1)
  return row === undefined ? null : eventFromRow(row)
}

/** The indexer's last heartbeat, or `null` when it has never run against this store. */
export async function heartbeatAt(db: FeedDb): Promise<string | null> {
  const [row] = await db
    .select({ aliveAt: indexerHeartbeat.aliveAt })
    .from(indexerHeartbeat)
    .orderBy(desc(indexerHeartbeat.aliveAt))
    .limit(1)
  return row === undefined ? null : iso(row.aliveAt)
}

/**
 * How fresh one permission's feed is (`T045`): the later of the log loop's
 * pulse — it reads the whole program — and, in the polling fallback, the moment
 * the permission's wallet was last read to the head. The fallback's own pulse
 * does not count: it says the poller is alive, not that this wallet was read.
 * `null` when neither ever happened.
 */
export async function feedSyncedAt(db: FeedDb, pda: string): Promise<string | null> {
  const [[pulse], [wallet]] = await Promise.all([
    db
      .select({ at: indexerHeartbeat.aliveAt })
      .from(indexerHeartbeat)
      .where(eq(indexerHeartbeat.name, PROGRAM_LOGS))
      .limit(1),
    db
      .select({ at: watchedWallets.syncedAt })
      .from(allowances)
      .innerJoin(watchedWallets, eq(watchedWallets.owner, allowances.owner))
      .where(eq(allowances.pda, pda))
      .limit(1),
  ])
  const moments = [pulse?.at, wallet?.at].flatMap((at) =>
    at === undefined || at === null ? [] : [iso(at)],
  )
  if (moments.length === 0) return null
  return moments.reduce((later, at) => (Date.parse(at) > Date.parse(later) ? at : later))
}

/**
 * The depth the worker last enforced (`T044`, `FR-029`), or `null` when no
 * retention pass has reported to this store yet. Read from the worker's own
 * row, not from configuration: the page names what was done.
 */
export async function readRetention(db: FeedDb): Promise<FeedRetention | null> {
  const [row] = await db
    .select({ days: eventsRetention.days, keptSince: eventsRetention.keptSince })
    .from(eventsRetention)
    .orderBy(desc(eventsRetention.ranAt))
    .limit(1)
  if (row === undefined) return null
  return feedRetentionSchema.parse(
    row.days === null || row.keptSince === null
      ? { enforced: false }
      : { enforced: true, days: row.days, keptSince: iso(row.keptSince) },
  )
}
