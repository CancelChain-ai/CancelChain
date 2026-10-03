import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { allowances, type NewAllowance } from '@cancelchain/db'
import { type Allowance, toU64 } from '@cancelchain/shared'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readCachedAllowance } from './cache.js'
import type { FeedDb } from './feed.js'
import { reconcile } from './routes/allowances.js'

/**
 * The card's stored copy (`T041b`) against a real Postgres (PGlite) with the
 * migrations that go to Supabase. What matters is what the database hands
 * back — `bigint` amounts and `2026-09-28 17:07:36+00` moments — and a fake
 * would only hand back what the code expects.
 */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@cancelchain/db')))
const migrations = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) =>
    readFileSync(migrationDir + name, 'utf8').replaceAll('--> statement-breakpoint', ''),
  )

const PDA = 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2'
const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'

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
  await client.exec('TRUNCATE allowances CASCADE')
})

/** The live devnet subscription `CKjAhy…`, as the chain read gives it. */
function subscription(over: Partial<Allowance> = {}): Allowance {
  return {
    pda: PDA,
    owner: OWNER,
    delegate: PLAN,
    mint: USDC,
    kind: 'subscription',
    capAmount: '9990000',
    periodSeconds: 2_592_000,
    spentInPeriod: '0',
    periodStartedAt: '2026-09-28T17:07:36.000Z',
    expiresAt: null,
    pausedAt: null,
    endsAt: '2026-10-28T17:07:36.000Z',
    status: 'active',
    planPda: PLAN,
    lastSlot: 507_073_173,
    syncedAt: '2026-10-03T17:31:21.095Z',
    ...over,
  }
}

/** The row exactly as the indexer's `upsertAllowance` builds it. */
async function store(allowance: Allowance): Promise<void> {
  const row: NewAllowance = {
    ...allowance,
    capAmount: toU64(allowance.capAmount),
    spentInPeriod: toU64(allowance.spentInPeriod),
  }
  await db.insert(allowances).values(row)
}

describe('readCachedAllowance', () => {
  it('reads back the very contract the indexer stored', async () => {
    const stored = subscription()
    await store(stored)
    expect(await readCachedAllowance(db, PDA)).toEqual(stored)
  })

  it('keeps a u64 amount whole, up to u64::MAX', async () => {
    // The customary "no limit" ceiling: past i64, which the columns were before `T041c`.
    const stored = subscription({
      capAmount: '18446744073709551615',
      spentInPeriod: '9007199254740993',
    })
    await store(stored)
    expect(await readCachedAllowance(db, PDA)).toEqual(stored)
  })

  it('reads a one-off permission with its expiry and no period', async () => {
    const stored = subscription({
      kind: 'fixed',
      delegate: OWNER,
      planPda: null,
      periodSeconds: null,
      periodStartedAt: null,
      endsAt: null,
      expiresAt: '2026-12-31T23:59:59.000Z',
    })
    await store(stored)
    expect(await readCachedAllowance(db, PDA)).toEqual(stored)
  })

  it('reads the off-chain pause label', async () => {
    const stored = subscription({ status: 'paused', pausedAt: '2026-10-01T08:00:00.000Z' })
    await store(stored)
    expect(await readCachedAllowance(db, PDA)).toEqual(stored)
  })

  it('answers null for a permission the indexer has not cached', async () => {
    expect(await readCachedAllowance(db, PDA)).toBeNull()
  })
})

/**
 * The reason `T041b` exists: the card's `diverged` (`FR-024`). Before it, every
 * stored row failed the schema, and the card said "no disagreement" because it
 * had nothing to compare with.
 */
describe('the stored copy against the chain', () => {
  const settlementMint = USDC

  it('agrees with an identical chain read — the moments match to the character', async () => {
    await store(subscription())
    const cached = await readCachedAllowance(db, PDA)
    const card = reconcile({
      cached,
      chain: { ...subscription(), assetSupported: true },
      slot: 507_073_200,
      settlementMint,
    })
    expect(card?.diverged).toBe(false)
  })

  it('shows a disagreement once the chain moved on', async () => {
    await store(subscription())
    const cached = await readCachedAllowance(db, PDA)
    const chain = { ...subscription({ spentInPeriod: '9990000' }), assetSupported: true }
    const card = reconcile({ cached, chain, slot: 507_073_200, settlementMint })
    expect(card?.diverged).toBe(true)
  })

  it('shows a stored "active" over a closed account as a disagreement', async () => {
    await store(subscription())
    const cached = await readCachedAllowance(db, PDA)
    const card = reconcile({ cached, chain: null, slot: 507_073_200, settlementMint })
    expect(card?.diverged).toBe(true)
  })
})
