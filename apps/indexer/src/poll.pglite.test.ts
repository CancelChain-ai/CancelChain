import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AllowanceReadOne, ReadAllowance } from '@cancelchain/chain'
import { findSubscriptionAuthority } from '@cancelchain/chain'
import { events, indexerCursor, STREAM_CHANNEL, watchedWallets } from '@cancelchain/db'
import { PGlite } from '@electric-sql/pglite'
import { type Address, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from '@solana/kit'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DecodedTransaction, TransactionRecord } from './decode.js'
import {
  ADDRESS_CURSOR_PREFIX,
  createWalletBook,
  type PolledSignature,
  runWalletPoller,
  type WalletSource,
} from './poll.js'
import { CURSOR_NAME, createStore, type StoreDb } from './store.js'

/**
 * The polling fallback (`T045`) against a real Postgres (PGlite) with the
 * migrations that go to Supabase, the real store and real devnet transactions.
 *
 * The node is scripted, but honestly: an address's history is exactly the
 * fixtures whose account keys contain that address — the way the node builds
 * `getSignaturesForAddress`. So "authority + open permissions see every
 * transaction of the wallet" is checked against what the transactions really
 * carry, not against what the poller assumes.
 */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@cancelchain/db')))
const migrations = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) =>
    readFileSync(migrationDir + name, 'utf8').replaceAll('--> statement-breakpoint', ''),
  )

function fixture(name: string): TransactionRecord {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/devnet/${name}.json`, import.meta.url), 'utf8'),
  )
}

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR' as Address
const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg' as Address
const SUBSCRIPTION = 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2' as Address
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const AUTHORITY = (await findSubscriptionAuthority({ user: OWNER, tokenMint: USDC })).address

// The wallet's life on devnet: subscribed, cancelled, then a charge the protocol refused.
const SUBSCRIBE = fixture('subscribe')
const CANCEL = fixture('cancel-subscription')
const REFUSED = fixture('reject-merchant-no-token-account')
/** Another wallet's charge: must never be read for this one. */
const STRANGER = fixture('charge-recurring')

function keysOf(tx: TransactionRecord): string[] {
  const loaded = tx.meta?.loadedAddresses
  return [
    ...tx.transaction.message.accountKeys,
    ...(loaded?.writable ?? []),
    ...(loaded?.readonly ?? []),
  ].map(String)
}

function infoOf(tx: TransactionRecord): PolledSignature {
  return {
    signature: tx.transaction.signatures[0] as string,
    slot: BigInt(tx.slot),
    blockTime: tx.blockTime === null || tx.blockTime === undefined ? null : Number(tx.blockTime),
  }
}

const sig = (tx: TransactionRecord) => tx.transaction.signatures[0] as string

/** A node whose history grows as the test lands transactions. */
function scriptedNode(landed: TransactionRecord[]) {
  const asked: { address: string; until: string | null }[] = []
  let refuse = 0
  const node: WalletSource & { asked: typeof asked; refuseNext(times: number): void } = {
    asked,
    refuseNext(times) {
      refuse = times
    },
    async signaturesFor(address, { until, before, limit }) {
      asked.push({ address, until: until ?? null })
      if (refuse > 0) {
        refuse--
        throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
          headers: new Headers(),
          message: 'Too Many Requests',
          statusCode: 429,
        })
      }
      const newestFirst = landed
        .filter((tx) => keysOf(tx).includes(address))
        .sort((a, b) => Number(b.slot) - Number(a.slot))
        .map(infoOf)
      const stop = until === undefined ? -1 : newestFirst.findIndex((i) => i.signature === until)
      const newer = stop === -1 ? newestFirst : newestFirst.slice(0, stop)
      const start = before === undefined ? 0 : newer.findIndex((i) => i.signature === before) + 1
      return newer.slice(start, start + limit)
    },
    async transaction(signature) {
      return landed.find((tx) => sig(tx) === signature) ?? null
    },
    async permissionsOf(owner) {
      return owner === OWNER ? [SUBSCRIPTION] : []
    },
  }
  return node
}

function subscription(): ReadAllowance {
  return {
    pda: SUBSCRIPTION,
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
    lastSlot: 505_227_700,
    syncedAt: '2026-09-28T17:08:00.000Z',
    assetSupported: true,
  }
}

const silent = { info() {}, warn() {}, error() {} }

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
    'TRUNCATE events, allowances, indexer_cursor, indexer_heartbeat, watched_wallets RESTART IDENTITY CASCADE',
  )
})

async function watch(owner: string, untilMs = Date.now() + 60_000): Promise<void> {
  await db
    .insert(watchedWallets)
    .values({ owner, activeUntil: new Date(untilMs).toISOString() })
    .onConflictDoUpdate({
      target: watchedWallets.owner,
      set: { activeUntil: new Date(untilMs).toISOString() },
    })
}

/** Runs the poller for `rounds` rounds (a round that the node refused counts too). */
async function poll(
  node: WalletSource,
  options: {
    rounds?: number
    sink?: (decoded: DecodedTransaction) => Promise<void>
    retentionDays?: number | null
    now?: () => Date
  } = {},
) {
  const store = createStore({
    db,
    readAllowance: async (pda): Promise<AllowanceReadOne> => ({
      slot: 505_900_000,
      syncedAt: '2026-10-06T00:00:00.000Z',
      allowance: pda === SUBSCRIPTION ? { ...subscription(), lastSlot: 505_900_000 } : null,
      unreadable: null,
    }),
    log: silent,
  })
  const controller = new AbortController()
  let rounds = 0
  let ended = 0
  const lines: { level: string; message: string; object: object }[] = []
  const at = (level: string) => (object: object, message: string) => {
    lines.push({ level, message, object })
  }
  // Rounds the node refused do not call `onRound`; count them through the log.
  const log = {
    info: at('info'),
    error: at('error'),
    warn: (object: object, message: string) => {
      at('warn')(object, message)
      if (message === 'node refused the poll — backing off' && ++ended >= (options.rounds ?? 1)) {
        controller.abort()
      }
    },
  }
  await runWalletPoller({
    source: node,
    book: createWalletBook(db),
    refresh: (pdas) => store.refresh(pdas),
    sink: async (decoded) => {
      await options.sink?.(decoded)
      await store.write(decoded, { programCursor: false })
    },
    log,
    signal: controller.signal,
    settlementMint: USDC,
    retentionDays: options.retentionDays === undefined ? null : options.retentionDays,
    intervalMs: 1,
    ...(options.now === undefined ? {} : { now: options.now }),
    sleep: async () => {},
    onRound: () => {
      rounds++
      if (++ended >= (options.rounds ?? 1)) controller.abort()
    },
  })
  return { rounds, lines }
}

async function feed(): Promise<{ kind: string; signature: string }[]> {
  return db
    .select({ kind: events.kind, signature: events.signature })
    .from(events)
    .orderBy(asc(events.slot), asc(events.position))
}

async function cursorOf(name: string) {
  const [row] = await db.select().from(indexerCursor).where(eq(indexerCursor.name, name))
  return row ?? null
}

async function syncedAt(owner: string): Promise<string | null> {
  const [row] = await db.select().from(watchedWallets).where(eq(watchedWallets.owner, owner))
  return row?.syncedAt ?? null
}

describe('runWalletPoller (T045)', () => {
  it('catches up a watched wallet: creation, cancel and a refused charge, oldest first', async () => {
    await watch(OWNER)
    const sunk: string[] = []
    await poll(scriptedNode([REFUSED, STRANGER, CANCEL, SUBSCRIBE]), {
      sink: async (decoded) => {
        sunk.push(decoded.signature)
      },
    })
    expect(sunk).toEqual([sig(SUBSCRIBE), sig(CANCEL), sig(REFUSED)])
    expect(await feed()).toEqual([
      { kind: 'created', signature: sig(SUBSCRIBE) },
      { kind: 'cancelled', signature: sig(CANCEL) },
      { kind: 'rejected', signature: sig(REFUSED) },
    ])
    expect(await syncedAt(OWNER)).not.toBeNull()
  })

  it('finds the cancel only through the permission itself: it carries no authority', async () => {
    // The fact the design rests on, read from the real transaction.
    expect(keysOf(CANCEL)).not.toContain(AUTHORITY)
    expect(keysOf(CANCEL)).toContain(SUBSCRIPTION)
    expect(keysOf(REFUSED)).toContain(AUTHORITY)
    await watch(OWNER)
    const node = scriptedNode([SUBSCRIBE, CANCEL])
    await poll(node)
    expect(new Set(node.asked.map((ask) => ask.address))).toEqual(
      new Set([AUTHORITY, SUBSCRIPTION]),
    )
  })

  it('does not read the wallet itself, nor a wallet nobody is looking at', async () => {
    await watch(OWNER, Date.now() - 1_000)
    const node = scriptedNode([SUBSCRIBE, CANCEL, REFUSED])
    await poll(node)
    expect(node.asked).toEqual([])
    expect(await feed()).toEqual([])
  })

  it('leaves the program cursor alone and keeps one cursor per address', async () => {
    await watch(OWNER)
    await poll(scriptedNode([SUBSCRIBE, CANCEL, REFUSED]))
    expect(await cursorOf(CURSOR_NAME)).toBeNull()
    expect((await cursorOf(ADDRESS_CURSOR_PREFIX + AUTHORITY))?.lastSignature).toBe(sig(REFUSED))
    expect((await cursorOf(ADDRESS_CURSOR_PREFIX + SUBSCRIPTION))?.lastSignature).toBe(sig(REFUSED))
  })

  it('reads only what is new on the next round, from each address cursor', async () => {
    await watch(OWNER)
    const landed = [SUBSCRIBE]
    const node = scriptedNode(landed)
    await poll(node)
    landed.push(CANCEL)
    node.asked.length = 0
    await poll(node)
    expect(node.asked).toEqual(
      expect.arrayContaining([
        { address: AUTHORITY, until: sig(SUBSCRIBE) },
        { address: SUBSCRIPTION, until: sig(SUBSCRIBE) },
      ]),
    )
    expect((await feed()).map((row) => row.kind)).toEqual(['created', 'cancelled'])
  })

  it('reads a wallet the first time only as deep as the feed keeps', async () => {
    // 90 days and 12 hours after the subscription: it is past the cut, the
    // cancel (20 hours after it) is not.
    const now = new Date((Number(SUBSCRIBE.blockTime) + (90 * 24 + 12) * 60 * 60) * 1000)
    await watch(OWNER, now.getTime() + 60_000)
    await poll(scriptedNode([SUBSCRIBE, CANCEL, REFUSED]), { retentionDays: 90, now: () => now })
    expect((await feed()).map((row) => row.kind)).toEqual(['cancelled', 'rejected'])
  })

  it('moves no cursor and no freshness when a round fails half-way, and stores each event once after', async () => {
    await watch(OWNER)
    const node = scriptedNode([SUBSCRIBE, CANCEL, REFUSED])
    let fail = true
    const { lines } = await poll(node, {
      sink: async (decoded) => {
        if (fail && decoded.signature === sig(CANCEL)) throw new Error('database went away')
      },
    })
    expect(lines.map((line) => line.message)).toContain('wallet poll failed')
    expect(await cursorOf(ADDRESS_CURSOR_PREFIX + AUTHORITY)).toBeNull()
    expect(await syncedAt(OWNER)).toBeNull()
    fail = false
    await poll(node)
    expect((await feed()).map((row) => row.kind)).toEqual(['created', 'cancelled', 'rejected'])
    expect(await syncedAt(OWNER)).not.toBeNull()
  })

  it('backs off when the node refuses, without a pulse for that round', async () => {
    await watch(OWNER)
    const node = scriptedNode([SUBSCRIBE])
    node.refuseNext(1)
    const { rounds, lines } = await poll(node, { rounds: 2 })
    expect(lines.map((line) => line.message)).toContain('node refused the poll — backing off')
    expect(rounds).toBe(1)
    expect((await feed()).map((row) => row.kind)).toEqual(['created'])
  })
})

describe('watched wallet freshness notice (migration 0008)', () => {
  it('announces a first sync and one after a gap, not every round', async () => {
    const heard: string[] = []
    const unlisten = await client.listen(STREAM_CHANNEL, (payload) => heard.push(payload))
    try {
      await watch(OWNER)
      const book = createWalletBook(db)
      const start = Date.parse('2026-10-06T12:00:00.000Z')
      await book.synced(OWNER, new Date(start))
      await book.synced(OWNER, new Date(start + 15_000))
      await book.synced(OWNER, new Date(start + 75_000))
      // A stream ping refreshes the deadline only: no notice.
      await watch(OWNER, Date.now() + 120_000)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(heard.map((payload) => JSON.parse(payload))).toEqual([
        { kind: 'wallet', owner: OWNER },
        { kind: 'wallet', owner: OWNER },
      ])
    } finally {
      await unlisten()
    }
  })

  it('never moves freshness back', async () => {
    await watch(OWNER)
    const book = createWalletBook(db)
    await book.synced(OWNER, new Date('2026-10-06T12:01:00.000Z'))
    await book.synced(OWNER, new Date('2026-10-06T12:00:00.000Z'))
    expect(Date.parse((await syncedAt(OWNER)) ?? '')).toBe(Date.parse('2026-10-06T12:01:00.000Z'))
  })
})
