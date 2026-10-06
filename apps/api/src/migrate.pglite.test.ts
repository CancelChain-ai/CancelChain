import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATIONS_DIR, MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from '@cancelchain/db'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The deployment applies the schema through drizzle's migrator and its journal
 * (`T046`), while every other database test here runs the SQL files directly.
 * This one runs the journal the way Supabase will receive it: a hand-written
 * file left out of the journal, or a statement the migrator splits wrongly,
 * would pass every other test and break the first deployment.
 *
 * The postgres.js wrapper around it (`migrate.ts`: lock, counts) is the same
 * migrator over another driver; it is exercised on a real Postgres by hand.
 */

const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as {
  entries: { tag: string }[]
}

const config = {
  migrationsFolder: MIGRATIONS_DIR,
  migrationsSchema: MIGRATIONS_SCHEMA,
  migrationsTable: MIGRATIONS_TABLE,
}

let client: PGlite

async function recorded(): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from "${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`,
  )
  return rows[0]?.n ?? -1
}

beforeAll(async () => {
  client = await PGlite.create()
  await migrate(drizzle(client), config)
}, 60_000)

afterAll(async () => {
  await client?.close()
})

describe('migrations through the journal', () => {
  it('apply every journal entry to an empty database', async () => {
    expect(journal.entries.length).toBeGreaterThanOrEqual(10)
    expect(await recorded()).toBe(journal.entries.length)
  })

  it('apply nothing the second time', async () => {
    await migrate(drizzle(client), config)
    expect(await recorded()).toBe(journal.entries.length)
  })

  it('leave no table in public without row-level security', async () => {
    const { rows } = await client.query<{ name: string; rls: boolean }>(
      `select c.relname as name, c.relrowsecurity as rls
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by 1`,
    )
    expect(rows.length).toBeGreaterThanOrEqual(10)
    expect(rows.filter((row) => !row.rls).map((row) => row.name)).toEqual([])
  })

  it('show a role other than the owner nothing, even with a grant', async () => {
    // Supabase's Data API runs as `anon`, and Supabase grants it the public schema.
    await client.exec(`
      insert into indexer_heartbeat (name, alive_at) values ('probe', now());
      create role anon;
      grant usage on schema public to anon;
      grant select, insert on all tables in schema public to anon;
    `)
    const owner = await client.query('select * from indexer_heartbeat')
    expect(owner.rows.length).toBe(1)

    await client.exec('set role anon')
    try {
      const anon = await client.query('select * from indexer_heartbeat')
      expect(anon.rows).toEqual([])
      await expect(
        client.query(`insert into indexer_heartbeat (name, alive_at) values ('anon', now())`),
      ).rejects.toThrow(/row-level security/)
    } finally {
      await client.exec('reset role')
    }
  })
})
