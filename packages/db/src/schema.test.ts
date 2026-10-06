import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOWANCE_KINDS,
  ALLOWANCE_STATUSES,
  EVENT_KINDS,
  REJECT_REASONS,
} from '@cancelchain/shared'
import { getTableColumns } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  allowances,
  events,
  indexerCursor,
  merchants,
  PUSH_KINDS,
  plans,
  pushSubscriptions,
} from './schema.js'
import { STREAM_CHANNEL } from './stream.js'

const migrationsDir = join(fileURLToPath(new URL('..', import.meta.url)), 'drizzle')

const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => readFileSync(join(migrationsDir, name), 'utf8'))
  .join('\n')

describe('migration', () => {
  it('exists — the schema without it is a file nobody ever ran', () => {
    expect(migrations.length).toBeGreaterThan(0)
  })

  it('creates every table the plan names', () => {
    for (const table of [
      'allowances',
      'events',
      'plans',
      'merchants',
      'push_subscriptions',
      'indexer_cursor',
      'indexer_heartbeat',
      'push_deliveries',
      'events_retention',
    ]) {
      expect(migrations, table).toContain(`CREATE TABLE "${table}"`)
    }
  })

  it('deduplicates events on (signature, position, allowance_pda)', () => {
    // Індексатор і backfill бачать ту саму транзакцію двічі за побудовою.
    expect(migrations).toContain(
      'CREATE UNIQUE INDEX "events_signature_position_allowance_key" ON "events" USING btree ("signature","position","allowance_pda")',
    )
  })

  it('no longer deduplicates on kind — that key dropped two of three split-payment charges', () => {
    expect(migrations).toContain('DROP INDEX "events_signature_allowance_kind_key"')
  })

  it('keys a push subscription by browser and wallet, not by browser alone (T043)', () => {
    expect(migrations).toContain('DROP INDEX "push_subscriptions_endpoint_key"')
    expect(migrations).toContain(
      'CREATE UNIQUE INDEX "push_subscriptions_endpoint_owner_key" ON "push_subscriptions" USING btree ("endpoint","owner")',
    )
  })

  it('forgets what was sent to a subscription together with the subscription', () => {
    expect(migrations).toContain(
      'FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade',
    )
    expect(migrations).toContain('PRIMARY KEY("subscription_id","kind","ref")')
  })

  it('refuses a retention window shorter than FR-029 promises (T044)', () => {
    expect(migrations).toContain(
      '"events_retention"."days" is null or "events_retention"."days" >= 90',
    )
  })

  it('carries every value of every finite list into a CHECK', () => {
    for (const value of [
      ...ALLOWANCE_KINDS,
      ...ALLOWANCE_STATUSES,
      ...EVENT_KINDS,
      ...REJECT_REASONS,
      ...PUSH_KINDS,
    ]) {
      expect(migrations, value).toContain(`'${value}'`)
    }
  })

  it('lets no reason category exist that the shared list does not know', () => {
    const constraint = migrations.match(/CONSTRAINT "events_reason_check" CHECK \(([^\n]*)\)/)?.[1]
    expect(constraint).toBeDefined()
    for (const trash of ['other', 'unknown', 'misc']) {
      expect(constraint, trash).not.toContain(`'${trash}'`)
    }
  })

  it('does not constrain spent_in_period against cap_amount, on purpose', () => {
    // FR-025: розбіжність із мережею має дійти до екрана, а не впертися в БД.
    expect(migrations).not.toContain('spent_in_period" <=')
  })

  it('dates a cancellation, and only a cancellation', () => {
    // Without the date a `cancelled` row says nothing: the merchant may still charge until then.
    expect(migrations).toContain(
      `CHECK (("events"."kind" = 'cancelled') = ("events"."charges_stop_at" is not null))`,
    )
  })

  it('keeps the plan a subscription is on without requiring it in the catalog', () => {
    expect(migrations).toContain('DROP CONSTRAINT "allowances_plan_pda_plans_pda_fk"')
  })

  it('stores the cursor as a transaction, not only a slot', () => {
    // A restart catches up `until` a signature; a slot alone cannot be resumed from.
    expect(migrations).toContain(
      'ALTER TABLE "indexer_cursor" ADD COLUMN "last_signature" text NOT NULL',
    )
  })

  it('keeps pause and scheduled end available only to plan subscriptions', () => {
    expect(migrations).toContain('"allowances_pause_is_subscription_only"')
    expect(migrations).toContain('"allowances_ends_at_is_subscription_only"')
  })
})

describe('stream notifications (T042)', () => {
  it('announces on the channel the API listens to, and on no other', () => {
    const channels = [...migrations.matchAll(/pg_notify\('([^']+)'/g)].map((match) => match[1])
    expect(channels.length).toBeGreaterThan(0)
    expect(new Set(channels)).toEqual(new Set([STREAM_CHANNEL]))
  })

  it('announces a changed permission on every visible column, and not on sync bookkeeping', () => {
    // A column added later and left out here would change silently on screen.
    const trigger = migrations.match(
      /CREATE TRIGGER "allowances_stream_notify_update"[\s\S]*?EXECUTE FUNCTION/,
    )?.[0]
    expect(trigger).toBeDefined()
    const bookkeeping = new Set(['pda', 'last_slot', 'synced_at'])
    for (const column of Object.values(getTableColumns(allowances))) {
      const old = `OLD."${column.name}"`
      if (bookkeeping.has(column.name)) expect(trigger, column.name).not.toContain(old)
      else expect(trigger, column.name).toContain(old)
    }
  })

  it('announces a stored event and a stored permission', () => {
    expect(migrations).toContain('AFTER INSERT ON "events"')
    expect(migrations).toContain('AFTER INSERT ON "allowances"')
  })
})

describe('schema types', () => {
  it('stores u64 amounts as numeric(20, 0), kept inside u64 by a CHECK (T041c)', () => {
    // Postgres `bigint` stops at 2^63 − 1; a ceiling of u64::MAX must fit.
    for (const [table, column] of [
      ['allowances', 'cap_amount'],
      ['allowances', 'spent_in_period'],
      ['events', 'amount'],
      ['plans', 'plan_id'],
      ['plans', 'amount'],
    ]) {
      expect(migrations).toContain(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DATA TYPE numeric(20, 0)`,
      )
      expect(migrations).toContain(
        `CHECK ("${table}"."${column}" between 0 and 18446744073709551615)`,
      )
    }
  })

  it('keeps money in bigint and slots in number', () => {
    const allowance: typeof allowances.$inferSelect = {
      pda: 'p',
      owner: 'o',
      delegate: 'd',
      mint: 'm',
      kind: 'recurring',
      capAmount: 24_000_000n,
      periodSeconds: 2_592_000,
      spentInPeriod: 0n,
      periodStartedAt: '2026-08-07T00:00:00.000Z',
      expiresAt: null,
      pausedAt: null,
      endsAt: null,
      status: 'active',
      planPda: null,
      lastSlot: 325_100_442,
      syncedAt: '2026-09-02T10:15:00.000Z',
    }
    expect(typeof allowance.capAmount).toBe('bigint')
    expect(typeof allowance.lastSlot).toBe('number')
  })

  it('exposes each table under the name the plan uses', () => {
    for (const table of [allowances, events, plans, merchants, pushSubscriptions, indexerCursor]) {
      expect(table).toBeDefined()
    }
  })
})
