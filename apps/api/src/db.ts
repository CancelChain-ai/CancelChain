import * as schema from '@cancelchain/db'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { type ApiConfig, assertPooledDatabase } from './env.js'

/**
 * Підключення до Supabase через **transaction pooler на 6543**.
 *
 * `prepare: false` тут не налаштування смаку: pgbouncer у transaction mode
 * віддає з'єднання іншому клієнтові між запитами, тож `PREPARE`, зроблений в
 * одному, у наступному не існує. Помилка виглядає як «prepared statement "s1"
 * does not exist» на випадковому запиті під навантаженням — тобто не там і не
 * тоді, де причина.
 */

/**
 * Free tier Supabase — 2 конекшени, і на пулері вони діляться між `api` та
 * `indexer`. Тримаємо запас маленьким свідомо: черга всередині процесу краща за
 * відмову підключення в сусідньому сервісі.
 */
export const POOL_MAX = 3
const IDLE_TIMEOUT_SECONDS = 20
const CONNECT_TIMEOUT_SECONDS = 10

export type Db = PostgresJsDatabase<typeof schema>

export type DbHandle = {
  db: Db
  sql: postgres.Sql
  ping: () => Promise<void>
  close: () => Promise<void>
}

export function createDb(config: ApiConfig): DbHandle {
  assertPooledDatabase(config)
  const sql = postgres(config.databaseUrl, {
    prepare: false,
    max: POOL_MAX,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
  })
  return {
    db: drizzle(sql, { schema }),
    sql,
    ping: async () => {
      await sql`select 1`
    },
    close: () => sql.end({ timeout: 5 }),
  }
}
