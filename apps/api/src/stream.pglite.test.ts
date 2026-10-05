import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { allowances, events, type NewAllowance, STREAM_CHANNEL } from '@cancelchain/db'
import { type Allowance, type StreamMessage, toU64 } from '@cancelchain/shared'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readCachedAllowance } from './cache.js'
import { type FeedDb, readEvent, readFeed } from './feed.js'
import { type ListenConnection, startListener } from './listen.js'
import { createLogger } from './logger.js'
import { createStreamHub, type StreamHub } from './stream.js'

/**
 * The live stream end to end on a real Postgres (PGlite) with the migrations
 * that go to Supabase (`T042`): a row is written → the trigger announces it →
 * the listener hears it → the hub reads the row → a stream of its owner gets
 * the contract message. The same readers serve `/events` and the card, so what
 * the stream says matches what a reload would show.
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
const STRANGER = '8N6FWYVvCvcf3ZR2NfRmEbnVWZ1GvmuKXtqoMoBMvmKN'
const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const SIGNATURE =
  '2Z8w3XkjqwnhyLxJxYBESora4nKthwMoMJk1MzJ9NSq9spb6t4LWfwUxUw95mdma771522pU45EStDh5LLnv67Mj'

let client: PGlite
let db: FeedDb
let hub: StreamHub
let stop: () => Promise<void>
const received: StreamMessage[] = []
/** What the stream heard before anything was written: the listener coming up. */
let heardOnStart: StreamMessage[] = []

/** PGlite as the listening session: one in-process database plays both ends. */
function pgliteConnection(): ListenConnection {
  let unlisten: (() => Promise<void>) | null = null
  return {
    listen: async (channel, onNotify, onListen) => {
      unlisten = await client.listen(channel, onNotify)
      onListen()
    },
    close: async () => {
      await unlisten?.()
    },
  }
}

beforeAll(async () => {
  client = await PGlite.create()
  for (const migration of migrations) await client.exec(migration)
  db = drizzle(client)
}, 60_000)

afterAll(async () => {
  await client?.close()
})

beforeEach(async () => {
  await client.exec('TRUNCATE events, allowances RESTART IDENTITY CASCADE')
  received.length = 0
  hub = createStreamHub({
    read: {
      allowance: (pda) => readCachedAllowance(db, pda),
      event: (id) => readEvent(db, id),
    },
    logger: createLogger('silent'),
  })
  const listener = startListener({
    connect: pgliteConnection,
    notify: async (channel, payload) => {
      await client.query('select pg_notify($1, $2)', [channel, payload])
    },
    channel: STREAM_CHANNEL,
    onNotice: (payload) => void hub.notify(payload),
    onListen: () => hub.resync(),
    logger: createLogger('silent'),
    probeEveryMs: 20,
    probeTimeoutMs: 200,
  })
  stop = listener.stop
  hub.subscribe(OWNER, { send: (message) => received.push(message), close: () => {} })
  await until(() => received.length > 0)
  heardOnStart = received.splice(0)
})

afterEach(async () => {
  await stop()
})

/** Waits for a condition the event loop will make true, or fails after ~1 s. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(condition()).toBe(true)
}

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
    endsAt: null,
    status: 'active',
    planPda: PLAN,
    lastSlot: 507_073_173,
    syncedAt: '2026-10-05T10:00:00.000Z',
    ...over,
  }
}

async function store(allowance: Allowance): Promise<void> {
  const row: NewAllowance = {
    ...allowance,
    capAmount: toU64(allowance.capAmount),
    spentInPeriod: toU64(allowance.spentInPeriod),
  }
  await db.insert(allowances).values(row)
}

describe('the live stream on Postgres', () => {
  it('says resync the moment it starts listening — whatever came before went unheard', () => {
    expect(heardOnStart).toEqual([{ type: 'resync' }])
  })

  it('a stored permission reaches its owner as the very copy the card reads', async () => {
    await store(subscription())

    await until(() => received.length === 1)
    expect(received).toEqual([{ type: 'allowance.updated', allowance: subscription() }])
    expect(received[0]).toEqual({
      type: 'allowance.updated',
      allowance: await readCachedAllowance(db, PDA),
    })
  })

  it('a stored event reaches its owner as the very item the feed shows', async () => {
    await store(subscription())
    await until(() => received.length === 1)
    received.length = 0

    await db.insert(events).values({
      allowancePda: PDA,
      kind: 'rejected',
      amount: 10_000_000n,
      reason: 'merchant_account_missing',
      signature: SIGNATURE,
      position: 2,
      slot: 507_100_000,
      blockTime: '2026-10-05T10:01:00.000Z',
    })

    await until(() => received.length === 1)
    const page = await readFeed(db, PDA, { limit: 1 })
    expect(received).toEqual([{ type: 'event.appended', allowancePda: PDA, event: page.items[0] }])
  })

  it('a cancellation in one transaction: the permission, then its event, in that order', async () => {
    await store(subscription())
    await until(() => received.length === 1)
    received.length = 0

    await db.transaction(async (tx) => {
      await tx
        .update(allowances)
        .set({ endsAt: '2026-10-28T17:07:36.000Z' })
        .where(eq(allowances.pda, PDA))
      await tx.insert(events).values({
        allowancePda: PDA,
        kind: 'cancelled',
        signature: SIGNATURE,
        position: 0,
        slot: 507_200_000,
        blockTime: '2026-10-05T10:02:00.000Z',
        chargesStopAt: '2026-10-28T17:07:36.000Z',
      })
    })

    await until(() => received.length === 2)
    expect(received.map((message) => message.type)).toEqual(['allowance.updated', 'event.appended'])
  })

  it('another wallet’s permission does not reach this stream', async () => {
    await store(subscription({ owner: STRANGER }))
    await store(subscription({ pda: PLAN }))

    await until(() => received.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(received).toHaveLength(1)
    expect(received[0]?.type === 'allowance.updated' && received[0].allowance.pda).toBe(PLAN)
  })

  it('probes come back through Postgres, so a healthy listener never resyncs', async () => {
    // Probes every 20 ms with a 200 ms timeout: a lost echo would rebuild the
    // subscription and say resync.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(received).toEqual([])
  })
})
