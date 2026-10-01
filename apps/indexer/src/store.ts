import type { AllowanceReadOne } from '@cancelchain/chain'
import { findSubscriptionAuthority } from '@cancelchain/chain'
import {
  allowances,
  events,
  indexerCursor,
  type NewAllowance,
  type NewEvent,
} from '@cancelchain/db'
import { type Allowance, toU64 } from '@cancelchain/shared'
import { type Address, address as toAddress } from '@solana/kit'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import type { DecodedTransaction, IndexedEvent } from './decode.js'
import { jsonSafe, type SignatureInfo } from './subscribe.js'

/**
 * Writes what the decoder found into the cache (`T039`): permission rows, feed
 * rows and the cursor, one database transaction per chain transaction.
 *
 * Deduplication is the database's job, not this module's: the indexer and its
 * catch-up see the same transaction twice by construction, and a restart
 * replays from the cursor. A second write of the same transaction changes
 * nothing — `events_signature_position_allowance_key` turns it into a no-op.
 */

/** Any drizzle Postgres handle: postgres-js in production, PGlite in tests. */
export type StoreDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>

/** The indexer has one stream; the table allows more, should a second one ever exist. */
export const CURSOR_NAME = 'program-logs'

/** Log lines kept per row. A refusal keeps more — the reason sits at the end of the log. */
export const RAW_LOG_LINES = { success: 20, refusal: 200 } as const

export type StoreOptions = {
  db: StoreDb
  /** Current chain state of one permission (`readAllowance` in production). */
  readAllowance: (pda: Address) => Promise<AllowanceReadOne>
  log: StoreLog
  now?: () => Date
}

type StoreLog = {
  info(object: object, message: string): void
  warn(object: object, message: string): void
}

export type WriteResult = {
  /** Feed rows that did not exist before this write. */
  inserted: number
  /** Feed rows the database already had: a replay, not an error. */
  duplicates: number
  /**
   * Permissions we hold no row for and could not create one: closed before the
   * indexer first saw them, or unreadable. Their events are not written — a
   * feed row without its permission would point at nothing.
   */
  untracked: string[]
}

export type Store = {
  write(decoded: DecodedTransaction): Promise<WriteResult>
  cursor(): Promise<SignatureInfo | null>
}

type ChainState =
  | { state: 'open'; slot: number; allowance: Allowance }
  | { state: 'closed'; slot: number }
  | { state: 'unreadable'; reason: string }

/** Pre-row: a feed row before we know whether its permission is tracked. */
type PendingEvent = Omit<NewEvent, 'id'>

export function createStore(options: StoreOptions): Store {
  const { db, log } = options
  const now = options.now ?? (() => new Date())

  async function chainStates(pdas: readonly string[]): Promise<Map<string, ChainState>> {
    const states = new Map<string, ChainState>()
    // Sequential on purpose: ~46 transactions a day, and the RPC budget is shared with the API.
    for (const pda of pdas) {
      const read = await options.readAllowance(toAddress(pda))
      if (read.unreadable !== null) {
        states.set(pda, { state: 'unreadable', reason: read.unreadable.reason })
      } else if (read.allowance === null) {
        states.set(pda, { state: 'closed', slot: read.slot })
      } else {
        states.set(pda, { state: 'open', slot: read.slot, allowance: read.allowance })
      }
    }
    return states
  }

  async function write(decoded: DecodedTransaction): Promise<WriteResult> {
    const blockTime = blockTimeOf(decoded, now)
    if (blockTime.estimated) {
      log.warn({ signature: decoded.signature }, 'block time unknown, using the time of indexing')
    }
    const base = {
      signature: decoded.signature,
      slot: Number(decoded.slot),
      blockTime: blockTime.iso,
    }
    const logs = {
      ...trimLogs(decoded),
      ...(blockTime.estimated ? { blockTimeEstimated: true } : {}),
    }

    // Permissions each event names directly. Plan and wallet events are expanded
    // against what we already track, inside the transaction below.
    const direct = decoded.events.flatMap((event) => ('allowance' in event ? [event] : []))
    const touched = [...new Set(direct.map((event) => event.allowance as string))]
    const planEvents = decoded.events.flatMap((event) =>
      event.kind === 'plan-updated' ? [event] : [],
    )
    const authorityEvents = decoded.events.flatMap((event) =>
      event.kind === 'authority-closed' ? [event] : [],
    )

    // Subscriptions on an updated plan: the plan's terms changed for all of
    // them at once, and the cache holds those terms per permission.
    const onUpdatedPlans =
      planEvents.length === 0
        ? []
        : (
            await db
              .select({ pda: allowances.pda })
              .from(allowances)
              .where(
                and(
                  inArray(
                    allowances.planPda,
                    planEvents.map((event) => event.plan),
                  ),
                  ne(allowances.status, 'revoked'),
                ),
              )
          ).map((row) => row.pda)

    // Chain reads happen before the database transaction: holding a pooled
    // connection across RPC round-trips starves the other service.
    const states = await chainStates([...new Set([...touched, ...onUpdatedPlans])])

    return db.transaction(async (tx) => {
      for (const [pda, state] of states) {
        if (state.state === 'open') await upsertAllowance(tx, state.allowance, state.slot)
        if (state.state === 'closed') await markClosed(tx, pda, state.slot, now())
      }

      const pending: PendingEvent[] = direct.map((event) => ({
        ...base,
        ...rowFor(event),
        raw: { ...logs, ...detailOf(event) },
      }))
      for (const event of authorityEvents) {
        for (const pda of await permissionsUnder(tx, event.owner, event.authority)) {
          pending.push({
            ...base,
            allowancePda: pda,
            position: event.position,
            kind: 'revoked',
            amount: null,
            reason: null,
            chargesStopAt: null,
            raw: { ...logs, cause: 'authority-closed', authority: event.authority },
          })
        }
      }

      const wanted = [...new Set(pending.map((row) => row.allowancePda))]
      const tracked = new Set(
        wanted.length === 0
          ? []
          : (
              await tx
                .select({ pda: allowances.pda })
                .from(allowances)
                .where(inArray(allowances.pda, wanted))
            ).map((row) => row.pda),
      )
      const rows = pending.filter((row) => tracked.has(row.allowancePda))
      const untracked = wanted.filter((pda) => !tracked.has(pda))

      const inserted =
        rows.length === 0
          ? 0
          : (
              await tx
                .insert(events)
                .values(rows)
                .onConflictDoNothing({
                  target: [events.signature, events.position, events.allowancePda],
                })
                .returning({ id: events.id })
            ).length

      await tx
        .insert(indexerCursor)
        .values({
          name: CURSOR_NAME,
          lastSignature: decoded.signature,
          lastSlot: base.slot,
          updatedAt: now().toISOString(),
        })
        .onConflictDoUpdate({
          target: indexerCursor.name,
          set: {
            lastSignature: decoded.signature,
            lastSlot: base.slot,
            updatedAt: now().toISOString(),
          },
          // Catch-up replays older transactions after newer ones were stored;
          // the cursor never moves back.
          setWhere: sql`${indexerCursor.lastSlot} <= ${base.slot}`,
        })

      if (untracked.length > 0) {
        log.warn(
          {
            signature: decoded.signature,
            untracked,
            reasons: untracked.map((pda) => {
              const state = states.get(pda)
              return state?.state === 'unreadable' ? state.reason : (state?.state ?? 'unknown')
            }),
          },
          'events for permissions we hold no row for were not stored',
        )
      }
      return { inserted, duplicates: rows.length - inserted, untracked }
    })
  }

  async function cursor(): Promise<SignatureInfo | null> {
    const rows = await db
      .select({ signature: indexerCursor.lastSignature, slot: indexerCursor.lastSlot })
      .from(indexerCursor)
      .where(eq(indexerCursor.name, CURSOR_NAME))
      .limit(1)
    const row = rows[0]
    return row === undefined ? null : { signature: row.signature, slot: BigInt(row.slot) }
  }

  return { write, cursor }
}

type Tx = Parameters<Parameters<StoreDb['transaction']>[0]>[0]

/**
 * The cache row follows the chain, except for the pause label: the chain keeps
 * no pause (`PLAN.md`: `paused_at` is off-chain only), so an `active` read
 * leaves a set label — and its `paused` status — in place. Any other status
 * clears it. An older read never overwrites a newer one.
 */
async function upsertAllowance(tx: Tx, allowance: Allowance, slot: number): Promise<void> {
  const row: NewAllowance = {
    pda: allowance.pda,
    owner: allowance.owner,
    delegate: allowance.delegate,
    mint: allowance.mint,
    kind: allowance.kind,
    capAmount: toU64(allowance.capAmount),
    periodSeconds: allowance.periodSeconds,
    spentInPeriod: toU64(allowance.spentInPeriod),
    periodStartedAt: allowance.periodStartedAt,
    expiresAt: allowance.expiresAt,
    pausedAt: null,
    endsAt: allowance.endsAt,
    status: allowance.status,
    planPda: allowance.planPda,
    lastSlot: slot,
    syncedAt: allowance.syncedAt,
  }
  const { pda: _pda, pausedAt: _pausedAt, status: _status, ...network } = row
  await tx
    .insert(allowances)
    .values(row)
    .onConflictDoUpdate({
      target: allowances.pda,
      set: {
        ...network,
        status: sql`case when ${allowances.pausedAt} is not null and excluded.status = 'active' then 'paused' else excluded.status end`,
        pausedAt: sql`case when excluded.status = 'active' then ${allowances.pausedAt} else null end`,
      },
      setWhere: sql`${allowances.lastSlot} <= excluded.last_slot`,
    })
}

/** A closed account is a revoked permission (`FR-022`); there is nothing left to cache but that. */
async function markClosed(tx: Tx, pda: string, slot: number, at: Date): Promise<void> {
  await tx
    .update(allowances)
    .set({ status: 'revoked', pausedAt: null, lastSlot: slot, syncedAt: at.toISOString() })
    .where(and(eq(allowances.pda, pda), sql`${allowances.lastSlot} <= ${slot}`))
}

/**
 * Permissions a closed subscription authority took down with it: the wallet's
 * live rows whose mint derives to that authority. The accounts themselves are
 * not touched on chain — their `init_id` simply no longer matches.
 */
async function permissionsUnder(tx: Tx, owner: Address, authority: Address): Promise<string[]> {
  const rows = await tx
    .select({ pda: allowances.pda, mint: allowances.mint })
    .from(allowances)
    .where(and(eq(allowances.owner, owner), ne(allowances.status, 'revoked')))
  const matching: string[] = []
  const byMint = new Map<string, boolean>()
  for (const row of rows) {
    let under = byMint.get(row.mint)
    if (under === undefined) {
      const derived = await findSubscriptionAuthority({
        user: owner,
        tokenMint: toAddress(row.mint),
      })
      under = derived.address === authority
      byMint.set(row.mint, under)
    }
    if (under) matching.push(row.pda)
  }
  return matching
}

type DirectEvent = Extract<IndexedEvent, { allowance: Address }>

function rowFor(
  event: DirectEvent,
): Pick<
  PendingEvent,
  'allowancePda' | 'position' | 'kind' | 'amount' | 'reason' | 'chargesStopAt'
> {
  const common = {
    allowancePda: event.allowance,
    position: event.position,
    reason: null,
    chargesStopAt: null,
  }
  switch (event.kind) {
    case 'created':
      return { ...common, kind: 'created', amount: null }
    case 'charged':
      return { ...common, kind: 'charged', amount: event.amount }
    case 'rejected':
      // `reason` stays null until `T040` maps `(raisedBy, code)`; both are in `raw`.
      return { ...common, kind: 'rejected', amount: event.attempted }
    case 'cancelled':
      return {
        ...common,
        kind: 'cancelled',
        amount: null,
        chargesStopAt: new Date(Number(event.chargesStopAt) * 1000).toISOString(),
      }
    case 'resumed':
      return { ...common, kind: 'resumed', amount: null }
    case 'revoked':
      return { ...common, kind: 'revoked', amount: null }
  }
}

/** What the row's columns do not hold but a later task needs (`T040` reads the failure). */
function detailOf(event: DirectEvent): Record<string, unknown> {
  switch (event.kind) {
    case 'created':
      return { allowanceKind: event.allowanceKind }
    case 'charged':
      return { receiver: event.receiver }
    case 'rejected':
      return jsonSafe({ failure: event.failure, raisedBy: event.raisedBy }) as Record<
        string,
        unknown
      >
    default:
      return {}
  }
}

/**
 * The log, cut to what fits free tier: the head of a success (what ran), the
 * tail of a refusal (where the `… failed:` line is). `logCount` keeps the cut
 * visible.
 */
export function trimLogs(decoded: Pick<DecodedTransaction, 'logs' | 'failed'>): {
  logs: string[]
  logCount: number
} {
  const all = decoded.logs
  const logs = decoded.failed
    ? all.slice(-RAW_LOG_LINES.refusal)
    : all.slice(0, RAW_LOG_LINES.success)
  return { logs, logCount: all.length }
}

function blockTimeOf(
  decoded: Pick<DecodedTransaction, 'blockTime'>,
  now: () => Date,
): { iso: string; estimated: boolean } {
  if (decoded.blockTime === null) return { iso: now().toISOString(), estimated: true }
  return { iso: new Date(Number(decoded.blockTime) * 1000).toISOString(), estimated: false }
}
