import { type ChainConfig, chainConfigFromEnv } from '@cancelchain/chain'
import { z } from 'zod'

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/** `"true"` / `"false"` only: `z.coerce.boolean()` would read `"false"` as `true`. */
const flagSchema = z.enum(['true', 'false']).transform((value) => value === 'true')

const indexerEnvSchema = z.object({
  logLevel: z.enum(LOG_LEVELS).default('info'),
  /**
   * `false` asks for the polling fallback (`T045`), which does not exist yet.
   * Starting anyway would mean a worker that indexes nothing and looks healthy.
   */
  useWs: flagSchema.default(true),
})

export type IndexerConfig = z.infer<typeof indexerEnvSchema> & { chain: ChainConfig }

/** Reads any map of strings, not `process.env` directly — so it is testable without globals. */
export function indexerConfigFromEnv(env: Record<string, string | undefined>): IndexerConfig {
  const own = indexerEnvSchema.parse({
    logLevel: env.LOG_LEVEL === '' ? undefined : env.LOG_LEVEL,
    useWs: env.INDEXER_USE_WS === '' ? undefined : env.INDEXER_USE_WS,
  })
  return { ...own, chain: chainConfigFromEnv(env) }
}
