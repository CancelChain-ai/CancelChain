import { readFileSync } from 'node:fs'
import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import type { DecodedTransaction, TransactionRecord } from './decode.js'
import {
  CATCH_UP_MAX_PAGES,
  CATCH_UP_PAGE,
  type IndexerSource,
  type LogNotification,
  READ_ATTEMPTS,
  reconnectDelayMs,
  runIndexer,
  type SignatureInfo,
  TRANSACTION_FETCH_ATTEMPTS,
} from './subscribe.js'

function fixture(name: string): TransactionRecord {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/devnet/${name}.json`, import.meta.url), 'utf8'),
  )
}

const TXS = [
  'subscribe',
  'cancel-subscription',
  'charge-recurring',
  'reject-over-cap',
  'reject-after-close',
].map(fixture)
const INFO: SignatureInfo[] = TXS.map((tx) => ({
  signature: tx.transaction.signatures[0] as string,
  slot: BigInt(tx.slot),
}))
const [SUBSCRIBE, CANCEL, CHARGE, REJECT, LATER] = INFO as [
  SignatureInfo,
  SignatureInfo,
  SignatureInfo,
  SignatureInfo,
  SignatureInfo,
]
const BY_SIGNATURE = new Map(TXS.map((tx) => [tx.transaction.signatures[0] as string, tx]))

type Connection = {
  items: LogNotification[]
  after: 'drop' | 'hold'
  /** The node never opens this socket: `logs()` neither resolves nor rejects. */
  neverOpens?: boolean
  /** Transactions that land while this socket is open but are never delivered on it. */
  unseen?: SignatureInfo[]
}

/**
 * A scripted node: each `logs()` call is the next connection. `drop` ends the
 * socket with an error after its items; `hold` keeps it open until aborted —
 * the test aborts once the sink has seen what it waits for.
 *
 * `history` is what had landed before the indexer started. A transaction
 * joins it when it lands: when the stream delivers it, or — for `unseen` — when
 * the socket drops. Handing the whole future to `getSignaturesForAddress` up
 * front would let the catch-up see transactions that have not happened yet.
 */
function scriptedSource(input: {
  connections: Connection[]
  history?: SignatureInfo[]
  /** How many times `getTransaction` answers `null` before the node has it. */
  notYet?: Map<string, number>
  /** How many times `getTransaction` throws for a signature (`Infinity` — always). */
  throwing?: Map<string, number>
  /** What it throws; by default an error about the transaction itself. */
  error?: () => Error
}): IndexerSource & { calls: { logs: number; transaction: string[]; signaturesSince: number } } {
  const calls = { logs: 0, transaction: [] as string[], signaturesSince: 0 }
  const history = [...(input.history ?? [])]
  return {
    calls,
    async logs(signal) {
      const connection = input.connections[calls.logs++]
      if (connection === undefined) throw new Error('no more connections')
      if (connection.neverOpens) return new Promise(() => {})
      const land = (item: SignatureInfo) => {
        if (!history.some((known) => known.signature === item.signature)) history.push(item)
      }
      return (async function* () {
        for (const item of connection.items) {
          land(item)
          yield item
        }
        for (const item of connection.unseen ?? []) land(item)
        if (connection.after === 'drop') throw new Error('socket closed')
        if (signal.aborted) return
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      })()
    },
    async signaturesSince({ until, before, limit }) {
      calls.signaturesSince++
      // Newest first, like the node.
      const newestFirst = [...history].reverse()
      const stop =
        until === undefined ? -1 : newestFirst.findIndex((item) => item.signature === until)
      const newer = stop === -1 ? newestFirst : newestFirst.slice(0, stop)
      const start = before === undefined ? 0 : newer.findIndex((i) => i.signature === before) + 1
      return newer.slice(start, start + limit)
    },
    async transaction(signature) {
      calls.transaction.push(signature)
      const throws = input.throwing?.get(signature) ?? 0
      if (throws > 0) {
        input.throwing?.set(signature, throws - 1)
        throw (
          input.error?.() ??
          new Error('Transaction version (1) is not supported by the requesting client')
        )
      }
      const left = input.notYet?.get(signature) ?? 0
      if (left > 0) {
        input.notYet?.set(signature, left - 1)
        return null
      }
      return BY_SIGNATURE.get(signature) ?? null
    },
  }
}

function recordingLog() {
  const lines: { level: string; message: string; object: object }[] = []
  const at = (level: string) => (object: object, message: string) => {
    lines.push({ level, message, object })
  }
  return { lines, info: at('info'), warn: at('warn'), error: at('error') }
}

/** Runs the loop until `done(sunk)` holds, then stops it. */
async function runUntil(
  source: IndexerSource,
  done: (sunk: DecodedTransaction[]) => boolean,
  extra: {
    resumeFrom?: SignatureInfo
    sink?: (d: DecodedTransaction) => Promise<void>
    subscribeTimeoutMs?: number
    onLive?: (live: boolean) => void
  } = {},
) {
  const controller = new AbortController()
  const sunk: DecodedTransaction[] = []
  const sleeps: number[] = []
  const log = recordingLog()
  const finished = runIndexer({
    source,
    log,
    signal: controller.signal,
    resumeFrom: extra.resumeFrom,
    subscribeTimeoutMs: extra.subscribeTimeoutMs,
    onLive: extra.onLive,
    // Yields to the event loop, so a loop that never stops still lets the test time out.
    sleep: async (ms) => {
      sleeps.push(ms)
      await new Promise((resolve) => setImmediate(resolve))
    },
    sink: async (decoded) => {
      await extra.sink?.(decoded)
      sunk.push(decoded)
      if (done(sunk)) controller.abort()
    },
  })
  await finished
  return { sunk, sleeps, log }
}

describe('runIndexer', () => {
  it('decodes each live notification in order', async () => {
    const source = scriptedSource({ connections: [{ items: [SUBSCRIBE, CANCEL], after: 'hold' }] })
    const { sunk } = await runUntil(source, (s) => s.length === 2)
    expect(sunk.map((d) => d.events.map((e) => e.kind))).toEqual([['created'], ['cancelled']])
  })

  it('waits for a transaction the node does not serve yet', async () => {
    const source = scriptedSource({
      connections: [{ items: [CHARGE], after: 'hold' }],
      notYet: new Map([[CHARGE.signature, 3]]),
    })
    const { sunk, sleeps } = await runUntil(source, (s) => s.length === 1)
    expect(sunk[0]?.events[0]?.kind).toBe('charged')
    expect(source.calls.transaction).toHaveLength(4)
    expect(sleeps).toEqual([500, 500, 500])
  })

  it('names a transaction that never appears, and moves on', async () => {
    const source = scriptedSource({
      connections: [{ items: [CHARGE, CANCEL], after: 'hold' }],
      notYet: new Map([[CHARGE.signature, TRANSACTION_FETCH_ATTEMPTS]]),
    })
    const { sunk, log } = await runUntil(source, (s) => s.length === 1)
    expect(sunk[0]?.signature).toBe(CANCEL.signature)
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'transaction not served by the node — not indexed',
        object: expect.objectContaining({ signature: CHARGE.signature }),
      }),
    )
  })

  it('after a dropped socket, replays what it missed oldest first, then goes live', async () => {
    const source = scriptedSource({
      connections: [
        { items: [SUBSCRIBE], unseen: [CANCEL, CHARGE, REJECT], after: 'drop' },
        // The new stream repeats REJECT, which the catch-up also returns; LATER is genuinely new.
        { items: [REJECT, LATER], after: 'hold' },
      ],
    })
    const { sunk, sleeps, log } = await runUntil(source, (s) =>
      s.some((d) => d.signature === LATER.signature),
    )
    expect(sunk.map((d) => d.signature)).toEqual([
      SUBSCRIBE.signature,
      CANCEL.signature,
      CHARGE.signature,
      REJECT.signature,
      LATER.signature,
    ])
    expect(sleeps).toEqual([1_000])
    expect(log.lines).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'subscription failed' }),
    )
    // REJECT came twice (catch-up and live) and was fetched once.
    expect(source.calls.transaction.filter((s) => s === REJECT.signature)).toHaveLength(1)
  })

  it('is live only once catch-up is done, and not live from the moment the socket drops', async () => {
    const source = scriptedSource({
      connections: [
        { items: [SUBSCRIBE], unseen: [CANCEL, CHARGE], after: 'drop' },
        { items: [LATER], after: 'hold' },
      ],
    })
    let live = false
    const transitions: boolean[] = []
    const liveWhenSunk = new Map<string, boolean>()
    await runUntil(source, (s) => s.some((d) => d.signature === LATER.signature), {
      onLive: (next) => {
        live = next
        transitions.push(next)
      },
      sink: async (decoded) => {
        liveWhenSunk.set(decoded.signature, live)
      },
    })
    expect(transitions).toEqual([true, false, true, false])
    // Caught-up transactions arrive before the indexer vouches for the present.
    expect(liveWhenSunk.get(CANCEL.signature)).toBe(false)
    expect(liveWhenSunk.get(CHARGE.signature)).toBe(false)
    expect(liveWhenSunk.get(LATER.signature)).toBe(true)
  })

  it('a drop before any transaction was seen still catches up — from the start', async () => {
    // What happened live on 2026-09-30: a 429 closed the socket nine minutes in,
    // with no program transaction seen yet.
    const source = scriptedSource({
      connections: [
        { items: [], unseen: [CANCEL], after: 'drop' },
        { items: [], after: 'hold' },
      ],
      // Landed before the indexer started: history, not this run's business.
      history: [SUBSCRIBE],
    })
    const { sunk } = await runUntil(source, (s) => s.length === 1)
    expect(sunk.map((d) => d.signature)).toEqual([CANCEL.signature])
  })

  it('resumes from a stored cursor on the very first connection', async () => {
    const source = scriptedSource({
      connections: [{ items: [], after: 'hold' }],
      history: [SUBSCRIBE, CANCEL, CHARGE],
    })
    const { sunk } = await runUntil(source, (s) => s.length === 2, { resumeFrom: SUBSCRIBE })
    expect(sunk.map((d) => d.signature)).toEqual([CANCEL.signature, CHARGE.signature])
  })

  it('a sink that fails gets the same transaction again — nothing is skipped past it', async () => {
    let failOnce = true
    const source = scriptedSource({
      connections: [
        { items: [SUBSCRIBE, CANCEL], after: 'hold' },
        { items: [], after: 'hold' },
      ],
    })
    const { sunk } = await runUntil(
      source,
      (s) => s.some((d) => d.signature === CANCEL.signature),
      {
        sink: async (decoded) => {
          if (decoded.signature === CANCEL.signature && failOnce) {
            failOnce = false
            throw new Error('database unavailable')
          }
        },
      },
    )
    expect(sunk.map((d) => d.signature)).toEqual([SUBSCRIBE.signature, CANCEL.signature])
    expect(source.calls.logs).toBe(2)
  })

  it('a transaction that cannot be read is retried, then skipped loudly — never a wedge', async () => {
    const source = scriptedSource({
      connections: [
        { items: [], after: 'hold' },
        { items: [], after: 'hold' },
        { items: [], after: 'hold' },
      ],
      history: [SUBSCRIBE, CHARGE, CANCEL],
      throwing: new Map([[CHARGE.signature, Number.POSITIVE_INFINITY]]),
    })
    const { sunk, log } = await runUntil(source, (s) => s.length === 1, { resumeFrom: SUBSCRIBE })
    expect(sunk.map((d) => d.signature)).toEqual([CANCEL.signature])
    expect(source.calls.logs).toBe(READ_ATTEMPTS)
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'transaction could not be read — not indexed',
        object: expect.objectContaining({ signature: CHARGE.signature, attempts: READ_ATTEMPTS }),
      }),
    )
  })

  it('a transaction that failed to read once is read on the next pass', async () => {
    const source = scriptedSource({
      connections: [
        { items: [], after: 'hold' },
        { items: [], after: 'hold' },
      ],
      history: [SUBSCRIBE, CHARGE, CANCEL],
      throwing: new Map([[CHARGE.signature, 1]]),
    })
    const { sunk } = await runUntil(source, (s) => s.length === 2, { resumeFrom: SUBSCRIBE })
    expect(sunk.map((d) => d.signature)).toEqual([CHARGE.signature, CANCEL.signature])
  })

  it('a rate-limited node is not a broken transaction: retried until it answers', async () => {
    const rateLimited = () =>
      new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
        headers: new Headers(),
        message: '',
        statusCode: 429,
      })
    const source = scriptedSource({
      connections: Array.from({ length: READ_ATTEMPTS + 3 }, () => ({
        items: [],
        after: 'hold' as const,
      })),
      history: [SUBSCRIBE, CHARGE, CANCEL],
      throwing: new Map([[CHARGE.signature, READ_ATTEMPTS + 2]]),
      error: rateLimited,
    })
    const { sunk, log } = await runUntil(source, (s) => s.length === 2, { resumeFrom: SUBSCRIBE })
    expect(sunk.map((d) => d.signature)).toEqual([CHARGE.signature, CANCEL.signature])
    expect(log.lines.filter((line) => line.level === 'error')).toEqual([])
  })

  it('progress during catch-up ends a run of failures — the backoff starts over', async () => {
    const failOnce = new Set([CHARGE.signature, CANCEL.signature])
    const source = scriptedSource({
      connections: [
        { items: [], after: 'hold' },
        { items: [], after: 'hold' },
        { items: [], after: 'hold' },
      ],
      history: [SUBSCRIBE, CHARGE, CANCEL, REJECT],
    })
    const { sunk, sleeps } = await runUntil(source, (s) => s.length === 3, {
      resumeFrom: SUBSCRIBE,
      sink: async (decoded) => {
        if (failOnce.delete(decoded.signature)) throw new Error('rate limited')
      },
    })
    expect(sunk.map((d) => d.signature)).toEqual([
      CHARGE.signature,
      CANCEL.signature,
      REJECT.signature,
    ])
    // CHARGE stored before CANCEL failed: the second failure is a first again.
    expect(sleeps).toEqual([reconnectDelayMs(1), reconnectDelayMs(1)])
  })

  it('a subscription that never opens is given up on, and the next one is tried', async () => {
    const source = scriptedSource({
      connections: [
        { items: [], after: 'hold', neverOpens: true },
        { items: [CHARGE], after: 'hold' },
      ],
    })
    const { sunk, log } = await runUntil(source, (s) => s.length === 1, {
      subscribeTimeoutMs: 20,
    })
    expect(sunk.map((d) => d.signature)).toEqual([CHARGE.signature])
    expect(source.calls.logs).toBe(2)
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'subscription failed',
        object: expect.objectContaining({ error: 'subscription did not open within 20 ms' }),
      }),
    )
  })

  it('a gap larger than catch-up allows is reported, not silently cut', async () => {
    const filler: SignatureInfo[] = Array.from(
      { length: CATCH_UP_PAGE * CATCH_UP_MAX_PAGES + 1 },
      (_, i) => ({ signature: `missing-${i}`, slot: BigInt(i + 1) }),
    )
    const source = scriptedSource({
      connections: [{ items: [CANCEL], after: 'hold' }],
      history: [SUBSCRIBE, ...filler],
    })
    const controller = new AbortController()
    const log = recordingLog()
    await runIndexer({
      source: {
        ...source,
        // Only the catch-up bookkeeping matters here; fetching 10 001 transactions does not.
        transaction: async (signature) =>
          signature === CANCEL.signature ? fixture('cancel-subscription') : null,
      },
      log,
      signal: controller.signal,
      resumeFrom: SUBSCRIBE,
      sleep: async () => {},
      sink: async (decoded) => {
        if (decoded.signature === CANCEL.signature) controller.abort()
      },
    })
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'gap too large for catch-up — history between these points is not indexed',
      }),
    )
  })
})

describe('reconnectDelayMs', () => {
  it('doubles from one second and stops at thirty', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(reconnectDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ])
  })
})
