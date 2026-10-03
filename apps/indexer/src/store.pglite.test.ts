import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AllowanceReadOne, ReadAllowance } from '@cancelchain/chain'
import { findSubscriptionAuthority } from '@cancelchain/chain'
import { allowances, events, indexerCursor, indexerHeartbeat } from '@cancelchain/db'
import { PGlite } from '@electric-sql/pglite'
import type { Address } from '@solana/kit'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type DecodedTransaction, decodeTransaction, type TransactionRecord } from './decode.js'
import { CURSOR_NAME, createStore, RAW_LOG_LINES, type StoreDb } from './store.js'

/**
 * The store runs against a real Postgres (PGlite, in-process) with the very
 * migrations that go to Supabase: deduplication and the date check are the
 * database's job here, and a mock would only repeat what the code believes.
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
const DELEGATION = '3cNCoQXGZY87neBEvKQZArXnZnLkwTHUrb5Bt6qyB5zF' as Address
const MERCHANT = 'FGHMNoNNq3aMvTxrfeNRzS6SwE7SKZp6UyZ7FMjjf3nk' as Address
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const OTHER_MINT = 'So11111111111111111111111111111111111111112' as Address
/** 2026-10-28T17:07:36Z — the date T037a read from the cancelled account. */
const CHARGES_STOP_AT = '2026-10-28T17:07:36.000Z'

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
    'TRUNCATE events, allowances, indexer_cursor, indexer_heartbeat RESTART IDENTITY CASCADE',
  )
})

function subscription(overrides: Partial<ReadAllowance> = {}): ReadAllowance {
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
    ...overrides,
  }
}

function recurring(overrides: Partial<ReadAllowance> = {}): ReadAllowance {
  return subscription({
    pda: DELEGATION,
    delegate: MERCHANT,
    kind: 'recurring',
    capAmount: '25000000',
    planPda: null,
    ...overrides,
  })
}

/** The chain as the store sees it: a map of what each permission reads as right now. */
function fakeChain() {
  const state = new Map<string, { slot: number; allowance: ReadAllowance | null }>()
  const unreadable = new Set<string>()
  const reads: string[] = []
  return {
    reads,
    open(allowance: ReadAllowance, slot = allowance.lastSlot) {
      state.set(allowance.pda, { slot, allowance: { ...allowance, lastSlot: slot } })
    },
    close(pda: string, slot: number) {
      state.set(pda, { slot, allowance: null })
    },
    unreadable(pda: string) {
      unreadable.add(pda)
    },
    async read(pda: Address): Promise<AllowanceReadOne> {
      reads.push(pda)
      if (unreadable.has(pda)) {
        return {
          slot: 1,
          syncedAt: '2026-10-01T00:00:00.000Z',
          allowance: null,
          unreadable: { address: pda, reason: 'version', detail: 'v9' },
        }
      }
      const entry = state.get(pda) ?? { slot: 1, allowance: null }
      return {
        slot: entry.slot,
        syncedAt: '2026-10-01T00:00:00.000Z',
        allowance: entry.allowance,
        unreadable: null,
      }
    },
  }
}

function setup() {
  const chain = fakeChain()
  const warnings: { object: object; message: string }[] = []
  const errors: { object: object; message: string }[] = []
  const store = createStore({
    db,
    readAllowance: chain.read,
    log: {
      info: () => {},
      warn: (object, message) => warnings.push({ object, message }),
      error: (object, message) => errors.push({ object, message }),
    },
    now: () => new Date('2026-10-01T12:00:00.000Z'),
  })
  return { chain, store, warnings, errors }
}

function synthetic(
  overrides: Partial<DecodedTransaction> & Pick<DecodedTransaction, 'events'>,
): DecodedTransaction {
  return {
    signature: 'syntheticSignature1111111111111111111111111111111111111111111111111',
    slot: 600_000_000n,
    blockTime: 1_790_700_000n,
    failed: false,
    problems: [],
    logs: [],
    ...overrides,
  }
}

const rowsOf = () => db.select().from(events).orderBy(events.id)

function keptLogs(row: { raw: unknown } | undefined): string[] {
  if (row === undefined) throw new Error('no row')
  return (row.raw as { logs: string[] }).logs
}

describe('store — writing what the decoder found', () => {
  it('a permission it has never seen: read from the chain, cached, then its event', async () => {
    const { chain, store } = setup()
    chain.open(subscription())
    const decoded = await decodeTransaction(fixture('subscribe'))

    expect(await store.write(decoded)).toEqual({ inserted: 1, duplicates: 0, untracked: [] })

    const [row] = await db.select().from(allowances).where(eq(allowances.pda, SUBSCRIPTION))
    // The plan is not in our catalog — the row is cached anyway (no FK to `plans`).
    expect(row).toMatchObject({ status: 'active', planPda: PLAN, capAmount: 9_990_000n })
    expect(await rowsOf()).toMatchObject([
      {
        allowancePda: SUBSCRIPTION,
        kind: 'created',
        amount: null,
        reason: null,
        chargesStopAt: null,
        signature: decoded.signature,
        slot: 505_227_603,
        raw: { allowanceKind: 'subscription', logCount: 16 },
      },
    ])
    expect(new Date((await rowsOf())[0]?.blockTime ?? '').toISOString()).toBe(
      new Date(1_790_615_256_000).toISOString(),
    )
  })

  it('a split payment keeps all three charges, and a replay of it adds none', async () => {
    const { chain, store } = setup()
    const decoded = await decodeTransaction(fixture('charge-split-three-receivers'))
    const charged = decoded.events.find((event) => event.kind === 'charged')
    if (charged?.kind !== 'charged') throw new Error('fixture has no charge')
    chain.open(subscription({ pda: charged.allowance, owner: charged.allowance }))

    expect(await store.write(decoded)).toMatchObject({ inserted: 3, duplicates: 0 })
    expect(await store.write(decoded)).toMatchObject({ inserted: 0, duplicates: 3 })
    const rows = await rowsOf()
    expect(rows.map((row) => row.kind)).toEqual(['charged', 'charged', 'charged'])
    expect(rows.map((row) => row.amount).slice(0, 2)).toEqual([7_000_000n, 2_500_000n])
  })

  it('the same transaction twice is one row — the database says so, not the code', async () => {
    const { chain, store } = setup()
    chain.open(subscription())
    const decoded = await decodeTransaction(fixture('subscribe'))

    await store.write(decoded)
    expect(await store.write(decoded)).toEqual({ inserted: 0, duplicates: 1, untracked: [] })
    expect(await rowsOf()).toHaveLength(1)

    // And without the code: a direct duplicate insert is refused by the unique index.
    const [first] = await rowsOf()
    if (first === undefined) throw new Error('no row')
    const { id: _id, ...copy } = first
    await expect(db.insert(events).values(copy)).rejects.toThrow()
  })

  it('a cancellation keeps the date charges stop, and the cache picks the end date up', async () => {
    const { chain, store } = setup()
    chain.open(subscription())
    await store.write(await decodeTransaction(fixture('subscribe')))
    chain.open(subscription({ endsAt: CHARGES_STOP_AT }), 505_548_000)

    await store.write(await decodeTransaction(fixture('cancel-subscription')))

    const cancelled = (await rowsOf()).find((row) => row.kind === 'cancelled')
    expect(new Date(cancelled?.chargesStopAt ?? '').toISOString()).toBe(CHARGES_STOP_AT)
    const [row] = await db.select().from(allowances).where(eq(allowances.pda, SUBSCRIPTION))
    expect(new Date(row?.endsAt ?? '').toISOString()).toBe(CHARGES_STOP_AT)
    expect(row?.lastSlot).toBe(505_548_000)
  })

  it('the database refuses a cancellation without its date, and a date on anything else', async () => {
    const { chain, store } = setup()
    chain.open(subscription())
    await store.write(await decodeTransaction(fixture('subscribe')))
    const base = {
      allowancePda: SUBSCRIPTION,
      signature: 'x',
      position: 0,
      slot: 1,
      blockTime: '2026-10-01T00:00:00Z',
    }
    await expect(db.insert(events).values({ ...base, kind: 'cancelled' })).rejects.toThrow()
    await expect(
      db.insert(events).values({ ...base, kind: 'resumed', chargesStopAt: CHARGES_STOP_AT }),
    ).rejects.toThrow()
  })

  it('a refusal: attempted amount, its category, and the facts behind it in raw', async () => {
    const { chain, store, errors } = setup()
    chain.open(recurring())
    const decoded = await decodeTransaction(fixture('reject-over-cap'))

    await store.write(decoded)

    expect(await rowsOf()).toMatchObject([
      {
        allowancePda: DELEGATION,
        kind: 'rejected',
        reason: 'cap_exceeded',
        raw: {
          failure: { type: 'custom', code: 400 },
          raisedBy: 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44',
          tokenAccountsExisted: { source: true, destination: true },
          logCount: 3,
        },
      },
    ])
    expect(errors).toEqual([])
    // The seeded cap minus the control charge, plus one: what decode.test.ts pins.
    expect((await rowsOf())[0]?.amount).toBe(24_000_001n)
  })

  it('cuts the log: the head of a success, the tail of a refusal, the full count kept', async () => {
    const { chain, store } = setup()
    chain.open(subscription())
    const logs = Array.from({ length: 500 }, (_, i) => `line ${i}`)
    const event = { kind: 'resumed' as const, allowance: SUBSCRIPTION }
    const common = { signature: 'a', slot: 1n, blockTime: 1n, instructionIndex: 0, position: 0 }

    await store.write(synthetic({ signature: 'ok', logs, events: [{ ...common, ...event }] }))
    const [success] = await rowsOf()
    expect(success?.raw).toMatchObject({ logCount: 500 })
    const kept = keptLogs(success)
    expect(kept).toHaveLength(RAW_LOG_LINES.success)
    expect(kept[0]).toBe('line 0')

    await store.write(
      synthetic({
        signature: 'refused',
        failed: true,
        logs,
        events: [
          {
            ...common,
            kind: 'rejected',
            allowance: SUBSCRIPTION,
            allowanceKind: 'subscription',
            attempted: 1n,
            failure: { type: 'custom', code: 400 },
            raisedBy: null,
            tokenAccountsExisted: null,
            authority: { existed: null, isSubscribers: null },
          },
        ],
      }),
    )
    const refused = (await rowsOf()).find((row) => row.kind === 'rejected')
    const tail = keptLogs(refused)
    expect(tail).toHaveLength(RAW_LOG_LINES.refusal)
    expect(tail.at(-1)).toBe('line 499')
  })

  it('a permission closed before we ever saw it: no row to hang the event on, said out loud', async () => {
    const { chain, store, warnings } = setup()
    chain.close(DELEGATION, 492_152_600)
    const decoded = await decodeTransaction(fixture('charge-recurring'))

    expect(await store.write(decoded)).toEqual({
      inserted: 0,
      duplicates: 0,
      untracked: [DELEGATION],
    })
    expect(await rowsOf()).toEqual([])
    expect(await db.select().from(allowances)).toEqual([])
    expect(warnings).toMatchObject([{ object: { untracked: [DELEGATION], reasons: ['closed'] } }])
    // The transaction is still behind us: the cursor moves.
    expect(await store.cursor()).toEqual({ signature: decoded.signature, slot: 492_152_566n })
  })

  it('an unreadable permission we do not track is skipped the same way, with its reason', async () => {
    const { chain, store, warnings } = setup()
    chain.unreadable(DELEGATION)
    await store.write(await decodeTransaction(fixture('charge-recurring')))
    expect(await rowsOf()).toEqual([])
    expect(warnings).toMatchObject([{ object: { reasons: ['version'] } }])
  })

  it('a revocation of a tracked permission: the row turns revoked, the event is written', async () => {
    const { chain, store } = setup()
    chain.open(recurring())
    await store.write(await decodeTransaction(fixture('charge-recurring')))
    chain.close(DELEGATION, 600_000_100)
    const common = {
      signature: 'r',
      slot: 600_000_000n,
      blockTime: 1n,
      instructionIndex: 0,
      position: 0,
    }

    await store.write(
      synthetic({ events: [{ ...common, kind: 'revoked', allowance: DELEGATION }] }),
    )

    const [row] = await db.select().from(allowances).where(eq(allowances.pda, DELEGATION))
    expect(row?.status).toBe('revoked')
    expect((await rowsOf()).map((event) => event.kind)).toEqual(['charged', 'revoked'])
  })
})

describe('store — the cache row', () => {
  const common = { signature: 's', slot: 1n, blockTime: 1n, instructionIndex: 0, position: 0 }
  const resumed = { ...common, kind: 'resumed' as const, allowance: SUBSCRIPTION }

  it('keeps our pause label over an active read, drops it once the chain says otherwise', async () => {
    const { chain, store } = setup()
    chain.open(subscription())
    await store.write(synthetic({ signature: 'one', events: [resumed] }))
    await db
      .update(allowances)
      .set({ status: 'paused', pausedAt: '2026-09-30T00:00:00Z' })
      .where(eq(allowances.pda, SUBSCRIPTION))

    chain.open(subscription(), 505_300_000)
    await store.write(synthetic({ signature: 'two', events: [resumed] }))
    const [paused] = await db.select().from(allowances).where(eq(allowances.pda, SUBSCRIPTION))
    expect(paused).toMatchObject({ status: 'paused', lastSlot: 505_300_000 })
    expect(paused?.pausedAt).not.toBeNull()

    chain.open(subscription({ status: 'exhausted' }), 505_400_000)
    await store.write(synthetic({ signature: 'three', events: [resumed] }))
    const [after] = await db.select().from(allowances).where(eq(allowances.pda, SUBSCRIPTION))
    expect(after).toMatchObject({ status: 'exhausted', pausedAt: null })
  })

  it('an older read never overwrites a newer row', async () => {
    const { chain, store } = setup()
    chain.open(subscription({ spentInPeriod: '5000000' }), 505_500_000)
    await store.write(synthetic({ signature: 'new', events: [resumed] }))
    chain.open(subscription({ spentInPeriod: '0' }), 505_400_000)
    await store.write(synthetic({ signature: 'old', events: [resumed] }))

    const [row] = await db.select().from(allowances).where(eq(allowances.pda, SUBSCRIPTION))
    expect(row).toMatchObject({ spentInPeriod: 5_000_000n, lastSlot: 505_500_000 })
  })
})

describe('store — events that name no permission', () => {
  it('authority closed: a revoked row for each live permission of that wallet in that mint', async () => {
    const { chain, store } = setup()
    const sub = subscription()
    const rec = recurring()
    const otherMint = recurring({ pda: MERCHANT, mint: OTHER_MINT })
    const gone = recurring({ pda: PLAN })
    for (const allowance of [sub, rec, otherMint, gone]) chain.open(allowance)
    const common = { slot: 1n, blockTime: 1n, instructionIndex: 0, position: 0 }
    await store.write(
      synthetic({
        signature: 'seed',
        events: [sub, rec, otherMint, gone].map((allowance) => ({
          ...common,
          signature: 'seed',
          kind: 'resumed' as const,
          allowance: allowance.pda as Address,
        })),
      }),
    )
    await db.update(allowances).set({ status: 'revoked' }).where(eq(allowances.pda, PLAN))
    const authority = (await findSubscriptionAuthority({ user: OWNER, tokenMint: USDC })).address
    // With `T040a` the chain read of a permission under a closed authority says `revoked`.
    for (const allowance of [sub, rec]) {
      chain.open({ ...allowance, status: 'revoked' }, allowance.lastSlot + 10)
    }
    const readsBefore = chain.reads.length

    const result = await store.write(
      synthetic({
        signature: 'closed',
        events: [
          { ...common, signature: 'closed', kind: 'authority-closed', owner: OWNER, authority },
        ],
      }),
    )

    expect(result.inserted).toBe(2)
    const revoked = (await rowsOf()).filter((row) => row.signature === 'closed')
    expect(revoked.map((row) => row.allowancePda).sort()).toEqual([DELEGATION, SUBSCRIPTION].sort())
    for (const row of revoked) {
      expect(row).toMatchObject({ kind: 'revoked', raw: { cause: 'authority-closed', authority } })
    }
    // The accounts are untouched on chain, but their authority is gone: each is
    // read again, and the cache stops calling them active (`T040a`).
    expect(chain.reads.slice(readsBefore).sort()).toEqual([DELEGATION, SUBSCRIPTION].sort())
    const cached = await db.select().from(allowances).orderBy(allowances.pda)
    expect(Object.fromEntries(cached.map((row) => [row.pda, row.status]))).toMatchObject({
      [DELEGATION]: 'revoked',
      [SUBSCRIPTION]: 'revoked',
    })
    expect(cached.find((row) => row.pda === otherMint.pda)?.status).toBe('active')
  })

  it('plan updated: its tracked subscriptions are re-read, no feed row is written', async () => {
    const { chain, store } = setup()
    chain.open(subscription())
    await store.write(await decodeTransaction(fixture('subscribe')))
    chain.open(subscription({ capAmount: '12000000' }), 505_600_000)

    const result = await store.write(
      synthetic({
        events: [
          {
            signature: 'p',
            slot: 1n,
            blockTime: 1n,
            instructionIndex: 0,
            position: 0,
            kind: 'plan-updated',
            plan: PLAN,
            status: 1,
            endTs: 0n,
            pullers: [],
          },
        ],
      }),
    )

    expect(result).toEqual({ inserted: 0, duplicates: 0, untracked: [] })
    const [row] = await db.select().from(allowances).where(eq(allowances.pda, SUBSCRIPTION))
    expect(row).toMatchObject({ capAmount: 12_000_000n, lastSlot: 505_600_000 })
    expect(await rowsOf()).toHaveLength(1)
  })
})

describe('store — cursor', () => {
  it('is empty before the first write', async () => {
    expect(await setup().store.cursor()).toBeNull()
  })

  it('moves with every transaction, events or not, and never back', async () => {
    const { store } = setup()
    await store.write(synthetic({ signature: 'newer', slot: 700n, events: [] }))
    await store.write(synthetic({ signature: 'older', slot: 600n, events: [] }))
    expect(await store.cursor()).toEqual({ signature: 'newer', slot: 700n })

    const [row] = await db.select().from(indexerCursor)
    expect(row?.name).toBe(CURSOR_NAME)
    expect(new Date(row?.updatedAt ?? '').toISOString()).toBe('2026-10-01T12:00:00.000Z')
  })

  it('a transaction without a block time is stored at the time of indexing, and marked', async () => {
    const { chain, store, warnings } = setup()
    chain.open(subscription())
    const common = { signature: 'n', slot: 1n, blockTime: null, instructionIndex: 0, position: 0 }
    await store.write(
      synthetic({
        blockTime: null,
        events: [{ ...common, kind: 'resumed', allowance: SUBSCRIPTION }],
      }),
    )
    const [row] = await rowsOf()
    expect(new Date(row?.blockTime ?? '').toISOString()).toBe('2026-10-01T12:00:00.000Z')
    expect(row?.raw).toMatchObject({ blockTimeEstimated: true })
    expect(warnings).toHaveLength(1)
  })
})

describe('store — refusal categories (T040)', () => {
  const PROGRAM = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44' as Address

  function refusal(
    signature: string,
    failure: { type: 'custom'; code: number },
    tokenAccountsExisted: { source: boolean; destination: boolean } | null = null,
  ): DecodedTransaction {
    return synthetic({
      signature,
      failed: true,
      events: [
        {
          signature,
          slot: 600_000_000n,
          blockTime: 1_790_700_000n,
          instructionIndex: 0,
          position: 0,
          kind: 'rejected',
          allowance: SUBSCRIPTION,
          allowanceKind: 'subscription',
          attempted: 1n,
          failure,
          raisedBy: PROGRAM,
          tokenAccountsExisted,
          authority: { existed: true, isSubscribers: true },
        },
      ],
    })
  }

  const reasons = async () => (await rowsOf()).map((row) => [row.signature, row.reason])

  it('a merchant with no account to receive into: named, not left unknown', async () => {
    // Our own doomed attempt on devnet, 2026-09-30: the subscriber's account
    // existed, the merchant's did not, and the program answered `110`.
    const { chain, store, errors } = setup()
    chain.open(subscription())

    await store.write(await decodeTransaction(fixture('reject-merchant-no-token-account')))

    expect(await rowsOf()).toMatchObject([
      { kind: 'rejected', reason: 'merchant_account_missing', amount: 10_000_000n },
    ])
    expect(errors).toEqual([])
  })

  it('a code nobody mapped: reason null and a mapping error in the log, no catch-all', async () => {
    const { chain, store, errors } = setup()
    chain.open(subscription())

    await store.write(refusal('unknown', { type: 'custom', code: 999 }))

    expect(await reasons()).toEqual([['unknown', null]])
    expect(errors).toMatchObject([
      {
        message: 'reject reason mapping failed',
        object: {
          signature: 'unknown',
          allowance: SUBSCRIPTION,
          unmapped: `custom 999 from ${PROGRAM}`,
        },
      },
    ])
  })

  it('`508` reads as a pause where our label is, and as a cancellation elsewhere', async () => {
    const { chain, store } = setup()
    chain.open(subscription())
    await store.write(refusal('cancelled', { type: 'custom', code: 508 }))
    await db
      .update(allowances)
      .set({ pausedAt: '2026-10-01T10:00:00.000Z', status: 'paused' })
      .where(eq(allowances.pda, SUBSCRIPTION))

    await store.write(refusal('paused', { type: 'custom', code: 508 }))

    expect(await reasons()).toEqual([
      ['cancelled', 'revoked'],
      ['paused', 'paused'],
    ])
  })

  it('backfill: rows stored without a category get one; what is still unknown stays null', async () => {
    const { chain, store, errors } = setup()
    chain.open(subscription())
    await store.write(refusal('over-cap', { type: 'custom', code: 400 }))
    await store.write(
      refusal(
        'no-merchant-account',
        { type: 'custom', code: 110 },
        { source: true, destination: false },
      ),
    )
    await store.write(refusal('unknown', { type: 'custom', code: 999 }))
    // Rows as T039 wrote them: no category, and no token-account record on the `110`.
    await client.exec(`UPDATE events SET reason = NULL`)
    await store.write(refusal('pre-t040-110', { type: 'custom', code: 110 }))
    await client.exec(
      `UPDATE events SET raw = raw - 'tokenAccountsExisted' WHERE signature = 'pre-t040-110'`,
    )
    errors.length = 0

    expect(await store.backfillReasons()).toEqual({ filled: 2, unmapped: 2 })
    expect(await reasons()).toEqual([
      ['over-cap', 'cap_exceeded'],
      ['no-merchant-account', 'merchant_account_missing'],
      ['unknown', null],
      ['pre-t040-110', null],
    ])
    expect(errors.map((entry) => (entry.object as { signature: string }).signature)).toEqual([
      'unknown',
      'pre-t040-110',
    ])

    // Idempotent: a second start touches nothing it already filled.
    expect(await store.backfillReasons()).toEqual({ filled: 0, unmapped: 2 })
  })

  it('backfill: a row whose raw does not hold the facts is reported, not guessed', async () => {
    const { chain, store, errors } = setup()
    chain.open(subscription())
    await store.write(refusal('over-cap', { type: 'custom', code: 400 }))
    await client.exec(`UPDATE events SET reason = NULL, raw = '{"logs": []}'::jsonb`)

    expect(await store.backfillReasons()).toEqual({ filled: 0, unmapped: 1 })
    expect(errors).toMatchObject([{ message: 'reject reason mapping failed' }])
  })

  it('backfill leaves charges and categorised refusals alone', async () => {
    const { chain, store } = setup()
    chain.open(recurring())
    await store.write(await decodeTransaction(fixture('charge-recurring')))
    await store.write(await decodeTransaction(fixture('reject-over-cap')))

    expect(await store.backfillReasons()).toEqual({ filled: 0, unmapped: 0 })
    expect((await rowsOf()).map((row) => [row.kind, row.reason])).toEqual([
      ['charged', null],
      ['rejected', 'cap_exceeded'],
    ])
  })
})

describe('store — heartbeat (T041)', () => {
  it('one row, moved forward by every beat — whether or not the program had transactions', async () => {
    let at = new Date('2026-10-03T12:00:00.000Z')
    const store = createStore({
      db,
      readAllowance: fakeChain().read,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => at,
    })

    await store.heartbeat()
    at = new Date('2026-10-03T12:00:15.000Z')
    await store.heartbeat()

    const rows = await db.select().from(indexerHeartbeat)
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0]?.aliveAt ?? '').toISOString()).toBe('2026-10-03T12:00:15.000Z')
    // The cursor is not the pulse: no transaction, no cursor.
    expect(await store.cursor()).toBeNull()
  })
})
