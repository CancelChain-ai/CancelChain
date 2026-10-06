import { createChainClient, readAllowance } from '@cancelchain/chain'
import { createPushSender, vapidFromEnv } from '@cancelchain/push'
import { signature as toSignature } from '@solana/kit'
import { drizzle } from 'drizzle-orm/postgres-js'
import { pino } from 'pino'
import postgres from 'postgres'
import type { DecodedTransaction } from './decode.js'
import { indexerConfigFromEnv } from './env.js'
import { createNotifier, type Notifier, UPCOMING_SCAN_INTERVAL_MS } from './notify.js'
import { createStore } from './store.js'
import { type IndexerSource, jsonSafe, runIndexer } from './subscribe.js'

/** Half of `EVENTS_STALE_AFTER_MS`: one missed beat does not yet read as stale. */
const HEARTBEAT_INTERVAL_MS = 15_000

/**
 * Worker entry point: read the environment, build the kit-backed source, run
 * the loop until SIGINT/SIGTERM. The logic lives in `subscribe.ts` and
 * `decode.ts`, which are tested without a socket.
 */

const config = indexerConfigFromEnv(process.env)
// Throws on a half-set VAPID trio; none at all is push off (`T043`, `FR-027`).
const vapid = vapidFromEnv(process.env)
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
  const db = drizzle(sql)
  const store = createStore({
    db,
    // `confirmed`, as the notifications: at `finalized` the account would read
    // ~13 s older than the transaction that just changed it.
    readAllowance: (pda) => readAllowance(chain, { pda, commitment: 'confirmed' }),
    log,
  })

  // Push (`T043`): without VAPID keys nothing is sent, and nothing else changes.
  const notifier: Notifier | null =
    vapid === null
      ? null
      : createNotifier({
          db,
          sender: createPushSender({ vapid }),
          refresh: (pdas) => store.refresh(pdas),
          usdcMint: chain.usdcMint,
          log,
          leadMs: config.pushUpcomingLeadHours * 60 * 60 * 1000,
        })
  if (notifier === null) {
    log.warn({}, 'push is off: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT are not set')
  }
  // A failed pass is a warning, not a reason to stop indexing: the next one
  // finds whatever this one did not send.
  const notify = () => {
    notifier?.run().catch((error: unknown) => {
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'push pass failed',
      )
    })
  }

  async function sink(decoded: DecodedTransaction): Promise<void> {
    const result = await store.write(decoded)
    for (const event of decoded.events) log.info({ event: jsonSafe(event) }, 'event')
    log.debug({ signature: decoded.signature, ...result }, 'stored')
    // A refusal goes out as soon as it is stored, not at the next scan.
    if (result.inserted > 0) notify()
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
  // The heartbeat runs only while the indexer would see a charge right now;
  // a failed write is a warning, not a reason to stop indexing.
  let live = false
  const beat = () => {
    if (!live) return
    store.heartbeat().catch((error: unknown) => {
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'heartbeat failed',
      )
    })
  }
  const pulse = setInterval(beat, HEARTBEAT_INTERVAL_MS)
  // Charges due have no transaction to react to: they are looked for.
  const scan = notifier === null ? null : setInterval(notify, UPCOMING_SCAN_INTERVAL_MS)
  notify()
  const onLive = (next: boolean) => {
    live = next
    beat()
  }
  try {
    await runIndexer({ source, sink, log, signal: controller.signal, program, resumeFrom, onLive })
  } finally {
    clearInterval(pulse)
    if (scan !== null) clearInterval(scan)
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
