import {
  ALLOWANCE_KINDS,
  ALLOWANCE_STATUSES,
  type AllowanceKind,
  type AllowanceStatus,
  EVENT_KINDS,
  type EventKind,
  REJECT_REASONS,
  type RejectReason,
} from '@cancelchain/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * Усе, що є ончейн, лежить тут як **кеш зі свіжістю**, а не як джерело правди.
 * Перед показом картки й перед будь-якою дією стан звіряється з мережею
 * (`FR-024`), і при розбіжності показується мережа (`FR-025`).
 */

/**
 * Перелік значень для `CHECK` — будується з тих самих констант `packages/shared`,
 * якими типізовані колонки. Розійтися вони не можуть за побудовою: додати
 * категорію в одному місці й забути в іншому тут неможливо.
 */
function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value}'`).join(', '))
}

/**
 * A u64 of the chain (`T041c`): amounts, ceilings, plan ids. Postgres `bigint`
 * is signed and stops at 2^63 − 1, while a permission may carry u64::MAX — the
 * customary "no limit" — and one row that does not fit would stop the indexer on
 * that transaction for everyone. So `numeric(20, 0)` with a range `CHECK`, and
 * `bigint` in code as before. The driver hands `numeric` over as a string, so
 * nothing passes through a double.
 */
export const U64_MAX = 18_446_744_073_709_551_615n

const u64 = customType<{ data: bigint; driverData: string }>({
  dataType: () => 'numeric(20, 0)',
  toDriver: (value) => value.toString(10),
  fromDriver: (value) => BigInt(value),
})

const money = (name: string) => u64(name)

/** Every u64 column stays inside u64: numeric alone would take −1 or 10^19 · 2. */
function inU64(column: unknown) {
  return sql`${column} between 0 and ${sql.raw(U64_MAX.toString(10))}`
}
/** Слоти на дев'ять порядків менші за `MAX_SAFE_INTEGER` — число безпечне. */
const slot = (name: string) => bigint(name, { mode: 'number' })
const moment = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' })

export const merchants = pgTable('merchants', {
  address: text('address').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: moment('created_at').notNull().defaultNow(),
})

export const plans = pgTable(
  'plans',
  {
    pda: text('pda').primaryKey(),
    merchant: text('merchant').notNull(),
    planId: money('plan_id').notNull(),
    /** Офчейн-метадані — назва наша, у мережі її немає. */
    name: text('name').notNull(),
    amount: money('amount').notNull(),
    /**
     * Завжди секунди. `PlanTerms.periodHours` рахує годинами, і конвертація
     * робиться явно через `periodSecondsFromHours` — див. `packages/shared/period.ts`.
     */
    periodSeconds: integer('period_seconds').notNull(),
    mint: text('mint').notNull(),
    createdAt: moment('created_at').notNull().defaultNow(),
  },
  (table) => [
    check('plans_plan_id_u64', inU64(table.planId)),
    check('plans_amount_u64', inU64(table.amount)),
  ],
)

export const allowances = pgTable(
  'allowances',
  {
    pda: text('pda').primaryKey(),
    owner: text('owner').notNull(),
    delegate: text('delegate').notNull(),
    /** USDC — єдиний розрахунковий актив (`FR-020`); інші показуються, не створюються. */
    mint: text('mint').notNull(),
    kind: text('kind').$type<AllowanceKind>().notNull(),
    capAmount: money('cap_amount').notNull(),
    /** `null` лише для `fixed`. */
    periodSeconds: integer('period_seconds'),
    // Дефолт через `sql`, не `0n`: drizzle-kit серіалізує знімок схеми в JSON,
    // а BigInt у JSON.stringify не влазить і валить `generate`.
    spentInPeriod: money('spent_in_period').notNull().default(sql`0`),
    periodStartedAt: moment('period_started_at'),
    expiresAt: moment('expires_at'),
    /** `FR-011` — лише `kind = subscription`; зняття з паузи ручне. */
    pausedAt: moment('paused_at'),
    /** `FR-028` — до цієї дати дозвіл лишається `active` з явною позначкою. */
    endsAt: moment('ends_at'),
    status: text('status').$type<AllowanceStatus>().notNull(),
    /**
     * No foreign key to `plans`, on purpose: which plan a subscription is on is
     * a chain fact, while `plans` is the catalog — only the plans a merchant
     * named through us. The indexer caches subscriptions to anyone's plan.
     */
    planPda: text('plan_pda'),
    /** Слот останньої звірки з мережею. */
    lastSlot: slot('last_slot').notNull(),
    syncedAt: moment('synced_at').notNull().defaultNow(),
  },
  (table) => [
    index('allowances_owner_status_idx').on(table.owner, table.status),
    index('allowances_delegate_status_idx').on(table.delegate, table.status),
    check('allowances_kind_check', sql`${table.kind} in (${inList(ALLOWANCE_KINDS)})`),
    check('allowances_cap_amount_u64', inU64(table.capAmount)),
    check('allowances_spent_in_period_u64', inU64(table.spentInPeriod)),
    check('allowances_status_check', sql`${table.status} in (${inList(ALLOWANCE_STATUSES)})`),
    // Пауза й «не поновлювати» існують тільки для підписки за планом.
    check(
      'allowances_pause_is_subscription_only',
      sql`${table.pausedAt} is null or ${table.kind} = 'subscription'`,
    ),
    check(
      'allowances_ends_at_is_subscription_only',
      sql`${table.endsAt} is null or ${table.kind} = 'subscription'`,
    ),
    // Період є в усіх, крім разової стелі.
    check(
      'allowances_period_matches_kind',
      sql`(${table.kind} = 'fixed') = (${table.periodSeconds} is null)`,
    ),
    // Свідомо НЕ перевіряємо spent_in_period <= cap_amount: розбіжний стан
    // мережі має дійти до екрана й бути показаним (`FR-025`), а не впертися в БД.
  ],
)

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    allowancePda: text('allowance_pda')
      .notNull()
      .references(() => allowances.pda),
    kind: text('kind').$type<EventKind>().notNull(),
    amount: money('amount'),
    /**
     * Категорія відмови (`SC-011`). `null` означає рівно одне: код програми нам
     * невідомий, і воркер залогував це як помилку мапінгу. Категорії `other`
     * у переліку немає навмисно.
     */
    reason: text('reason').$type<RejectReason>(),
    signature: text('signature').notNull(),
    /**
     * Place of the instruction behind the event in the transaction's execution
     * order, CPIs included. One transaction can charge one permission several
     * times — a split payment on devnet did, three times — so the signature
     * alone does not name an event.
     */
    position: integer('position').notNull(),
    slot: slot('slot').notNull(),
    blockTime: moment('block_time').notNull(),
    /** Обрізаний лог: 20 рядків на успіх, 200 на відмову — інакше jsonb з'їдає free tier. */
    raw: jsonb('raw'),
    /** Only on `cancelled`: the moment the program starts refusing charges. */
    chargesStopAt: moment('charges_stop_at'),
  },
  (table) => [
    /**
     * Дедуплікація. Індексатор і backfill бачать ту саму транзакцію двічі за
     * побудовою; без цього обмеження стрічка дублюється після кожного
     * перезапуску воркера.
     *
     * `position`, not `kind`: with `(signature, allowance, kind)` the second and
     * third charge of a split payment were dropped as duplicates (`T039`).
     * A wallet-wide event expands into one row per permission at one position,
     * so the permission stays in the key.
     */
    uniqueIndex('events_signature_position_allowance_key').on(
      table.signature,
      table.position,
      table.allowancePda,
    ),
    index('events_allowance_block_time_idx').on(table.allowancePda, table.blockTime.desc()),
    check('events_kind_check', sql`${table.kind} in (${inList(EVENT_KINDS)})`),
    // Null passes: `between` on null is unknown, and a CHECK fails only on false.
    check('events_amount_u64', inU64(table.amount)),
    check(
      'events_reason_check',
      sql`${table.reason} is null or ${table.reason} in (${inList(REJECT_REASONS)})`,
    ),
    // Причину має тільки відмова; списання не може нести категорію відмови.
    check(
      'events_reason_only_on_rejected',
      sql`${table.reason} is null or ${table.kind} = 'rejected'`,
    ),
    check(
      'events_charge_has_amount',
      sql`${table.kind} <> 'charged' or ${table.amount} is not null`,
    ),
    check(
      'events_charges_stop_at_only_on_cancelled',
      sql`(${table.kind} = 'cancelled') = (${table.chargesStopAt} is not null)`,
    ),
  ],
)

/**
 * Підписка на push прив'язана до браузера, а не до особи (`FR-018`): адреси чи
 * іншого ідентифікатора людини тут немає й не буде.
 *
 * `owner` is the wallet this browser follows, and one browser may follow several
 * (`T043`): a row is the pair (endpoint, owner), not the endpoint.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    owner: text('owner').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: moment('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('push_subscriptions_endpoint_owner_key').on(table.endpoint, table.owner),
    index('push_subscriptions_owner_idx').on(table.owner),
  ],
)

export const PUSH_KINDS = ['upcoming', 'rejected'] as const
export type PushKind = (typeof PUSH_KINDS)[number]

/**
 * What was already sent where (`T043`). The indexer replays transactions after
 * every restart and scans for charges due every few minutes; without this row
 * each of those would buzz the same phone again. A row is claimed before the
 * push goes out, so a notification reaches a browser at most once.
 *
 * `ref` names the occasion: the event id for a refusal, `pda@periodStartedAt`
 * for a charge due — the next period is a new occasion, the same one is not.
 */
export const pushDeliveries = pgTable(
  'push_deliveries',
  {
    subscriptionId: bigint('subscription_id', { mode: 'bigint' })
      .notNull()
      .references(() => pushSubscriptions.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<PushKind>().notNull(),
    ref: text('ref').notNull(),
    sentAt: moment('sent_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.subscriptionId, table.kind, table.ref] }),
    check('push_deliveries_kind_check', sql`${table.kind} in (${inList(PUSH_KINDS)})`),
  ],
)

export const indexerCursor = pgTable('indexer_cursor', {
  name: text('name').primaryKey(),
  /** The last transaction stored; the indexer catches up from it after a restart. */
  lastSignature: text('last_signature').notNull(),
  lastSlot: slot('last_slot').notNull(),
  updatedAt: moment('updated_at').notNull().defaultNow(),
})

/** The log loop's name, for its cursor and its heartbeat. */
export const PROGRAM_LOGS = 'program-logs'

/**
 * The indexer's pulse (`T041`): written every few seconds while its log
 * subscription is open and catch-up is done. The cursor cannot say this — it
 * moves only when the program has transactions, so a quiet night would read as
 * a dead indexer and a dead one as fresh until the next transaction.
 */
export const indexerHeartbeat = pgTable('indexer_heartbeat', {
  /**
   * `PROGRAM_LOGS` — the log loop, reading the whole program; the polling
   * fallback beats under its own name (`T045`) and does not count for `/events`.
   */
  name: text('name').primaryKey(),
  aliveAt: moment('alive_at').notNull(),
})

/**
 * What the retention step actually did (`T044`, `FR-029`): written by the worker
 * after every pass, read by the API for the feed. Like the heartbeat, it says
 * what happened, not what the configuration promises — a stopped worker or two
 * services configured differently cannot make the page name a depth nobody
 * enforces.
 *
 * `days: null` — retention is off and every indexed event is kept;
 * `kept_since` is then `null` as well.
 */
export const eventsRetention = pgTable(
  'events_retention',
  {
    name: text('name').primaryKey(),
    days: integer('days'),
    /** Nothing older than this is kept: the cut of the last pass. */
    keptSince: moment('kept_since'),
    ranAt: moment('ran_at').notNull(),
  },
  (table) => [
    // `FR-029` promises at least 90 days; a shorter window is not a setting.
    check('events_retention_days_floor', sql`${table.days} is null or ${table.days} >= 90`),
    check(
      'events_retention_cut_matches_days',
      sql`(${table.days} is null) = (${table.keptSince} is null)`,
    ),
  ],
)

/**
 * Wallets someone is looking at right now (`T045`): the polling fallback reads
 * only these. The API writes `active_until` while a `/v1/stream` of the wallet
 * is open; the indexer writes `synced_at` once every address of the wallet has
 * been read to the head — the wallet's own pulse, since in that mode nobody
 * reads the whole program and the program's heartbeat says nothing about it.
 */
export const watchedWallets = pgTable(
  'watched_wallets',
  {
    owner: text('owner').primaryKey(),
    activeUntil: moment('active_until').notNull(),
    syncedAt: moment('synced_at'),
  },
  (table) => [index('watched_wallets_active_until_idx').on(table.activeUntil)],
)

/**
 * How long one sign of life keeps a wallet watched. Three stream pings
 * (`STREAM_HEARTBEAT_MS`, 20 s) fit in it, so one lost write does not drop a
 * wallet that is still open on someone's screen.
 */
export const WALLET_WATCH_TTL_MS = 2 * 60 * 1000

export type MerchantRow = typeof merchants.$inferSelect
export type PlanRow = typeof plans.$inferSelect
export type AllowanceRow = typeof allowances.$inferSelect
export type EventRow = typeof events.$inferSelect
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect
export type PushDeliveryRow = typeof pushDeliveries.$inferSelect
export type IndexerCursorRow = typeof indexerCursor.$inferSelect

export type NewMerchant = typeof merchants.$inferInsert
export type NewPlan = typeof plans.$inferInsert
export type NewAllowance = typeof allowances.$inferInsert
export type NewEvent = typeof events.$inferInsert
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert
