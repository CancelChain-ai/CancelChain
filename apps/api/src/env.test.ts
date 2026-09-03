import { describe, expect, it } from 'vitest'
import {
  apiConfigFromEnv,
  apiConfigSchema,
  assertPooledDatabase,
  DEFAULT_PORT,
  DirectDatabaseConnectionError,
  databasePort,
  POOLER_PORT,
} from './env.js'

const POOLED = `postgresql://user:pass@db.example.supabase.com:${POOLER_PORT}/postgres`
const DIRECT = 'postgresql://user:pass@db.example.supabase.com:5432/postgres'

describe('apiConfigSchema', () => {
  it('порт за замовчуванням — 8080', () => {
    expect(apiConfigSchema.parse({ databaseUrl: POOLED }).port).toBe(DEFAULT_PORT)
  })

  it('порт із оточення приходить рядком і приводиться до числа', () => {
    expect(apiConfigFromEnv({ PORT: '3000', DATABASE_URL: POOLED }).port).toBe(3000)
  })

  it('рівень логування за замовчуванням — info', () => {
    expect(apiConfigSchema.parse({ databaseUrl: POOLED }).logLevel).toBe('info')
  })

  it('невідомий рівень логування не проходить', () => {
    expect(() => apiConfigSchema.parse({ databaseUrl: POOLED, logLevel: 'chatty' })).toThrow()
  })

  it('рядок підключення має бути postgres-URL', () => {
    expect(() => apiConfigSchema.parse({ databaseUrl: 'mysql://user@host:3306/db' })).toThrow()
    expect(() => apiConfigSchema.parse({ databaseUrl: 'not a url' })).toThrow()
  })

  it('обидві форми схеми postgres приймаються', () => {
    expect(() =>
      apiConfigSchema.parse({ databaseUrl: `postgres://u:p@host:${POOLER_PORT}/db` }),
    ).not.toThrow()
  })

  it('ALLOW_DIRECT_DATABASE вмикається лише явним true або 1', () => {
    const base = { DATABASE_URL: POOLED }
    expect(apiConfigFromEnv(base).allowDirectDatabase).toBe(false)
    expect(apiConfigFromEnv({ ...base, ALLOW_DIRECT_DATABASE: 'true' }).allowDirectDatabase).toBe(
      true,
    )
    expect(apiConfigFromEnv({ ...base, ALLOW_DIRECT_DATABASE: '1' }).allowDirectDatabase).toBe(true)
    expect(apiConfigFromEnv({ ...base, ALLOW_DIRECT_DATABASE: 'yes' }).allowDirectDatabase).toBe(
      false,
    )
  })
})

describe('databasePort', () => {
  it('дістає порт із рядка підключення', () => {
    expect(databasePort(POOLED)).toBe(String(POOLER_PORT))
  })

  it('порожній рядок для URL без порту, null для не-postgres', () => {
    expect(databasePort('postgresql://user@host/db')).toBe('')
    expect(databasePort('http://host:6543/db')).toBeNull()
  })
})

describe('assertPooledDatabase', () => {
  it('пропускає підключення через pooler на 6543', () => {
    expect(() => assertPooledDatabase(apiConfigSchema.parse({ databaseUrl: POOLED }))).not.toThrow()
  })

  it('зупиняє пряме підключення на 5432 — free tier дає 2 конекшени на два сервіси', () => {
    expect(() => assertPooledDatabase(apiConfigSchema.parse({ databaseUrl: DIRECT }))).toThrow(
      DirectDatabaseConnectionError,
    )
  })

  it('зупиняє й URL без порту: за замовчуванням це 5432, а не pooler', () => {
    const config = apiConfigSchema.parse({ databaseUrl: 'postgresql://user@host/postgres' })
    expect(() => assertPooledDatabase(config)).toThrow(DirectDatabaseConnectionError)
  })

  it('явний дозвіл знімає перевірку — для локального Postgres', () => {
    const config = apiConfigSchema.parse({ databaseUrl: DIRECT, allowDirectDatabase: true })
    expect(() => assertPooledDatabase(config)).not.toThrow()
  })
})
