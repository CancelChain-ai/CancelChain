import { allowances } from '@cancelchain/db'
import { type Allowance, allowanceSchema, fromU64 } from '@cancelchain/shared'
import { eq } from 'drizzle-orm'
import { type FeedDb, iso } from './feed.js'

/**
 * The stored copy of one permission, in the contract's shape (`T041b`), or
 * `null` when the indexer has not cached it. The card compares it with the
 * chain to say whether the two disagree (`FR-024`, `FR-025`).
 *
 * The row is converted at this boundary and nowhere else: amounts come back as
 * `bigint` (`money` columns), moments as `2026-09-28 17:07:36+00`. Parsed raw,
 * every row the indexer wrote failed the schema, and `diverged` was never
 * computed. The schema still runs after the conversion — the row was written by
 * another process, and its shape is checked, not trusted.
 */
export async function readCachedAllowance(db: FeedDb, pda: string): Promise<Allowance | null> {
  const [row] = await db.select().from(allowances).where(eq(allowances.pda, pda)).limit(1)
  if (row === undefined) return null
  return allowanceSchema.parse({
    ...row,
    capAmount: fromU64(row.capAmount),
    spentInPeriod: fromU64(row.spentInPeriod),
    periodStartedAt: isoOrNull(row.periodStartedAt),
    expiresAt: isoOrNull(row.expiresAt),
    pausedAt: isoOrNull(row.pausedAt),
    endsAt: isoOrNull(row.endsAt),
    syncedAt: iso(row.syncedAt),
  })
}

function isoOrNull(moment: string | null): string | null {
  return moment === null ? null : iso(moment)
}
