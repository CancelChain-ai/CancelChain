import { type Address, isSolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from '@solana/kit'
import { type DecodedTransaction, decodeTransaction, type TransactionRecord } from './decode.js'

/**
 * The indexer loop: `logsSubscribe(mentions = programId)` → signature →
 * `getTransaction` → `decodeTransaction` → sink.
 *
 * The notification alone is not enough: the program writes no events to its
 * logs (see `events.ts` in `packages/chain`), so a notification says only
 * "the program ran, here is the signature, it failed or not". Every
 * notification costs one `getTransaction`.
 *
 * **A dropped socket must not be a silent gap** (`SC-013`). After every
 * reconnect the loop first asks `getSignaturesForAddress(program, until = last
 * seen)` and replays what it missed, oldest first, before reading live
 * notifications again. The subscription is opened *before* that catch-up, so a
 * transaction landing in between is either in the catch-up or in the buffered
 * stream — possibly in both, which the recent-signature set and, from `T039`,
 * the database's unique key absorb.
 *
 * **A socket that dies without closing must not be one either** (`T045`). kit
 * does not throw when the node stops sending, so while live the same catch-up
 * also runs on a timer (`SWEEP_INTERVAL_MS`). What it finds is indexed at once —
 * the loss is bounded by one interval — and a transaction the sweep found that
 * the stream still has not delivered one interval later means the stream is
 * dead: the connection is dropped and opened again.
 */

export type LogNotification = {
  signature: string
  slot: bigint
}

export type SignatureInfo = {
  signature: string
  slot: bigint
}

/** Where the loop reads from. The kit-backed version lives in `index.ts`; tests pass their own. */
export type IndexerSource = {
  /** Live notifications. The iterable ends or throws when the socket goes away. */
  logs(signal: AbortSignal): Promise<AsyncIterable<LogNotification>>
  /**
   * Newest first, at most `limit`; strictly newer than `until` and older than
   * `before` when given.
   */
  signaturesSince(input: {
    until?: string
    before?: string
    limit: number
  }): Promise<readonly SignatureInfo[]>
  /** `null` while the node does not have it yet. */
  transaction(signature: string): Promise<TransactionRecord | null>
}

export type IndexerLog = {
  info(object: object, message: string): void
  warn(object: object, message: string): void
  error(object: object, message: string): void
}

export type RunIndexerOptions = {
  source: IndexerSource
  /** Receives every decoded transaction, including ones without events. Throwing = retry via catch-up. */
  sink: (decoded: DecodedTransaction) => Promise<void>
  log: IndexerLog
  signal: AbortSignal
  program?: Address
  /** Last transaction already stored — from `T039` on, the persisted cursor. */
  resumeFrom?: SignatureInfo
  sleep?: (ms: number) => Promise<void>
  /** How long opening a subscription may take before the attempt counts as failed. */
  subscribeTimeoutMs?: number
  /**
   * `true` once the subscription is open and catch-up is done — from then on
   * every new transaction reaches the sink; `false` when that stops. Drives the
   * heartbeat (`T041`): a live indexer is one that would see a charge now.
   */
  onLive?: (live: boolean) => void
  /** How often the live loop checks the stream against the node's history; `0` turns the sweep off. */
  sweepIntervalMs?: number
}

/** Reconnect delay: 1 s, 2 s, 4 s … capped at 30 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1))
}

/**
 * A confirmed notification can arrive before the same node serves the
 * transaction. Ten tries half a second apart; after that the signature is
 * reported as not indexed rather than waited on forever.
 */
export const TRANSACTION_FETCH_ATTEMPTS = 10
export const TRANSACTION_FETCH_INTERVAL_MS = 500

/**
 * A transaction whose fetch or decode throws is retried through reconnect and
 * catch-up — a network blip must not cost an event. The same failure this many
 * times is deterministic (a transaction version the request does not accept, a
 * layout the decoder cannot read): it is logged as not indexed and the loop
 * moves on, instead of reconnecting on it forever with everything behind it stuck.
 */
export const READ_ATTEMPTS = 3

/**
 * Seen on devnet (`T039`): after a run of 429s, kit's `subscribe()` sometimes
 * neither opens the socket nor rejects — the worker then sits idle with no
 * connection and no log line, looking healthy. Opening gets a deadline.
 */
export const SUBSCRIBE_TIMEOUT_MS = 15_000

export class SubscribeTimeoutError extends Error {
  constructor(ms: number) {
    super(`subscription did not open within ${ms} ms`)
    this.name = 'SubscribeTimeoutError'
  }
}

/** `opening`, or a rejection after `ms` that also aborts the attempt. */
async function withDeadline<T>(
  opening: Promise<T>,
  ms: number,
  connection: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      connection.abort()
      reject(new SubscribeTimeoutError(ms))
    }, ms)
  })
  try {
    return await Promise.race([opening, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The watchdog's period. The same 15 s as the polling fallback: a transaction
 * the stream dropped still reaches the feed inside `SC-006`'s 30 s. One
 * `getSignaturesForAddress` per sweep when nothing happened — about 5 800 a day.
 */
export const SWEEP_INTERVAL_MS = 15_000

/** One page of `getSignaturesForAddress` — the node's own maximum. */
export const CATCH_UP_PAGE = 1_000

/**
 * Catch-up stops after this many pages and says so. Past ten thousand missed
 * transactions the gap is an outage to look at, not something to grind through
 * one `getTransaction` at a time on a free RPC plan.
 */
export const CATCH_UP_MAX_PAGES = 10

/** Signatures handled recently, so the overlap of catch-up and the live stream is not processed twice. */
class RecentSignatures {
  private readonly order: string[] = []
  private readonly set = new Set<string>()

  constructor(private readonly capacity: number) {}

  has(signature: string): boolean {
    return this.set.has(signature)
  }

  add(signature: string): void {
    if (this.set.has(signature)) return
    this.set.add(signature)
    this.order.push(signature)
    if (this.order.length > this.capacity) {
      const oldest = this.order.shift()
      if (oldest !== undefined) this.set.delete(oldest)
    }
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type ReadResult = { status: 'decoded'; decoded: DecodedTransaction } | { status: 'skipped' }

/**
 * Fetch and decode one transaction — the part that can fail the same way every
 * time for one transaction. Shared by the log loop and the polling fallback
 * (`poll.ts`), so both give up on the same transactions for the same reasons.
 */
export function createTransactionReader(options: {
  source: Pick<IndexerSource, 'transaction'>
  log: IndexerLog
  sleep?: (ms: number) => Promise<void>
  program?: Address
}): (item: SignatureInfo) => Promise<ReadResult> {
  const { source, log } = options
  const sleep = options.sleep ?? defaultSleep
  const readFailures = new Map<string, number>()

  async function fetchTransaction(signature: string): Promise<TransactionRecord | null> {
    for (let attempt = 1; attempt <= TRANSACTION_FETCH_ATTEMPTS; attempt++) {
      const tx = await source.transaction(signature)
      if (tx !== null) return tx
      if (attempt < TRANSACTION_FETCH_ATTEMPTS) await sleep(TRANSACTION_FETCH_INTERVAL_MS)
    }
    return null
  }

  return async function read(item: SignatureInfo): Promise<ReadResult> {
    try {
      const tx = await fetchTransaction(item.signature)
      if (tx === null) {
        readFailures.delete(item.signature)
        log.error(
          { signature: item.signature, slot: item.slot.toString() },
          'transaction not served by the node — not indexed',
        )
        return { status: 'skipped' }
      }
      const decoded = await decodeTransaction(tx, options.program)
      readFailures.delete(item.signature)
      return { status: 'decoded', decoded }
    } catch (error) {
      // The node refusing us (429, 5xx) says nothing about this transaction.
      // Counting it would skip a readable transaction for good once a cursor
      // moves past it — seen on devnet: a rate-limited catch-up dropped one.
      if (isTransportError(error)) throw error
      const count = (readFailures.get(item.signature) ?? 0) + 1
      readFailures.set(item.signature, count)
      if (count < READ_ATTEMPTS) throw error
      readFailures.delete(item.signature)
      log.error(
        {
          signature: item.signature,
          slot: item.slot.toString(),
          attempts: count,
          error: error instanceof Error ? error.message : String(error),
        },
        'transaction could not be read — not indexed',
      )
      return { status: 'skipped' }
    }
  }
}

/**
 * Runs tasks one at a time, in the order they were queued. The stream and the
 * sweep both hand transactions to the sink, and the cursor must see them in turn.
 */
function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.catch(() => {})
    return run
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * The stream's items until it ends or `signal` aborts. A socket that died
 * silently never settles its pending read; without the race, dropping the
 * connection would not get the loop out of it.
 */
async function* untilAborted<T>(stream: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]()
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    const done = () => resolve({ done: true, value: undefined })
    if (signal.aborted) done()
    else signal.addEventListener('abort', done, { once: true })
  })
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done === true) return
      yield next.value
    }
  } finally {
    // Not awaited: a dead socket's iterator may never answer `return()` either.
    iterator.return?.()?.catch(() => {})
  }
}

export async function runIndexer(options: RunIndexerOptions): Promise<void> {
  const { source, sink, log, signal } = options
  const sleep = options.sleep ?? defaultSleep
  const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS
  const recent = new RecentSignatures(5_000)
  let last: SignatureInfo | null = options.resumeFrom ?? null
  let failures = 0
  let live = false
  const read = createTransactionReader({
    source,
    log,
    sleep,
    ...(options.program === undefined ? {} : { program: options.program }),
  })
  const serial = serialQueue()
  /** Found by a sweep and not yet delivered by the stream: signature → when found. */
  const sweptOnly = new Map<string, number>()

  async function handle(item: SignatureInfo): Promise<void> {
    if (recent.has(item.signature)) return
    const result = await read(item)
    if (result.status === 'decoded') {
      const { decoded } = result
      for (const problem of decoded.problems) {
        log.error({ signature: decoded.signature, problem: jsonSafe(problem) }, 'decode problem')
      }
      // A failing sink is retried without limit: skipping past it would lose
      // an event that was read fine, just because the database was away.
      await sink(decoded)
    }
    recent.add(item.signature)
    if (last === null || item.slot >= last.slot) last = item
    // Progress, not only a live notification, ends a run of failures: a
    // catch-up that advances between rate limits must not back off to 30 s.
    failures = 0
  }

  /**
   * Replays what landed after `from`, oldest first. A sweep hears, through
   * `found`, every item nothing had handled before, and logs only when there
   * were some — it runs every 15 s.
   */
  async function catchUp(
    from: SignatureInfo,
    sweep?: { found: (item: SignatureInfo) => void },
  ): Promise<void> {
    const missed: SignatureInfo[] = []
    let before: string | undefined
    for (let page = 0; page < CATCH_UP_MAX_PAGES; page++) {
      const batch = await source.signaturesSince({
        until: from.signature,
        before,
        limit: CATCH_UP_PAGE,
      })
      missed.push(...batch)
      if (batch.length < CATCH_UP_PAGE) {
        before = undefined
        break
      }
      before = batch[batch.length - 1]?.signature
    }
    if (before !== undefined) {
      // More pages remain: the oldest part of the gap is left unindexed, and loudly.
      log.error(
        {
          from: from.signature,
          fromSlot: from.slot.toString(),
          indexedFrom: before,
          pages: CATCH_UP_MAX_PAGES,
        },
        'gap too large for catch-up — history between these points is not indexed',
      )
    }
    if (sweep === undefined) {
      log.info({ from: from.signature, missed: missed.length }, 'catching up')
    } else {
      const found = missed.filter((item) => !recent.has(item.signature)).length
      if (found > 0) log.info({ from: from.signature, found }, 'sweep found transactions')
    }
    for (const item of missed.reverse()) {
      if (signal.aborted) return
      if (sweep !== undefined && !recent.has(item.signature)) sweep.found(item)
      await handle(item)
    }
  }

  /**
   * The watchdog of one live connection. Each interval it first looks at what
   * earlier sweeps found: anything the stream has not delivered a whole
   * interval later means the stream stopped, and the connection is dropped.
   * Then it sweeps again. A failed sweep is a warning; the next one retries.
   */
  async function watch(connection: AbortController): Promise<void> {
    sweptOnly.clear()
    while (!connection.signal.aborted) {
      await pause(sweepIntervalMs, connection.signal)
      if (connection.signal.aborted) return
      const overdue = [...sweptOnly].filter(([, at]) => Date.now() - at >= sweepIntervalMs)
      if (overdue.length > 0) {
        log.warn(
          { missed: overdue.map(([signature]) => signature), last: last?.signature ?? null },
          'stream missed transactions the sweep found — reconnecting',
        )
        connection.abort()
        return
      }
      const from = last
      if (from === null) continue
      try {
        await serial(() =>
          catchUp(from, { found: (item) => sweptOnly.set(item.signature, Date.now()) }),
        )
      } catch (error) {
        if (connection.signal.aborted) return
        log.warn(
          {
            last: last?.signature ?? null,
            error: error instanceof Error ? error.message : String(error),
          },
          'sweep failed',
        )
      }
    }
  }

  while (!signal.aborted) {
    // One controller per connection: leaving the loop for any reason closes this
    // subscription, instead of leaving it open until the whole worker stops.
    const connection = new AbortController()
    const stop = () => connection.abort()
    signal.addEventListener('abort', stop, { once: true })
    try {
      if (last === null) {
        // Nothing seen yet means nothing to catch up from after a drop. The
        // program's newest transaction becomes the anchor, taken *before*
        // subscribing: everything the stream delivers is then newer than it,
        // and the catch-up below covers the moment between the two calls.
        const [newest] = await source.signaturesSince({ limit: 1 })
        last = newest ?? null
        log.info({ anchor: last?.signature ?? null }, 'anchored')
      }
      const stream = await withDeadline(
        source.logs(connection.signal),
        options.subscribeTimeoutMs ?? SUBSCRIBE_TIMEOUT_MS,
        connection,
      )
      log.info({ resumeFrom: last?.signature ?? null }, 'subscribed')
      if (last !== null) {
        const from = last
        await serial(() => catchUp(from))
      }
      if (signal.aborted) break
      live = true
      options.onLive?.(true)
      const watchdog = sweepIntervalMs > 0 ? watch(connection) : Promise.resolve()
      try {
        for await (const notification of untilAborted(stream, connection.signal)) {
          failures = 0
          sweptOnly.delete(notification.signature)
          await serial(() => handle(notification))
          if (signal.aborted) break
        }
      } finally {
        connection.abort()
        await watchdog
      }
      if (!signal.aborted) log.warn({ last: last?.signature ?? null }, 'subscription ended')
    } catch (error) {
      if (signal.aborted) break
      log.warn(
        {
          last: last?.signature ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
        'subscription failed',
      )
    } finally {
      signal.removeEventListener('abort', stop)
      connection.abort()
      if (live) {
        live = false
        options.onLive?.(false)
      }
    }
    if (signal.aborted) break
    failures++
    await sleep(reconnectDelayMs(failures))
  }
  log.info({ last: last?.signature ?? null }, 'stopped')
}

/** An HTTP-level refusal of the node (rate limit, outage) — not a fault of what was asked for. */
export function isTransportError(error: unknown): boolean {
  return isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)
}

/** Logs and JSON cannot carry `bigint`; `JSON.stringify` throws on it. */
export function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, inner: unknown) =>
      typeof inner === 'bigint' ? inner.toString() : inner,
    ),
  )
}
