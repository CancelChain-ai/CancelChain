import { MIGRATIONS_DIR, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from '@cancelchain/db'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

/**
 * Schema migrations at start (`T046`, `MIGRATE_ON_START`). Render Free has no
 * pre-deploy step and no shell, so the only place a deployment can bring its
 * own schema is the process itself — before the indexer starts writing and
 * before the server binds, so nothing ever runs against an older schema than
 * the code expects.
 *
 * Through the **session** connection (`listenDatabaseUrl`, port 5432 on
 * Supabase), not the transaction pooler: DDL and a session-level advisory lock
 * both need the connection to stay the same one from statement to statement.
 */

const CONNECT_TIMEOUT_SECONDS = 10

/**
 * Two processes starting at once — a redeploy overlapping the previous
 * instance, or someone migrating by hand — wait for each other instead of
 * applying the same file twice. Any constant would do; this one is
 * `'cancelchain'` read as bytes.
 */
export const MIGRATION_LOCK_KEY = 0x63616e63656c63n

export type MigrationResult = {
  /** Applied by this run. */
  applied: number
  /** Recorded in the database after it, this run's included. */
  total: number
}

async function appliedCount(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ table: string | null }[]>`
    select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`})::text as table
  `
  if (row?.table === null || row?.table === undefined) return 0
  const [count] = await sql<{ n: number }[]>`
    select count(*)::int as n from ${sql(MIGRATIONS_SCHEMA)}.${sql(MIGRATIONS_TABLE)}
  `
  return count?.n ?? 0
}

/** Applies every migration not yet recorded, in journal order, in one transaction. */
export async function migrateDatabase(url: string): Promise<MigrationResult> {
  // One connection: the lock, the migration and the counts all on the same session.
  const sql = postgres(url, {
    max: 1,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    onnotice: () => {},
  })
  try {
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY.toString()}::bigint)`
    try {
      const before = await appliedCount(sql)
      await migrate(drizzle(sql), {
        migrationsFolder: MIGRATIONS_DIR,
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      })
      const total = await appliedCount(sql)
      return { applied: total - before, total }
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY.toString()}::bigint)`
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
