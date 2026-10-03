import { createChainClient, readAllowance } from '@cancelchain/chain'
import { signature as toSignature } from '@solana/kit'
import { drizzle } from 'drizzle-orm/postgres-js'
import { pino } from 'pino'
import postgres from 'postgres'
import type { DecodedTransaction } from './decode.js'
import { indexerConfigFromEnv } from './env.js'
import { createStore } from './store.js'
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

  // `prepare: false`: the transaction pooler hands the connection to another
  // client between transactions, and a prepared statement does not survive that.
  // One connection: writes are sequential, and the free tier's are shared with the API.
  const sql = postgres(config.databaseUrl, { prepare: false, max: 1, connect_timeout: 10 })
  const store = createStore({
    db: drizzle(sql),
    // `confirmed`, as the notifications: at `finalized` the account would read
    // ~13 s older than the transaction that just changed it.
    readAllowance: (pda) => readAllowance(chain, { pda, commitment: 'confirmed' }),
    log,
  })

  async function sink(decoded: DecodedTransaction): Promise<void> {
    const result = await store.write(decoded)
    for (const event of decoded.events) log.info({ event: jsonSafe(event) }, 'event')
    log.debug({ signature: decoded.signature, ...result }, 'stored')
  }

  const controller = new AbortController()
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.once(name, () => {
      log.info({ signal: name }, 'stopping')
      controller.abort()
    })
  }

  // Refusals stored before their code was mapped get their category now.
  await store.backfillReasons()

  // Without a cursor the indexer starts at the program's newest transaction;
  // with one, it catches up from where the last run stopped.
  const resumeFrom = (await store.cursor()) ?? undefined
  log.info(
    { cluster: chain.cluster, program, resumeFrom: resumeFrom?.signature ?? null },
    'starting',
  )
  try {
    await runIndexer({ source, sink, log, signal: controller.signal, program, resumeFrom })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (!config.useWs) {
  // `process.exitCode`, not `process.exit()`: the worker stops by running out of work.
  log.fatal('INDEXER_USE_WS=false asks for the polling fallback, which is T045 and not built yet')
  process.exitCode = 1
} else {
  await main()
}
