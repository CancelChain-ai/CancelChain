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
  index,
  integer,
  jsonb,
  pgTable,
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

const money = (name: string) => bigint(name, { mode: 'bigint' })
/** Слоти на дев'ять порядків менші за `MAX_SAFE_INTEGER` — число безпечне. */
const slot = (name: string) => bigint(name, { mode: 'number' })
const moment = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' })

export const merchants = pgTable('merchants', {
  address: text('address').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: moment('created_at').notNull().defaultNow(),
})

export const plans = pgTable('plans', {
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
})

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
    planPda: text('plan_pda').references(() => plans.pda),
    /** Слот останньої звірки з мережею. */
    lastSlot: slot('last_slot').notNull(),
    syncedAt: moment('synced_at').notNull().defaultNow(),
  },
  (table) => [
    index('allowances_owner_status_idx').on(table.owner, table.status),
    index('allowances_delegate_status_idx').on(table.delegate, table.status),
    check('allowances_kind_check', sql`${table.kind} in (${inList(ALLOWANCE_KINDS)})`),
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
    slot: slot('slot').notNull(),
    blockTime: moment('block_time').notNull(),
    /** Обрізаний лог: 20 рядків на успіх, 200 на відмову — інакше jsonb з'їдає free tier. */
    raw: jsonb('raw'),
  },
  (table) => [
    /**
     * Дедуплікація. Індексатор і backfill бачать ту саму транзакцію двічі за
     * побудовою; без цього обмеження стрічка дублюється після кожного
     * перезапуску воркера.
     */
    uniqueIndex('events_signature_allowance_kind_key').on(
      table.signature,
      table.allowancePda,
      table.kind,
    ),
    index('events_allowance_block_time_idx').on(table.allowancePda, table.blockTime.desc()),
    check('events_kind_check', sql`${table.kind} in (${inList(EVENT_KINDS)})`),
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
  ],
)

/**
 * Підписка на push прив'язана до браузера, а не до особи (`FR-018`): адреси чи
 * іншого ідентифікатора людини тут немає й не буде.
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
    uniqueIndex('push_subscriptions_endpoint_key').on(table.endpoint),
    index('push_subscriptions_owner_idx').on(table.owner),
  ],
)

export const indexerCursor = pgTable('indexer_cursor', {
  name: text('name').primaryKey(),
  lastSlot: slot('last_slot').notNull(),
  updatedAt: moment('updated_at').notNull().defaultNow(),
})

export type MerchantRow = typeof merchants.$inferSelect
export type PlanRow = typeof plans.$inferSelect
export type AllowanceRow = typeof allowances.$inferSelect
export type EventRow = typeof events.$inferSelect
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect
export type IndexerCursorRow = typeof indexerCursor.$inferSelect

export type NewMerchant = typeof merchants.$inferInsert
export type NewPlan = typeof plans.$inferInsert
export type NewAllowance = typeof allowances.$inferInsert
export type NewEvent = typeof events.$inferInsert
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert
