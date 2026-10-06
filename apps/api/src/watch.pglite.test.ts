import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WALLET_WATCH_TTL_MS, watchedWallets } from '@cancelchain/db'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FeedDb } from './feed.js'
import { watchWallet } from './watch.js'

/** `watched_wallets` from the API's side (`T045`), on the migrations that go to Supabase. */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@cancelchain/db')))
const migrations = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) =>
    readFileSync(migrationDir + name, 'utf8').replaceAll('--> statement-breakpoint', ''),
  )

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const NOW = new Date('2026-10-06T12:00:00.000Z')

let client: PGlite
let db: FeedDb

beforeAll(async () => {
  client = await PGlite.create()
  for (const migration of migrations) await client.exec(migration)
  db = drizzle(client)
}, 60_000)

afterAll(async () => {
  await client?.close()
})

beforeEach(async () => {
  await client.exec('TRUNCATE watched_wallets')
})

async function row() {
  const [found] = await db.select().from(watchedWallets).where(eq(watchedWallets.owner, OWNER))
  return found
}

describe('watchWallet', () => {
  it('keeps a wallet watched for one TTL from the sign of life', async () => {
    await watchWallet(db, OWNER, NOW)
    expect(Date.parse((await row())?.activeUntil ?? '')).toBe(NOW.getTime() + WALLET_WATCH_TTL_MS)
    expect((await row())?.syncedAt).toBeNull()
  })

  it('moves the deadline forward, never back — two tabs of one wallet', async () => {
    await watchWallet(db, OWNER, new Date(NOW.getTime() + 60_000))
    await watchWallet(db, OWNER, NOW)
    expect(Date.parse((await row())?.activeUntil ?? '')).toBe(
      NOW.getTime() + 60_000 + WALLET_WATCH_TTL_MS,
    )
  })

  it('leaves what the indexer wrote alone', async () => {
    await watchWallet(db, OWNER, NOW)
    await db
      .update(watchedWallets)
      .set({ syncedAt: '2026-10-06T12:00:10Z' })
      .where(eq(watchedWallets.owner, OWNER))
    await watchWallet(db, OWNER, new Date(NOW.getTime() + 20_000))
    expect(Date.parse((await row())?.syncedAt ?? '')).toBe(Date.parse('2026-10-06T12:00:10Z'))
  })

  it('outlives three stream pings, so one lost write does not drop an open page', () => {
    expect(WALLET_WATCH_TTL_MS).toBeGreaterThan(3 * 20_000)
  })
})
