import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  allowances,
  events,
  type NewAllowance,
  type NewEvent,
  pushDeliveries,
  pushSubscriptions,
} from '@cancelchain/db'
import type {
  PushMessage,
  PushSender,
  PushTarget,
  SendOptions,
  SendOutcome,
} from '@cancelchain/push'
import { PGlite } from '@electric-sql/pglite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createNotifier,
  DAY_MS,
  type NotifierOptions,
  upcomingLeadMs,
  upcomingRef,
} from './notify.js'
import type { StoreDb } from './store.js'

/**
 * The notifier against a real Postgres (PGlite) with the very migrations that
 * go to Supabase: which push goes where, and only once, is decided by queries
 * and a primary key here, and a fake database would only repeat the belief.
 */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@cancelchain/db')))
const migrations = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) =>
    readFileSync(migrationDir + name, 'utf8').replaceAll('--> statement-breakpoint', ''),
  )

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const STRANGER = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq'
const PDA = 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2'
const OTHER_PDA = '3cNCoQXGZY87neBEvKQZArXnZnLkwTHUrb5Bt6qyB5zF'
const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const MERCHANT = 'FGHMNoNNq3aMvTxrfeNRzS6SwE7SKZp6UyZ7FMjjf3nk'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const SIGNATURE =
  '2Z8w3XkjqwnhyLxJxYBESora4nKthwMoMJk1MzJ9NSq9spb6t4LWfwUxUw95mdma771522pU45EStDh5LLnv67Mj'
const PHONE = 'https://fcm.googleapis.com/fcm/send/phone'
const LAPTOP = 'https://updates.push.services.mozilla.com/wpush/v2/laptop'

const NOW = new Date('2026-10-06T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const MONTH_SECONDS = 30 * 24 * 60 * 60

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString()

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
    'delete from push_deliveries; delete from push_subscriptions; delete from events; delete from allowances;',
  )
})

/** A subscription whose period opens again in `dueInMs`. */
function permission(dueInMs: number, overrides: Partial<NewAllowance> = {}): NewAllowance {
  const periodSeconds = overrides.periodSeconds ?? MONTH_SECONDS
  return {
    pda: PDA,
    owner: OWNER,
    delegate: MERCHANT,
    mint: USDC,
    kind: 'subscription',
    capAmount: 10_000_000n,
    periodSeconds,
    spentInPeriod: 10_000_000n,
    periodStartedAt: at(dueInMs - (periodSeconds ?? 0) * 1000),
    expiresAt: null,
    pausedAt: null,
    endsAt: null,
    status: 'active',
    planPda: PLAN,
    lastSlot: 1,
    syncedAt: NOW.toISOString(),
    ...overrides,
  }
}

function refusal(agoMs: number, overrides: Partial<NewEvent> = {}): NewEvent {
  return {
    allowancePda: PDA,
    kind: 'rejected',
    amount: 10_000_000n,
    reason: 'revoked',
    signature: SIGNATURE,
    position: Math.floor(agoMs / 1000),
    slot: 1,
    blockTime: at(-agoMs),
    raw: null,
    chargesStopAt: null,
    ...overrides,
  }
}

async function subscribe(endpoint: string, owner = OWNER, createdAt = at(-7 * DAY_MS)) {
  const [row] = await db
    .insert(pushSubscriptions)
    .values({ owner, endpoint, p256dh: 'BKey', auth: 'auth', createdAt })
    .returning({ id: pushSubscriptions.id })
  if (row === undefined) throw new Error('no subscription row')
  return row.id
}

type Sent = { target: PushTarget; message: PushMessage; options: SendOptions }

/** A push service that answers `outcome` (per endpoint, if a function) and remembers. */
function service(outcome: SendOutcome | ((target: PushTarget) => SendOutcome) = delivered) {
  const sent: Sent[] = []
  const sender: PushSender = {
    send: async (target, message, options) => {
      sent.push({ target, message, options })
      return typeof outcome === 'function' ? outcome(target) : outcome
    },
  }
  return { sender, sent }
}

const delivered: SendOutcome = { state: 'delivered', status: 201 }
const silent = { info: () => {}, warn: () => {}, error: () => {} }

function notifier(
  sender: PushSender,
  overrides: Partial<NotifierOptions> = {},
): { run: () => ReturnType<ReturnType<typeof createNotifier>['run']>; refreshed: string[][] } {
  const refreshed: string[][] = []
  const notifier = createNotifier({
    db,
    sender,
    refresh: async (pdas) => {
      refreshed.push([...pdas])
      return new Set(pdas)
    },
    usdcMint: USDC,
    log: silent,
    now: () => NOW,
    ...overrides,
  })
  return { run: () => notifier.run(), refreshed }
}

describe('upcomingLeadMs', () => {
  it('is the lead for a long period and a quarter of a short one', () => {
    expect(upcomingLeadMs(MONTH_SECONDS, DAY_MS)).toBe(DAY_MS)
    expect(upcomingLeadMs(2 * 24 * 3600 + 1, DAY_MS)).toBe(DAY_MS)
    expect(upcomingLeadMs(2 * 24 * 3600, DAY_MS)).toBe(12 * HOUR)
    expect(upcomingLeadMs(3600, DAY_MS)).toBe(15 * 60 * 1000)
  })
})

describe('refused charges', () => {
  it('reach every browser of the wallet, once', async () => {
    await db.insert(allowances).values(permission(10 * DAY_MS))
    await db.insert(events).values(refusal(5 * 60 * 1000))
    await subscribe(PHONE)
    await subscribe(LAPTOP)
    await subscribe('https://fcm.googleapis.com/fcm/send/stranger', STRANGER)
    const { sender, sent } = service()

    expect(await notifier(sender).run()).toEqual({ sent: 2, gone: 0, failed: 0 })
    expect(sent.map((push) => push.target.endpoint).sort()).toEqual([LAPTOP, PHONE].sort())
    const push = sent[0]
    expect(push?.message).toMatchObject({
      kind: 'rejected',
      title: 'Charge refused',
      allowance: PDA,
      at: at(-5 * 60 * 1000),
    })
    expect(push?.message.body).toContain('tried 10.00 USDC')
    expect(push?.message.body).toContain('Permission cancelled')
    expect(push?.options).toEqual({ ttlSeconds: 86_400, urgency: 'high' })

    // A replay after a restart, or the next scan: nothing new to say.
    expect(await notifier(sender).run()).toEqual({ sent: 0, gone: 0, failed: 0 })
    expect(sent).toHaveLength(2)
  })

  it('are news only for a day — older ones stay in the feed', async () => {
    await db.insert(allowances).values(permission(10 * DAY_MS))
    await db.insert(events).values(refusal(DAY_MS + 60_000))
    await subscribe(PHONE)
    const { sender, sent } = service()
    await notifier(sender).run()
    expect(sent).toEqual([])
  })

  it('start from the moment the browser subscribed, not the day before it', async () => {
    await db.insert(allowances).values(permission(10 * DAY_MS))
    await db.insert(events).values(refusal(2 * HOUR))
    await subscribe(PHONE, OWNER, at(-HOUR))
    const { sender, sent } = service()
    await notifier(sender).run()
    expect(sent).toEqual([])
  })

  it('skip charges that went through', async () => {
    await db.insert(allowances).values(permission(10 * DAY_MS))
    await db.insert(events).values(refusal(60_000, { kind: 'charged', reason: null }))
    await subscribe(PHONE)
    const { sender, sent } = service()
    await notifier(sender).run()
    expect(sent).toEqual([])
  })
})

describe('charges due', () => {
  it('are announced within the lead, with the moment for the browser to write', async () => {
    await db.insert(allowances).values(permission(6 * HOUR))
    await subscribe(PHONE)
    const { sender, sent } = service()
    const { run, refreshed } = notifier(sender)

    expect(await run()).toEqual({ sent: 1, gone: 0, failed: 0 })
    expect(refreshed).toEqual([[PDA]])
    expect(sent[0]?.message).toMatchObject({
      kind: 'upcoming',
      title: 'Charge due {at}',
      at: at(6 * HOUR),
      allowance: PDA,
    })
    expect(sent[0]?.message.body).toContain('may take up to 10.00 USDC')
    expect(sent[0]?.options).toEqual({ ttlSeconds: 6 * 3600, urgency: 'normal' })

    // Every five minutes the scan comes round again; the period is the same.
    expect(await run()).toEqual({ sent: 0, gone: 0, failed: 0 })
    expect(refreshed).toEqual([[PDA]])
  })

  it('are not announced before the lead, and the chain is not asked', async () => {
    await db.insert(allowances).values(permission(DAY_MS + HOUR))
    await subscribe(PHONE)
    const { sender, sent } = service()
    const { run, refreshed } = notifier(sender)
    await run()
    expect(sent).toEqual([])
    expect(refreshed).toEqual([])
  })

  it('come a quarter of the period ahead on a short plan', async () => {
    await db
      .insert(allowances)
      .values([
        permission(50 * 60 * 1000, { periodSeconds: 4 * 3600 }),
        permission(2 * HOUR, { pda: OTHER_PDA, periodSeconds: 4 * 3600 }),
      ])
    await subscribe(PHONE)
    const { sender, sent } = service()
    await notifier(sender).run()
    expect(sent.map((push) => push.message.allowance)).toEqual([PDA])
  })

  it('follow PUSH_UPCOMING_LEAD_HOURS', async () => {
    await db.insert(allowances).values(permission(30 * HOUR))
    await subscribe(PHONE)
    const { sender, sent } = service()
    await notifier(sender, { leadMs: 48 * HOUR }).run()
    expect(sent).toHaveLength(1)
  })

  it.each([
    ['paused', { status: 'paused', pausedAt: at(-DAY_MS) }],
    ['set to end', { endsAt: at(6 * HOUR) }],
    ['cancelled', { status: 'revoked' }],
    [
      'a one-off ceiling',
      { kind: 'fixed', periodSeconds: null, periodStartedAt: null, planPda: null },
    ],
  ] as const)('are not announced for a permission %s', async (_, overrides) => {
    await db.insert(allowances).values(permission(6 * HOUR, overrides))
    await subscribe(PHONE)
    const { sender, sent } = service()
    await notifier(sender).run()
    expect(sent).toEqual([])
  })

  it('are not announced when the chain says it was cancelled since (FR-024)', async () => {
    await db.insert(allowances).values(permission(6 * HOUR))
    await subscribe(PHONE)
    const { sender, sent } = service()
    await notifier(sender, {
      refresh: async () => {
        await db.update(allowances).set({ status: 'revoked' }).where(eq(allowances.pda, PDA))
        return new Set()
      },
    }).run()
    expect(sent).toEqual([])
    expect(await db.select().from(pushDeliveries)).toEqual([])
  })

  it('are not announced when the chain cannot vouch for the permission — the cache alone is not enough', async () => {
    await db.insert(allowances).values(permission(6 * HOUR))
    await subscribe(PHONE)
    const { sender, sent } = service()
    // An account that is there but is not a permission any more: `refresh`
    // leaves the cache untouched and says so by not listing it.
    await notifier(sender, { refresh: async () => new Set() }).run()
    expect(sent).toEqual([])
  })

  it('are not announced when the chain has moved to the next period already', async () => {
    await db.insert(allowances).values(permission(6 * HOUR))
    await subscribe(PHONE)
    const { sender, sent } = service()
    await notifier(sender, {
      refresh: async () => {
        await db
          .update(allowances)
          .set({ periodStartedAt: at(-60_000) })
          .where(eq(allowances.pda, PDA))
        return new Set([PDA])
      },
    }).run()
    expect(sent).toEqual([])
  })

  it('are announced again for the next period', async () => {
    await db.insert(allowances).values(permission(6 * HOUR))
    await subscribe(PHONE)
    const { sender, sent } = service()
    await notifier(sender).run()

    const next = permission(MONTH_SECONDS * 1000 + 6 * HOUR)
    await db
      .update(allowances)
      .set({ periodStartedAt: next.periodStartedAt })
      .where(eq(allowances.pda, PDA))
    const later = new Date(NOW.getTime() + MONTH_SECONDS * 1000)
    await notifier(sender, { now: () => later }).run()

    expect(sent).toHaveLength(2)
    expect((await db.select().from(pushDeliveries)).map((row) => row.ref).sort()).toEqual(
      [
        upcomingRef(PDA, permission(6 * HOUR).periodStartedAt ?? ''),
        upcomingRef(PDA, next.periodStartedAt ?? ''),
      ].sort(),
    )
  })
})

describe('what the push service answers', () => {
  it('forgets a subscription the browser dropped, and skips the rest of it', async () => {
    await db.insert(allowances).values(permission(6 * HOUR))
    await db.insert(events).values(refusal(60_000))
    await subscribe(PHONE)
    const { sender, sent } = service({ state: 'gone', status: 410 })

    expect(await notifier(sender).run()).toEqual({ sent: 0, gone: 1, failed: 0 })
    expect(sent).toHaveLength(1)
    expect(await db.select().from(pushSubscriptions)).toEqual([])
    expect(await db.select().from(pushDeliveries)).toEqual([])
  })

  it('tries an unreachable push service again on the next run', async () => {
    await db.insert(allowances).values(permission(10 * DAY_MS))
    await db.insert(events).values(refusal(60_000))
    await subscribe(PHONE)
    const down = service({ state: 'unreachable', status: 503, detail: '' })
    expect(await notifier(down.sender).run()).toEqual({ sent: 0, gone: 0, failed: 1 })
    expect(await db.select().from(pushDeliveries)).toEqual([])

    const up = service()
    expect(await notifier(up.sender).run()).toEqual({ sent: 1, gone: 0, failed: 0 })
  })

  it('does not retry a refusal — the same push would be refused again', async () => {
    await db.insert(allowances).values(permission(10 * DAY_MS))
    await db.insert(events).values(refusal(60_000))
    await subscribe(PHONE)
    const refused = service({ state: 'refused', status: 400, detail: 'bad' })
    expect(await notifier(refused.sender).run()).toEqual({ sent: 0, gone: 0, failed: 1 })

    const second = service()
    await notifier(second.sender).run()
    expect(second.sent).toEqual([])
  })
})

describe('run', () => {
  it('never sends one occasion twice from two runs at once', async () => {
    await db.insert(allowances).values(permission(10 * DAY_MS))
    await db.insert(events).values(refusal(60_000))
    await subscribe(PHONE)
    const sent: string[] = []
    const sender: PushSender = {
      send: async (target) => {
        sent.push(target.endpoint)
        await new Promise((resolve) => setTimeout(resolve, 20))
        return delivered
      },
    }
    const { run } = notifier(sender)
    await Promise.all([run(), run(), run()])
    expect(sent).toEqual([PHONE])
  })

  it('folds a burst of calls into one more pass, not one chain read per call', async () => {
    await db.insert(allowances).values(permission(6 * HOUR))
    await subscribe(PHONE)
    const { sender, sent } = service()
    const { run, refreshed } = notifier(sender)
    await Promise.all([run(), run(), run()])
    expect(sent).toHaveLength(1)
    expect(refreshed).toEqual([[PDA]])
  })

  it('sends one push when two indexers run at once — a rolling deploy', async () => {
    await db.insert(allowances).values(permission(6 * HOUR))
    await db.insert(events).values(refusal(60_000))
    await subscribe(PHONE)
    const sent: string[] = []
    const sender: PushSender = {
      send: async (_, message) => {
        sent.push(message.kind)
        await new Promise((resolve) => setTimeout(resolve, 20))
        return delivered
      },
    }
    // Two processes: two notifiers, nothing shared but the database.
    await Promise.all([notifier(sender).run(), notifier(sender).run()])
    expect(sent.sort()).toEqual(['rejected', 'upcoming'])
  })
})
