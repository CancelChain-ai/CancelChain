import { WALLET_WATCH_TTL_MS, watchedWallets } from '@cancelchain/db'
import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'

/**
 * The API's side of `watched_wallets` (`T045`): a wallet with a stream open is
 * one someone is looking at, and the indexer's polling fallback reads exactly
 * those. Written whatever the indexer's mode — one row per wallet, refreshed per
 * stream ping — so switching to the fallback finds the open pages already listed.
 */
type WatchDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>

export async function watchWallet(db: WatchDb, owner: string, now = new Date()): Promise<void> {
  const activeUntil = new Date(now.getTime() + WALLET_WATCH_TTL_MS).toISOString()
  await db
    .insert(watchedWallets)
    .values({ owner, activeUntil })
    .onConflictDoUpdate({
      target: watchedWallets.owner,
      set: { activeUntil },
      // Two tabs of one wallet: the later deadline stands.
      setWhere: sql`${watchedWallets.activeUntil} < excluded.active_until`,
    })
}
