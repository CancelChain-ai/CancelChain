import type { Allowance, AllowanceEvent, StreamMessage } from '@cancelchain/shared'
import { z } from 'zod'
import type { Logger } from './logger.js'

/**
 * The fan-out behind `/v1/stream` (`T042`): database notifications in, messages
 * to the open streams of one wallet out.
 *
 * A notification names a row, not its contents (`packages/db/src/stream.ts`).
 * The row is read once per notification and only when its owner has a stream
 * open, then handed to every stream of that owner. Notifications are handled
 * one at a time, in the order they came: two reads racing could otherwise
 * deliver a permission's older state after its newer one.
 *
 * What the hub cannot deliver it says so. A read that fails means those streams
 * missed a change, so they get `resync` — "read everything again" — rather than
 * silence that looks like nothing happened.
 */

const noticeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event'),
    id: z.string().regex(/^\d+$/),
    pda: z.string(),
    owner: z.string().nullable(),
  }),
  z.object({ kind: z.literal('allowance'), pda: z.string(), owner: z.string() }),
  // A watched wallet's feed turned fresh in the polling fallback (`T045`): no
  // row changed, but `stale` did — the wallet's streams read again.
  z.object({ kind: z.literal('wallet'), owner: z.string() }),
])

export type StreamNotice = z.infer<typeof noticeSchema>

export type StreamReaders = {
  /** The stored copy of a permission, in the contract's shape; `null` when there is none. */
  allowance: (pda: string) => Promise<Allowance | null>
  /** One stored event, in the contract's shape; `null` when there is none. */
  event: (id: string) => Promise<AllowanceEvent | null>
}

export type StreamSubscriber = {
  send: (message: StreamMessage) => void
  /** The server is shutting down; the stream should end. */
  close: () => void
}

export type StreamHub = {
  /** `null` when the process already holds `maxStreams` streams. */
  subscribe: (owner: string, subscriber: StreamSubscriber) => (() => void) | null
  /** Queues one raw notification; the promise settles once it is handled. */
  notify: (payload: string) => Promise<void>
  /** The database may have announced changes nobody heard: every stream reads again. */
  resync: () => void
  close: () => void
  size: () => number
}

export type StreamHubDeps = {
  read: StreamReaders
  logger: Logger
  /** Streams per process. Each holds a socket, not a database connection. */
  maxStreams?: number
}

export const DEFAULT_MAX_STREAMS = 1_000

export function createStreamHub(deps: StreamHubDeps): StreamHub {
  const maxStreams = deps.maxStreams ?? DEFAULT_MAX_STREAMS
  const byOwner = new Map<string, Set<StreamSubscriber>>()
  let count = 0
  let queue: Promise<void> = Promise.resolve()

  function deliver(owner: string, message: StreamMessage): void {
    for (const subscriber of byOwner.get(owner) ?? []) subscriber.send(message)
  }

  async function handle(payload: string): Promise<void> {
    let notice: StreamNotice
    try {
      notice = noticeSchema.parse(JSON.parse(payload))
    } catch (error) {
      deps.logger.error({ err: error, payload }, 'stream notification has an unknown shape')
      return
    }
    if (notice.owner === null || !byOwner.has(notice.owner)) return
    const owner = notice.owner

    try {
      if (notice.kind === 'wallet') {
        deliver(owner, { type: 'resync' })
      } else if (notice.kind === 'allowance') {
        const allowance = await deps.read.allowance(notice.pda)
        if (allowance !== null) deliver(owner, { type: 'allowance.updated', allowance })
      } else {
        const event = await deps.read.event(notice.id)
        if (event !== null) {
          deliver(owner, { type: 'event.appended', allowancePda: event.allowancePda, event })
        }
      }
    } catch (error) {
      deps.logger.warn({ err: error, notice }, 'stream could not read a changed row')
      deliver(owner, { type: 'resync' })
    }
  }

  return {
    subscribe(owner, subscriber) {
      if (count >= maxStreams) return null
      let set = byOwner.get(owner)
      if (set === undefined) {
        set = new Set()
        byOwner.set(owner, set)
      }
      set.add(subscriber)
      count += 1
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        count -= 1
        set.delete(subscriber)
        if (set.size === 0 && byOwner.get(owner) === set) byOwner.delete(owner)
      }
    },
    notify(payload) {
      queue = queue.then(() => handle(payload))
      return queue
    },
    resync() {
      // Behind what is already queued: a delivery read before the gap must not
      // land after the signal that says "start over".
      queue = queue.then(() => {
        for (const owner of byOwner.keys()) deliver(owner, { type: 'resync' })
      })
    },
    close() {
      for (const set of byOwner.values()) for (const subscriber of set) subscriber.close()
    },
    size: () => count,
  }
}
