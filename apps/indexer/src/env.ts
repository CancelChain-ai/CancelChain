import { type ChainConfig, chainConfigFromEnv } from '@cancelchain/chain'
import { assertPooledDatabaseUrl, postgresUrl } from '@cancelchain/db'
import { z } from 'zod'
import { MIN_RETENTION_DAYS } from './retention.js'

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/** `"true"` / `"false"` only: `z.coerce.boolean()` would read `"false"` as `true`. */
const flagSchema = z.enum(['true', 'false']).transform((value) => value === 'true')

const indexerEnvSchema = z.object({
  logLevel: z.enum(LOG_LEVELS).default('info'),
  /**
   * `false` switches to the polling fallback (`T045`, `poll.ts`): only wallets
   * with an open stream are read, every 15 s, instead of the whole program.
   */
  useWs: flagSchema.default(true),
  /** Where events are written (`T039`). A worker without it would index into nothing. */
  databaseUrl: z
    .string()
    .refine((value) => postgresUrl(value) !== null, 'expected a postgres:// connection string'),
  /** Same opt-in as the API's: the free tier has two direct connections for both services. */
  allowDirectDatabase: flagSchema.default(false),
  /**
   * How far ahead a charge due is announced (`T043`); a period shorter than two
   * of these gets a quarter of itself instead (`upcomingLeadMs`).
   */
  pushUpcomingLeadHours: z.coerce
    .number()
    .positive()
    .max(24 * 30)
    .default(24),
  /**
   * The feed's depth (`T044`, `FR-029`): whole days, at least 90, or `off` to
   * keep every indexed event. On by default — the store is a cache of public
   * chain history, and the free tier is 500 MB.
   */
  eventsRetentionDays: z
    .union([
      z.literal('off').transform(() => null),
      z.coerce
        .number()
        .int()
        .min(MIN_RETENTION_DAYS, `FR-029 promises at least ${MIN_RETENTION_DAYS} days of feed`),
    ])
    .default(MIN_RETENTION_DAYS),
})

export type IndexerConfig = z.infer<typeof indexerEnvSchema> & { chain: ChainConfig }

/** Reads any map of strings, not `process.env` directly — so it is testable without globals. */
export function indexerConfigFromEnv(env: Record<string, string | undefined>): IndexerConfig {
  const own = indexerEnvSchema.parse({
    logLevel: env.LOG_LEVEL === '' ? undefined : env.LOG_LEVEL,
    useWs: env.INDEXER_USE_WS === '' ? undefined : env.INDEXER_USE_WS,
    databaseUrl: env.DATABASE_URL,
    allowDirectDatabase: env.ALLOW_DIRECT_DATABASE === '' ? undefined : env.ALLOW_DIRECT_DATABASE,
    pushUpcomingLeadHours:
      env.PUSH_UPCOMING_LEAD_HOURS === '' ? undefined : env.PUSH_UPCOMING_LEAD_HOURS,
    eventsRetentionDays: env.EVENTS_RETENTION_DAYS === '' ? undefined : env.EVENTS_RETENTION_DAYS,
  })
  assertPooledDatabaseUrl(own.databaseUrl, own.allowDirectDatabase)
  return { ...own, chain: chainConfigFromEnv(env) }
}
