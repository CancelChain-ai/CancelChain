import {
  allowances,
  events,
  type PushKind,
  pushDeliveries,
  pushSubscriptions,
} from '@cancelchain/db'
import {
  type PushMessage,
  type PushSender,
  type PushTarget,
  rejectedMessage,
  type SendOptions,
  upcomingMessage,
} from '@cancelchain/push'
import { and, eq, gt, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm'
import type { StoreDb } from './store.js'

/**
 * Web Push from the indexer (`T043`, `FR-018`): a charge that is due, before it
 * is due; a charge that was refused, after it was.
 *
 * **Both are scans, not reactions.** A refusal is found in `events`, not in the
 * transaction that brought it: a push that went missing while the indexer was
 * down is found on the next run, and a replay after a restart finds the row
 * already sent. A charge due has no transaction at all — the chain stores when
 * a period started and how long it is, and the moment is computed.
 *
 * **At most once per browser and occasion.** A row in `push_deliveries` is
 * claimed before the push goes out. Only a push service that could not be
 * reached gives the claim back, for the next run to try again; everything else
 * keeps it. A phone that buzzes twice for one refusal is the worse failure of
 * the two: the feed has every refusal anyway (`FR-027`).
 *
 * **The chain first** (`FR-024`). A charge-due push names an amount and a
 * moment; both are re-read from the chain into the cache before it goes, and a
 * permission that has since been cancelled, paused or moved on gets nothing.
 */

export const DAY_MS = 24 * 60 * 60 * 1000

/** How often the indexer looks for charges due (`T043`). */
export const UPCOMING_SCAN_INTERVAL_MS = 5 * 60 * 1000

/**
 * A refusal older than this is not pushed: after a long outage the backlog
 * reaches the feed, not the phone — "refused three days ago" is not news.
 */
export const REJECTED_WINDOW_MS = DAY_MS

/** Rows per scan — a bound, not a page: the next run picks up the rest. */
const SCAN_LIMIT = 200

/**
 * How far ahead of a charge the push goes. `lead` (24 h by default) for a
 * period of more than two leads; a quarter of the period for a shorter one —
 * devnet plans run in hours, and "due in 24 hours" on an hourly plan is every
 * charge, all the time.
 */
export function upcomingLeadMs(periodSeconds: number, leadMs: number): number {
  const periodMs = periodSeconds * 1000
  return periodMs <= 2 * leadMs ? periodMs / 4 : leadMs
}

/** The occasion of a charge due: this permission, this period. The next period is a new one. */
export function upcomingRef(pda: string, periodStartedAt: string): string {
  return `${pda}@${new Date(periodStartedAt).toISOString()}`
}

export type NotifyLog = {
  info(object: object, message: string): void
  warn(object: object, message: string): void
  error(object: object, message: string): void
}

export type NotifierOptions = {
  db: StoreDb
  sender: PushSender
  /** Chain → cache for these permissions; answers the ones the chain shows open (`store.refresh`). */
  refresh: (pdas: readonly string[]) => Promise<Set<string>>
  /** The settlement mint: an amount in it is written in USDC, any other as raw units. */
  usdcMint: string
  log: NotifyLog
  now?: () => Date
  /** `PUSH_UPCOMING_LEAD_HOURS`; see `upcomingLeadMs`. */
  leadMs?: number
}

export type NotifyResult = {
  sent: number
  /** Subscriptions the push service declared dead — removed. */
  gone: number
  /** Refused or unreachable; the unreachable ones are tried again next run. */
  failed: number
}

export type Notifier = {
  /**
   * One pass over both scans. Calls that arrive while a pass runs are folded
   * into one more pass after it, so a burst of transactions makes two passes,
   * not one per transaction — and never two at once, which could claim and
   * send the same occasion twice from two readers of the same rows.
   */
  run(): Promise<NotifyResult>
}

type Delivery = {
  subscriptionId: bigint
  target: PushTarget
  kind: PushKind
  ref: string
  message: PushMessage
  options: SendOptions
}

export function createNotifier(options: NotifierOptions): Notifier {
  const { db, sender, log } = options
  const now = options.now ?? (() => new Date())
  const leadMs = options.leadMs ?? DAY_MS

  async function refusals(at: Date): Promise<Delivery[]> {
    const rows = await db
      .select({
        eventId: events.id,
        amount: events.amount,
        reason: events.reason,
        blockTime: events.blockTime,
        pda: allowances.pda,
        kind: allowances.kind,
        delegate: allowances.delegate,
        planPda: allowances.planPda,
        mint: allowances.mint,
        subscriptionId: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(events)
      .innerJoin(allowances, eq(allowances.pda, events.allowancePda))
      .innerJoin(pushSubscriptions, eq(pushSubscriptions.owner, allowances.owner))
      .where(
        and(
          eq(events.kind, 'rejected'),
          gt(events.blockTime, new Date(at.getTime() - REJECTED_WINDOW_MS).toISOString()),
          // A browser hears about refusals from the moment it subscribed, not
          // the day of backlog before it.
          sql`${events.blockTime} >= ${pushSubscriptions.createdAt}`,
          notExists(
            db
              .select({ one: sql`1` })
              .from(pushDeliveries)
              .where(
                and(
                  eq(pushDeliveries.subscriptionId, pushSubscriptions.id),
                  eq(pushDeliveries.kind, 'rejected'),
                  eq(pushDeliveries.ref, sql`${events.id}::text`),
                ),
              ),
          ),
        ),
      )
      .orderBy(events.blockTime)
      .limit(SCAN_LIMIT)

    return rows.map((row) => ({
      subscriptionId: row.subscriptionId,
      target: { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
      kind: 'rejected',
      ref: row.eventId.toString(10),
      message: rejectedMessage({
        pda: row.pda,
        kind: row.kind,
        delegate: row.delegate,
        planPda: row.planPda,
        mint: row.mint,
        usdcMint: options.usdcMint,
        amount: row.amount,
        reason: row.reason,
        blockTime: new Date(row.blockTime).toISOString(),
      }),
      // Urgent, and worth a day: the person may want to act on it.
      options: { ttlSeconds: REJECTED_WINDOW_MS / 1000, urgency: 'high' },
    }))
  }

  /** Charges due within their lead, per the cache — before any chain read. */
  async function dueFromCache(at: Date, pdas?: readonly string[]) {
    const due = sql`${allowances.periodStartedAt} + make_interval(secs => ${allowances.periodSeconds})`
    const rows = await db
      .select({
        pda: allowances.pda,
        kind: allowances.kind,
        delegate: allowances.delegate,
        planPda: allowances.planPda,
        mint: allowances.mint,
        capAmount: allowances.capAmount,
        periodSeconds: allowances.periodSeconds,
        periodStartedAt: allowances.periodStartedAt,
        subscriptionId: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
      })
      .from(allowances)
      .innerJoin(pushSubscriptions, eq(pushSubscriptions.owner, allowances.owner))
      .where(
        and(
          // `nextChargeAt` of the card (`apps/web/src/lib/view.ts`): an active
          // permission with a period, not running out (`FR-028`).
          eq(allowances.status, 'active'),
          isNull(allowances.endsAt),
          isNull(allowances.pausedAt),
          isNotNull(allowances.periodSeconds),
          isNotNull(allowances.periodStartedAt),
          sql`${due} > ${at.toISOString()}`,
          sql`${due} <= ${new Date(at.getTime() + leadMs).toISOString()}`,
          pdas === undefined ? undefined : inArray(allowances.pda, [...pdas]),
        ),
      )
      .limit(SCAN_LIMIT)

    return rows.flatMap((row) => {
      if (row.periodSeconds === null || row.periodStartedAt === null) return []
      const dueAt = new Date(new Date(row.periodStartedAt).getTime() + row.periodSeconds * 1000)
      if (dueAt.getTime() - at.getTime() > upcomingLeadMs(row.periodSeconds, leadMs)) return []
      return [{ ...row, dueAt, ref: upcomingRef(row.pda, row.periodStartedAt) }]
    })
  }

  async function upcoming(at: Date): Promise<Delivery[]> {
    const cached = await dueFromCache(at)
    if (cached.length === 0) return []

    // Already sent: dropped before the chain read, so the RPC budget is spent
    // only on occasions that may still need a push.
    const sent = await db
      .select({ subscriptionId: pushDeliveries.subscriptionId, ref: pushDeliveries.ref })
      .from(pushDeliveries)
      .where(
        and(
          eq(pushDeliveries.kind, 'upcoming'),
          inArray(pushDeliveries.ref, [...new Set(cached.map((row) => row.ref))]),
        ),
      )
    const done = new Set(sent.map((row) => `${row.subscriptionId}|${row.ref}`))
    const open = cached.filter((row) => !done.has(`${row.subscriptionId}|${row.ref}`))
    if (open.length === 0) return []

    // Chain → cache, then the same question again: what is still due, and in
    // which period. A cancelled, paused or charged permission drops out here.
    const pdas = [...new Set(open.map((row) => row.pda))]
    // Only what the chain showed open: an account that is gone or is not a
    // permission any more leaves the cache as it was, and the cache is not
    // enough to tell someone a charge is coming.
    const onChain = await options.refresh(pdas)
    const confirmed = new Set(
      (await dueFromCache(at, pdas))
        .filter((row) => onChain.has(row.pda))
        .map((row) => `${row.subscriptionId}|${row.ref}`),
    )

    return open
      .filter((row) => confirmed.has(`${row.subscriptionId}|${row.ref}`))
      .map((row) => ({
        subscriptionId: row.subscriptionId,
        target: { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
        kind: 'upcoming',
        ref: row.ref,
        message: upcomingMessage({
          pda: row.pda,
          kind: row.kind,
          delegate: row.delegate,
          planPda: row.planPda,
          mint: row.mint,
          usdcMint: options.usdcMint,
          capAmount: row.capAmount,
          dueAt: row.dueAt.toISOString(),
        }),
        // Kept until the moment it is about, and no longer: after that it is old news.
        options: {
          ttlSeconds: Math.max(60, Math.floor((row.dueAt.getTime() - at.getTime()) / 1000)),
          urgency: 'normal',
        },
      }))
  }

  async function deliver(
    delivery: Delivery,
    result: NotifyResult,
    gone: Set<bigint>,
  ): Promise<void> {
    // Removed earlier in this pass: its claims would point at no row.
    if (gone.has(delivery.subscriptionId)) return
    const claim = {
      subscriptionId: delivery.subscriptionId,
      kind: delivery.kind,
      ref: delivery.ref,
    }
    const claimed = await db
      .insert(pushDeliveries)
      .values(claim)
      .onConflictDoNothing()
      .returning({ ref: pushDeliveries.ref })
    if (claimed.length === 0) return

    const outcome = await sender.send(delivery.target, delivery.message, delivery.options)
    const context = {
      kind: delivery.kind,
      ref: delivery.ref,
      subscription: String(delivery.subscriptionId),
    }
    switch (outcome.state) {
      case 'delivered':
        result.sent += 1
        return
      case 'gone':
        // The browser dropped it; the claims go with the row (`ON DELETE cascade`).
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, delivery.subscriptionId))
        gone.add(delivery.subscriptionId)
        log.info({ ...context, status: outcome.status }, 'push subscription gone, removed')
        result.gone += 1
        return
      case 'refused':
        log.error({ ...context, status: outcome.status, detail: outcome.detail }, 'push refused')
        result.failed += 1
        return
      case 'unreachable':
        await db
          .delete(pushDeliveries)
          .where(
            and(
              eq(pushDeliveries.subscriptionId, claim.subscriptionId),
              eq(pushDeliveries.kind, claim.kind),
              eq(pushDeliveries.ref, claim.ref),
            ),
          )
        log.warn(
          { ...context, status: outcome.status, detail: outcome.detail },
          'push service unreachable, will retry',
        )
        result.failed += 1
        return
    }
  }

  async function pass(): Promise<NotifyResult> {
    const at = now()
    const result: NotifyResult = { sent: 0, gone: 0, failed: 0 }
    const deliveries = [...(await refusals(at)), ...(await upcoming(at))]
    // One at a time: a handful a day, and one pooled connection for the whole indexer.
    const gone = new Set<bigint>()
    for (const delivery of deliveries) await deliver(delivery, result, gone)
    if (deliveries.length > 0) log.info({ ...result }, 'push pass')
    return result
  }

  let running: Promise<NotifyResult> | null = null
  let again = false

  return {
    run() {
      if (running !== null) {
        again = true
        return running
      }
      running = (async () => {
        try {
          const total = await pass()
          while (again) {
            again = false
            const next = await pass()
            total.sent += next.sent
            total.gone += next.gone
            total.failed += next.failed
          }
          return total
        } finally {
          running = null
        }
      })()
      return running
    },
  }
}
