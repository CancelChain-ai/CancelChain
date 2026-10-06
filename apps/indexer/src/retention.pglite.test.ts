import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  allowances,
  events,
  eventsRetention,
  type NewEvent,
  pushDeliveries,
  pushSubscriptions,
} from '@cancelchain/db'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RETENTION_NAME, runRetention } from './retention.js'
import type { StoreDb } from './store.js'

/**
 * Retention against a real Postgres (PGlite) with the very migrations that go
 * to Supabase: the cut, the batches and the floor of 90 days are the
 * database's work here as much as the code's.
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
const SIGNATURE =
  '2Z8w3XkjqwnhyLxJxYBESora4nKthwMoMJk1MzJ9NSq9spb6t4LWfwUxUw95mdma771522pU45EStDh5LLnv67Mj'
const NOW = new Date('2026-12-31T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString()

let client: PGlite
let db: StoreDb

beforeAll(async () => {
  client = await PGlite.create()
  for (const migration of migrations) await client.exec(migration)
  db = drizzle(client)
}, 60_000)

afterAll(async () => {
  await client?.close()
})

beforeEach(async () => {
  await client.exec(
    'delete from push_deliveries; delete from push_subscriptions; delete from events; delete from allowances; delete from events_retention;',
  )
  await db.insert(allowances).values({
    pda: PDA,
    owner: OWNER,
    delegate: PLAN,
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    kind: 'subscription',
    capAmount: 9_990_000n,
    periodSeconds: 2_592_000,
    periodStartedAt: ago(10),
    status: 'active',
    planPda: PLAN,
    lastSlot: 1,
  })
})

function event(daysAgo: number, position: number): NewEvent {
  return {
    allowancePda: PDA,
    kind: 'charged',
    amount: 9_990_000n,
    reason: null,
    signature: SIGNATURE,
    position,
    slot: 1,
    blockTime: ago(daysAgo),
    raw: null,
    chargesStopAt: null,
  }
}

const kept = async () =>
  (await db.select({ at: events.blockTime }).from(events)).map((row) =>
    new Date(row.at).toISOString(),
  )

describe('runRetention', () => {
  it('drops events older than the window, keeps the rest and writes the cut down', async () => {
    await db.insert(events).values([event(200, 1), event(91, 2), event(89, 3), event(1, 4)])

    const result = await runRetention({ db, days: 90, now: () => NOW })

    expect(result).toEqual({ keptSince: ago(90), deletedEvents: 2, deletedDeliveries: 0 })
    expect((await kept()).sort()).toEqual([ago(89), ago(1)].sort())
    const [row] = await db.select().from(eventsRetention)
    expect(row?.name).toBe(RETENTION_NAME)
    expect(row?.days).toBe(90)
    expect(new Date(row?.keptSince ?? '').toISOString()).toBe(ago(90))
    expect(new Date(row?.ranAt ?? '').toISOString()).toBe(NOW.toISOString())
  })

  it('deletes in batches until nothing older is left', async () => {
    await db.insert(events).values(Array.from({ length: 7 }, (_, index) => event(100, index)))
    const result = await runRetention({ db, days: 90, now: () => NOW, batch: 3 })
    expect(result.deletedEvents).toBe(7)
    expect(await kept()).toEqual([])
  })

  it('keeps everything when off, and says so in the row', async () => {
    await db.insert(events).values([event(400, 1)])
    expect(await runRetention({ db, days: null, now: () => NOW })).toEqual({
      keptSince: null,
      deletedEvents: 0,
      deletedDeliveries: 0,
    })
    expect(await kept()).toHaveLength(1)
    expect(await db.select().from(eventsRetention)).toEqual([
      expect.objectContaining({ days: null, keptSince: null }),
    ])
  })

  it('refuses a window shorter than FR-029, and so does the table', async () => {
    await expect(runRetention({ db, days: 30, now: () => NOW })).rejects.toThrow(/FR-029/)
    await expect(
      db.insert(eventsRetention).values({
        name: 'x',
        days: 30,
        keptSince: ago(30),
        ranAt: NOW.toISOString(),
      }),
    ).rejects.toThrow()
  })

  it('never moves the recorded cut back to an older pass', async () => {
    await runRetention({ db, days: 90, now: () => NOW })
    await runRetention({ db, days: 90, now: () => new Date(NOW.getTime() - DAY) })
    const [row] = await db.select().from(eventsRetention)
    expect(new Date(row?.keptSince ?? '').toISOString()).toBe(ago(90))
  })

  it('forgets push deliveries older than the window', async () => {
    const [subscription] = await db
      .insert(pushSubscriptions)
      .values({
        owner: OWNER,
        endpoint: 'https://fcm.googleapis.com/fcm/send/x',
        p256dh: 'k',
        auth: 'a',
      })
      .returning({ id: pushSubscriptions.id })
    if (subscription === undefined) throw new Error('no subscription')
    await db.insert(pushDeliveries).values([
      { subscriptionId: subscription.id, kind: 'rejected', ref: '1', sentAt: ago(120) },
      { subscriptionId: subscription.id, kind: 'rejected', ref: '2', sentAt: ago(3) },
    ])
    const result = await runRetention({ db, days: 90, now: () => NOW })
    expect(result.deletedDeliveries).toBe(1)
    expect((await db.select().from(pushDeliveries)).map((row) => row.ref)).toEqual(['2'])
  })
})
