import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOWANCE_KINDS,
  ALLOWANCE_STATUSES,
  EVENT_KINDS,
  REJECT_REASONS,
} from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { allowances, events, indexerCursor, merchants, plans, pushSubscriptions } from './schema.js'

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
    ]) {
      expect(migrations, table).toContain(`CREATE TABLE "${table}"`)
    }
  })

  it('deduplicates events on (signature, allowance_pda, kind)', () => {
    // Індексатор і backfill бачать ту саму транзакцію двічі за побудовою.
    expect(migrations).toContain(
      'CREATE UNIQUE INDEX "events_signature_allowance_kind_key" ON "events" USING btree ("signature","allowance_pda","kind")',
    )
  })

  it('carries every value of every finite list into a CHECK', () => {
    for (const value of [
      ...ALLOWANCE_KINDS,
      ...ALLOWANCE_STATUSES,
      ...EVENT_KINDS,
      ...REJECT_REASONS,
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

  it('keeps pause and scheduled end available only to plan subscriptions', () => {
    expect(migrations).toContain('"allowances_pause_is_subscription_only"')
    expect(migrations).toContain('"allowances_ends_at_is_subscription_only"')
  })
})

describe('schema types', () => {
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
