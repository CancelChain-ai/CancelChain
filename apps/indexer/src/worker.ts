import { createChainClient, readAllowance, readAllowances } from '@cancelchain/chain'
import { createPushSender, type VapidConfig } from '@cancelchain/push'
import { address as toAddress, signature as toSignature } from '@solana/kit'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Logger } from 'pino'
import postgres from 'postgres'
import type { DecodedTransaction } from './decode.js'
import type { IndexerConfig } from './env.js'
import { createNotifier, type Notifier, UPCOMING_SCAN_INTERVAL_MS } from './notify.js'
import { createWalletBook, POLL_HEARTBEAT, runWalletPoller, type WalletSource } from './poll.js'
import { RETENTION_INTERVAL_MS, runRetention } from './retention.js'
import { createStore } from './store.js'
import { type IndexerSource, jsonSafe, runIndexer } from './subscribe.js'

// What a host process needs to start the indexer, from one import.
export { type IndexerConfig, indexerConfigFromEnv } from './env.js'

/** Half of `EVENTS_STALE_AFTER_MS`: one missed beat does not yet read as stale. */
const HEARTBEAT_INTERVAL_MS = 15_000

export type RunningIndexer = {
  /**
   * Settles when the indexer has stopped. `runIndexer` catches every failure
   * and reconnects, so this settles on its own only on something nobody
   * planned for — a host process must treat that as fatal (`T044`).
   */
  done: Promise<void>
  /** Stops listening and closes its database pool. */
  stop(): Promise<void>
}

/**
 * The indexer as a part that can live in any process (`T044`): its own entry
 * (`index.ts`) or inside the API on a single free web service, where
 * `RUN_INDEXER=true` starts it before the server binds. Either way it opens its
 * own one-connection pool, so its writes never wait behind a request.
 *
 * Resolves once the indexer is running: maintenance at start done (refusal
 * categories, the first retention pass), the cursor read, the loop started.
 */
export async function startIndexer(options: {
  config: IndexerConfig
  vapid: VapidConfig | null
  log: Logger
}): Promise<RunningIndexer> {
  const { config, vapid, log } = options

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
    signaturesSince: (page) => signaturesFor(program, page),
    transaction,
  }

  async function signaturesFor(
    address: string,
    { until, before, limit }: { until?: string; before?: string; limit: number },
  ) {
    const items = await chain.rpc
      .getSignaturesForAddress(toAddress(address), {
        until: until === undefined ? undefined : toSignature(until),
        before: before === undefined ? undefined : toSignature(before),
        limit,
        commitment: 'confirmed',
      })
      .send()
    return items.map((item) => ({
      signature: item.signature,
      slot: item.slot,
      blockTime: item.blockTime === null ? null : Number(item.blockTime),
    }))
  }

  async function transaction(signature: string) {
    return chain.rpc
      .getTransaction(toSignature(signature), {
        encoding: 'json',
        // Version 1 transactions already run on devnet and reach this program
        // through CPI; asking for 0 turns each of them into an RPC error.
        maxSupportedTransactionVersion: 1,
        commitment: 'confirmed',
      })
      .send()
  }

  // The fallback (`T045`): the same node calls, by wallet instead of by socket.
  const walletSource: WalletSource = {
    signaturesFor,
    transaction,
    async permissionsOf(owner) {
      const read = await readAllowances(chain, { owner: toAddress(owner), commitment: 'confirmed' })
      return [
        ...read.allowances.map((allowance) => allowance.pda as string),
        ...read.unreadable.map((entry) => entry.address as string),
      ]
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

  const warn = (message: string) => (error: unknown) => {
    log.warn({ error: error instanceof Error ? error.message : String(error) }, message)
  }

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
    notifier?.run().catch(warn('push pass failed'))
  }

  // Retention (`T044`): a failed pass leaves the previous cut recorded, and the
  // page keeps naming what was really done.
  const prune = async () => {
    const result = await runRetention({ db, days: config.eventsRetentionDays })
    log.info({ ...result }, 'retention pass')
  }

  async function sink(decoded: DecodedTransaction): Promise<void> {
    // The fallback reads some wallets, not the program: its writes leave the
    // program's cursor where the log loop left it.
    const result = await store.write(decoded, { programCursor: config.useWs })
    for (const event of decoded.events) log.info({ event: jsonSafe(event) }, 'event')
    log.debug({ signature: decoded.signature, ...result }, 'stored')
    // A refusal goes out as soon as it is stored, not at the next scan.
    if (result.inserted > 0) notify()
  }

  // Refusals stored before their code was mapped get their category now.
  await store.backfillReasons()
  await prune().catch(warn('retention pass failed'))

  // Without a cursor the indexer starts at the program's newest transaction;
  // with one, it catches up from where the last run stopped.
  const resumeFrom = (await store.cursor()) ?? undefined
  log.info(
    {
      cluster: chain.cluster,
      program,
      mode: config.useWs ? 'logs' : 'poll',
      resumeFrom: resumeFrom?.signature ?? null,
      retentionDays: config.eventsRetentionDays,
    },
    'starting',
  )

  // The heartbeat runs only while the indexer would see a charge right now;
  // a failed write is a warning, not a reason to stop indexing.
  let live = false
  const beat = () => {
    if (!live) return
    store.heartbeat().catch(warn('heartbeat failed'))
  }
  // The fallback beats per round instead, under its own name: it is alive, but
  // reading only watched wallets, and `/events` must not take it for the log loop.
  const pulse = config.useWs ? setInterval(beat, HEARTBEAT_INTERVAL_MS) : undefined
  // Charges due have no transaction to react to: they are looked for.
  const scan = notifier === null ? null : setInterval(notify, UPCOMING_SCAN_INTERVAL_MS)
  const daily = setInterval(
    () => void prune().catch(warn('retention pass failed')),
    RETENTION_INTERVAL_MS,
  )
  notify()
  const onLive = (next: boolean) => {
    live = next
    beat()
  }

  const controller = new AbortController()
  const done = (async () => {
    try {
      if (config.useWs) {
        await runIndexer({
          source,
          sink,
          log,
          signal: controller.signal,
          program,
          resumeFrom,
          onLive,
        })
      } else {
        await runWalletPoller({
          source: walletSource,
          book: createWalletBook(db),
          refresh: (pdas) => store.refresh(pdas),
          sink,
          log,
          signal: controller.signal,
          settlementMint: chain.usdcMint,
          retentionDays: config.eventsRetentionDays,
          onRound: () => void store.heartbeat(POLL_HEARTBEAT).catch(warn('heartbeat failed')),
        })
      }
    } finally {
      clearInterval(pulse)
      if (scan !== null) clearInterval(scan)
      clearInterval(daily)
      await sql.end({ timeout: 5 })
    }
  })()

  return {
    done,
    async stop() {
      controller.abort()
      await done.catch(() => {})
    },
  }
}
