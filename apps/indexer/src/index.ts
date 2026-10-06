import { vapidFromEnv } from '@cancelchain/push'
import { pino } from 'pino'
import { indexerConfigFromEnv } from './env.js'
import { startIndexer } from './worker.js'

/**
 * The indexer as its own process: read the environment, run until SIGINT or
 * SIGTERM. The worker itself lives in `worker.ts`, so the API can run it in
 * its own process on a single web service (`T044`, `RUN_INDEXER`).
 */

const config = indexerConfigFromEnv(process.env)
// Throws on a half-set VAPID trio; none at all is push off (`T043`, `FR-027`).
const vapid = vapidFromEnv(process.env)
const log = pino({
  level: config.logLevel,
  base: { service: 'indexer' },
  timestamp: pino.stdTimeFunctions.isoTime,
})

try {
  const indexer = await startIndexer({ config, vapid, log })
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.once(name, () => {
      log.info({ signal: name }, 'stopping')
      void indexer.stop()
    })
  }
  await indexer.done
} catch (error) {
  // `process.exitCode`, not `process.exit()`: the worker stops by running out of work.
  log.fatal({ error: error instanceof Error ? error.message : String(error) }, 'indexer failed')
  process.exitCode = 1
}
