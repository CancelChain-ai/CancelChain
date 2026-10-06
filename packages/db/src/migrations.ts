import { fileURLToPath } from 'node:url'

/**
 * The folder drizzle-kit writes to (`drizzle.config.ts` → `out`): the SQL files
 * and `meta/_journal.json`, which is what a migrator reads to know their order.
 * The API applies it at start on a deployment (`T046`, `MIGRATE_ON_START`).
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle/', import.meta.url))

/** Where the migrator records what it applied — drizzle's own defaults, named. */
export const MIGRATIONS_SCHEMA = 'drizzle'
export const MIGRATIONS_TABLE = '__drizzle_migrations'
