import { afterEach, describe, expect, it } from 'vitest'
import { createDb, type DbHandle, POOL_MAX } from './db.js'
import { apiConfigSchema, DirectDatabaseConnectionError, POOLER_PORT } from './env.js'

/** Пул створюється лениво: postgres.js не відкриває сокет до першого запиту. */
const POOLED = `postgresql://user:pass@db.example.supabase.com:${POOLER_PORT}/postgres`
const DIRECT = 'postgresql://user:pass@db.example.supabase.com:5432/postgres'

let handle: DbHandle | null = null

afterEach(async () => {
  await handle?.close()
  handle = null
})

describe('createDb', () => {
  it('вимикає prepared statements — pgbouncer у transaction mode їх не тримає', () => {
    handle = createDb(apiConfigSchema.parse({ databaseUrl: POOLED }))
    expect(handle.sql.options.prepare).toBe(false)
  })

  it('тримає маленький пул: на free tier два конекшени на api й indexer разом', () => {
    handle = createDb(apiConfigSchema.parse({ databaseUrl: POOLED }))
    expect(handle.sql.options.max).toBe(POOL_MAX)
  })

  it('не піднімається на прямому підключенні без явного дозволу', () => {
    expect(() => createDb(apiConfigSchema.parse({ databaseUrl: DIRECT }))).toThrow(
      DirectDatabaseConnectionError,
    )
  })
})
