import { createChainClient } from '@cancelchain/chain'
import { signature as toSignature } from '@solana/kit'
import { pino } from 'pino'
import type { DecodedTransaction } from './decode.js'
import { indexerConfigFromEnv } from './env.js'
import { type IndexerSource, jsonSafe, runIndexer } from './subscribe.js'

/**
 * Worker entry point: read the environment, build the kit-backed source, run
 * the loop until SIGINT/SIGTERM. The logic lives in `subscribe.ts` and
 * `decode.ts`, which are tested without a socket.
 */

const config = indexerConfigFromEnv(process.env)
const log = pino({
  level: config.logLevel,
  base: { service: 'indexer' },
  timestamp: pino.stdTimeFunctions.isoTime,
})

async function main(): Promise<void> {
  const chain = createChainClient(config.chain)
  const program = chain.programAddress

  const source: IndexerSource = {
    async logs(signal) {
      const notifications = await chain.rpcSubscriptions
        .logsNotifications({ mentions: [program] }, { commitment: 'confirmed' })
        .subscribe({ abortSignal: signal })
      return (async function* () {
        for await (const notification of notifications) {
          yield { signature: notification.value.signature, slot: notification.context.slot }
        }
      })()
    },
    async signaturesSince({ until, before, limit }) {
      const items = await chain.rpc
        .getSignaturesForAddress(program, {
          until: until === undefined ? undefined : toSignature(until),
          before: before === undefined ? undefined : toSignature(before),
          limit,
          commitment: 'confirmed',
        })
        .send()
      return items.map((item) => ({ signature: item.signature, slot: item.slot }))
    },
    async transaction(signature) {
      return chain.rpc
        .getTransaction(toSignature(signature), {
          encoding: 'json',
          // Version 1 transactions already run on devnet and reach this program
          // through CPI; asking for 0 turns each of them into an RPC error.
          maxSupportedTransactionVersion: 1,
          commitment: 'confirmed',
        })
        .send()
    },
  }

  /**
   * Until `T039` stores them, events go to the log — one line each, so a
   * Railway log search is already a readable feed.
   */
  async function logSink(decoded: DecodedTransaction): Promise<void> {
    for (const event of decoded.events) log.info({ event: jsonSafe(event) }, 'event')
    if (decoded.events.length === 0) {
      log.debug({ signature: decoded.signature, failed: decoded.failed }, 'no permission events')
    }
  }

  const controller = new AbortController()
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.once(name, () => {
      log.info({ signal: name }, 'stopping')
      controller.abort()
    })
  }

  log.info({ cluster: chain.cluster, program }, 'starting')
  await runIndexer({ source, sink: logSink, log, signal: controller.signal, program })
}

if (!config.useWs) {
  // `process.exitCode`, not `process.exit()`: the worker stops by running out of work.
  log.fatal('INDEXER_USE_WS=false asks for the polling fallback, which is T045 and not built yet')
  process.exitCode = 1
} else {
  await main()
}
