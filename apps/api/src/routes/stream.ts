import {
  STREAM_HEARTBEAT_MS,
  type StreamMessage,
  streamMessageSchema,
  streamQuerySchema,
} from '@cancelchain/shared'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { fail } from '../errors.js'
import type { StreamHub } from '../stream.js'
import type { AppEnv } from '../types.js'
import { validate } from '../validate.js'

/**
 * `GET /v1/stream?owner=…` — SSE of what changes for one wallet (`T042`):
 * `allowance.updated` and `event.appended`, plus `ready` first and `resync`
 * whenever the server may have missed a change. Both of the latter mean "read
 * everything again"; there is no replay by `Last-Event-ID` (`shared/api.ts`).
 *
 * No authentication, as on `/v1/allowances`: a wallet's permissions are public
 * on chain, and the stream carries nothing more than the store already serves.
 *
 * The slot is taken before the response starts, so a full process answers a
 * named `429` rather than a stream that opens and dies.
 */

export type StreamDeps = {
  hub: StreamHub
  /**
   * Marks the wallet as looked at (`T045`, `watched_wallets`): on opening and
   * every `heartbeatMs` after, so the indexer's polling fallback reads it while
   * the page is open.
   * A failed write is logged, not fatal — the stream itself still works.
   */
  watch?: (owner: string) => Promise<void>
  heartbeatMs?: number
  /**
   * Messages waiting for a slow client. Past this the backlog is dropped for a
   * single `resync`: the client reads everything again anyway, and the process
   * does not hold an unbounded queue for a socket that is not draining.
   */
  maxBacklog?: number
}

export const MAX_BACKLOG = 100

/**
 * What waits to be written to one client. Starts with `ready`; past
 * `maxBacklog` everything waiting becomes a single `resync`.
 */
export function createOutbox(maxBacklog: number) {
  let waiting: StreamMessage[] = [{ type: 'ready' }]
  return {
    push(message: StreamMessage): void {
      waiting.push(message)
      if (waiting.length > maxBacklog) waiting = [{ type: 'resync' }]
    },
    /** Everything waiting, oldest first; the outbox is empty afterwards. */
    take(): StreamMessage[] {
      const taken = waiting
      waiting = []
      return taken
    },
    get size() {
      return waiting.length
    },
  }
}

export function streamRoute(deps: StreamDeps): Hono<AppEnv> {
  const heartbeatMs = deps.heartbeatMs ?? STREAM_HEARTBEAT_MS
  const maxBacklog = deps.maxBacklog ?? MAX_BACKLOG

  return new Hono<AppEnv>().get('/v1/stream', validate('query', streamQuerySchema), (c) => {
    const { owner } = c.req.valid('query')
    const logger = c.get('logger')
    const watch = () => {
      deps.watch?.(owner).catch((error: unknown) => {
        logger.warn({ err: error, owner }, 'could not mark the wallet as watched')
      })
    }
    const outbox = createOutbox(maxBacklog)
    let closed = false
    let wake: (() => void) | null = null

    const unsubscribe = deps.hub.subscribe(owner, {
      send(message) {
        outbox.push(message)
        wake?.()
      },
      close() {
        closed = true
        wake?.()
      },
    })
    if (unsubscribe === null) {
      return fail(c, 'RATE_LIMITED', 'this server holds as many streams as it can; try again later')
    }
    watch()

    /** `true` when woken by a message or a close, `false` after a quiet `heartbeatMs`. */
    function nextWake(): Promise<boolean> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve(false)
        }, heartbeatMs)
        wake = () => {
          clearTimeout(timer)
          wake = null
          resolve(true)
        }
      })
    }

    return streamSSE(c, async (stream) => {
      // Its own timer, not the ping: a busy stream never pings, and its wallet
      // must not drop out of the fallback while events keep coming.
      const marking = setInterval(watch, heartbeatMs)
      stream.onAbort(() => {
        closed = true
        wake?.()
      })
      try {
        while (!closed) {
          while (outbox.size > 0 && !closed) {
            for (const message of outbox.take()) {
              const checked = streamMessageSchema.parse(message)
              await stream.writeSSE({ event: checked.type, data: JSON.stringify(checked) })
            }
          }
          if (closed) break
          // A named event, not a comment: `EventSource` never shows comments, and
          // the browser has to see the pulse to tell a quiet stream from a dead one.
          if (!(await nextWake())) outbox.push({ type: 'ping' })
        }
      } finally {
        clearInterval(marking)
        unsubscribe()
      }
    })
  })
}
