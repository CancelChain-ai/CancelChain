import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  allowances,
  events,
  eventsRetention,
  indexerHeartbeat,
  type NewEvent,
} from '@cancelchain/db'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  decodeCursor,
  encodeCursor,
  type FeedDb,
  heartbeatAt,
  InvalidCursorError,
  readFeed,
  readRetention,
} from './feed.js'

/**
 * The feed query against a real Postgres (PGlite, in-process) with the very
 * migrations that go to Supabase: order and keyset paging are the database's
 * work here, and a fake would only repeat what the code believes.
 */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@cancelchain/db')))
const migrations = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) =>
    readFileSync(migrationDir + name, 'utf8').replaceAll('--> statement-breakpoint', ''),
  )

const PDA = 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2'
const OTHER = '3cNCoQXGZY87neBEvKQZArXnZnLkwTHUrb5Bt6qyB5zF'
const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
/** A real devnet signature; each event gets its own by changing the tail. */
const SIGNATURE =
  '2Z8w3XkjqwnhyLxJxYBESora4nKthwMoMJk1MzJ9NSq9spb6t4LWfwUxUw95mdma771522pU45EStDh5LLnv67Mj'
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

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
  await client.exec('TRUNCATE events, allowances, indexer_heartbeat RESTART IDENTITY CASCADE')
})

async function track(pda: string = PDA): Promise<void> {
  await db.insert(allowances).values({
    pda,
    owner: OWNER,
    delegate: PLAN,
    mint: USDC,
    kind: 'subscription',
    capAmount: 9_990_000n,
    periodSeconds: 2_592_000,
    spentInPeriod: 0n,
    periodStartedAt: '2026-09-28T17:07:36.000Z',
    expiresAt: null,
    pausedAt: null,
    endsAt: null,
    status: 'active',
    planPda: PLAN,
    lastSlot: 505_227_700,
    syncedAt: '2026-09-28T17:08:00.000Z',
  })
}

let serial = 0
function event(over: Partial<NewEvent> & Pick<NewEvent, 'kind' | 'slot'>): NewEvent {
  serial += 1
  const tail = `${BASE58[Math.floor(serial / 58) % 58]}${BASE58[serial % 58]}`
  return {
    allowancePda: PDA,
    amount: over.kind === 'charged' || over.kind === 'rejected' ? 1_000_000n : null,
    reason: null,
    signature: `${SIGNATURE.slice(0, -2)}${tail}`,
    position: 0,
    blockTime: new Date(Date.UTC(2026, 8, 28) + over.slot * 1000).toISOString(),
    raw: null,
    chargesStopAt: null,
    ...over,
  }
}

const kinds = (page: { items: { kind: string; slot: number }[] }) =>
  page.items.map((item) => `${item.kind}@${item.slot}`)

describe('readFeed', () => {
  it('a permission the indexer never saw: tracked false, not an empty history', async () => {
    expect(await readFeed(db, PDA, { limit: 50 })).toEqual({
      tracked: false,
      items: [],
      nextCursor: null,
      truncatedAt: null,
    })
  })

  it('newest first in chain order, whatever order the rows were stored in', async () => {
    await track()
    // Catch-up stores older transactions after newer ones: ids do not follow slots.
    await db
      .insert(events)
      .values([
        event({ kind: 'charged', slot: 300 }),
        event({ kind: 'created', slot: 100 }),
        event({ kind: 'rejected', slot: 200, reason: 'cap_exceeded' }),
      ])

    const page = await readFeed(db, PDA, { limit: 50 })
    expect(kinds(page)).toEqual(['charged@300', 'rejected@200', 'created@100'])
    expect(page.items[1]).toMatchObject({ reason: 'cap_exceeded', amount: '1000000' })
    expect(page.truncatedAt).toBeNull()
  })

  it('within one transaction, the later instruction first — a split payment keeps all three', async () => {
    await track()
    await db
      .insert(events)
      .values([
        event({ kind: 'created', slot: 100 }),
        event({ kind: 'charged', slot: 200, position: 7, amount: 7_000_000n }),
        event({ kind: 'charged', slot: 200, position: 23, amount: 500_000n }),
        event({ kind: 'charged', slot: 200, position: 15, amount: 2_500_000n }),
      ])
    const page = await readFeed(db, PDA, { limit: 50 })
    expect(page.items.map((item) => item.amount)).toEqual(['500000', '2500000', '7000000', null])
  })

  it('pages walk the whole feed: no repeats, no gaps, and the last page says it is the last', async () => {
    await track()
    await db.insert(events).values([
      event({ kind: 'created', slot: 100 }),
      ...[110, 120, 130, 140].map((slot) => event({ kind: 'charged', slot })),
      // Two transactions in one slot: the id breaks the tie, consistently.
      event({ kind: 'rejected', slot: 150 }),
      event({ kind: 'charged', slot: 150 }),
    ])

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await readFeed(db, PDA, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      })
      seen.push(...page.items.map((item) => item.id))
      cursor = page.nextCursor ?? undefined
      pages += 1
    } while (cursor !== undefined)

    const all = await readFeed(db, PDA, { limit: 100 })
    expect(seen).toEqual(all.items.map((item) => item.id))
    expect(new Set(seen).size).toBe(7)
    expect(pages).toBe(4)
  })

  it('only the current permission at the address: an earlier one there is another permission', async () => {
    await track()
    await db.insert(events).values([
      event({ kind: 'created', slot: 100 }),
      event({ kind: 'charged', slot: 110 }),
      event({ kind: 'revoked', slot: 120 }),
      // Same seeds, same address: subscribed again.
      event({ kind: 'created', slot: 200 }),
      event({ kind: 'charged', slot: 210 }),
    ])
    const page = await readFeed(db, PDA, { limit: 50 })
    expect(kinds(page)).toEqual(['charged@210', 'created@200'])
    expect(page.truncatedAt).toBeNull()
  })

  it('no creation in the store — the permission predates the indexer — the cut is said out loud', async () => {
    await track()
    await db
      .insert(events)
      .values([
        event({ kind: 'charged', slot: 300 }),
        event({ kind: 'cancelled', slot: 250, chargesStopAt: '2026-10-28T17:07:36.000Z' }),
      ])
    const page = await readFeed(db, PDA, { limit: 50 })
    expect(page.truncatedAt).toBe(new Date(Date.UTC(2026, 8, 28) + 250_000).toISOString())
    expect(page.items[1]).toMatchObject({
      kind: 'cancelled',
      chargesStopAt: '2026-10-28T17:07:36.000Z',
    })
  })

  it('another permission’s events never leak in', async () => {
    await track()
    await track(OTHER)
    await db
      .insert(events)
      .values([
        event({ kind: 'created', slot: 100 }),
        event({ kind: 'charged', slot: 110, allowancePda: OTHER }),
      ])
    expect(kinds(await readFeed(db, PDA, { limit: 50 }))).toEqual(['created@100'])
  })

  it('a cursor it did not issue is refused, not guessed', async () => {
    await track()
    const negative = Buffer.from('{"s":-1,"p":0,"i":"1"}').toString('base64url')
    for (const cursor of ['garbage', negative]) {
      await expect(readFeed(db, PDA, { limit: 2, cursor })).rejects.toBeInstanceOf(
        InvalidCursorError,
      )
    }
  })

  it('the cursor round-trips, ids beyond 2^53 included', () => {
    const key = { slot: 506_340_647, position: 23, id: 2n ** 60n + 1n }
    expect(decodeCursor(encodeCursor(key))).toEqual(key)
  })
})

describe('heartbeatAt', () => {
  it('null before the indexer ever ran, then its last beat', async () => {
    expect(await heartbeatAt(db)).toBeNull()
    await db
      .insert(indexerHeartbeat)
      .values({ name: 'program-logs', aliveAt: '2026-10-03T12:00:15Z' })
    expect(await heartbeatAt(db)).toBe('2026-10-03T12:00:15.000Z')
  })
})

describe('readRetention (T044)', () => {
  it('null before any pass, then the depth and the cut the worker wrote', async () => {
    await db.delete(eventsRetention)
    expect(await readRetention(db)).toBeNull()
    await db.insert(eventsRetention).values({
      name: 'events',
      days: 90,
      keptSince: '2026-07-05T12:00:00Z',
      ranAt: '2026-10-03T12:00:00Z',
    })
    expect(await readRetention(db)).toEqual({
      enforced: true,
      days: 90,
      keptSince: '2026-07-05T12:00:00.000Z',
    })
  })

  it('says nothing is deleted when the worker runs with retention off', async () => {
    await db.delete(eventsRetention)
    await db
      .insert(eventsRetention)
      .values({ name: 'events', days: null, keptSince: null, ranAt: '2026-10-03T12:00:00Z' })
    expect(await readRetention(db)).toEqual({ enforced: false })
  })
})
