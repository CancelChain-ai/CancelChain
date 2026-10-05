import { STREAM_HEARTBEAT_MS, type StreamMessage, streamMessageSchema } from '@cancelchain/shared'

/**
 * The browser end of `/v1/stream` (`T042a`): one `EventSource`, a watchdog over
 * it, and a status the screen can say out loud.
 *
 * `EventSource` reconnects by itself after a dropped connection, and the server
 * answers every new connection with `ready` — "read everything again" — so a
 * reconnect needs nothing from here. Two failures it does not handle:
 *
 * — a half-open connection (a laptop waking up, a phone changing networks): the
 *   socket looks alive and nothing arrives, with no error anywhere. The server
 *   sends `ping` after `STREAM_HEARTBEAT_MS` of quiet, so twice that without a
 *   single message means the stream is dead, and it is reopened;
 * — an answer that is not a stream (`429` from a full server, `5xx`, a proxy's
 *   error page): the browser gives up for good (`readyState` CLOSED). It is
 *   reopened here, with a backoff, and the status says live updates are off
 *   until `ready` comes back.
 */

/** `live` only after `ready`: before it, the server may not be listening for this wallet yet. */
export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'down'

/** The part of `EventSource` used here — narrower, so a test does not fake all of it. */
export interface EventSourceLike {
  readonly readyState: number
  onerror: ((event: Event) => void) | null
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
}

/** `EventSource.CLOSED`: the browser will not reconnect by itself. */
const CLOSED = 2

const MESSAGE_TYPES: readonly StreamMessage['type'][] = [
  'ready',
  'resync',
  'ping',
  'allowance.updated',
  'event.appended',
]

/** No message for this long — not even a `ping` — and the stream is taken for dead. */
export const STREAM_SILENCE_MS = 2 * STREAM_HEARTBEAT_MS

export const STREAM_BACKOFF = { initialMs: 1_000, maxMs: 30_000 }

export type StreamTimers = {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type OpenStreamOptions = {
  url: string
  create: (url: string) => EventSourceLike
  onMessage: (message: StreamMessage) => void
  onStatus: (status: StreamStatus) => void
  silenceMs?: number
  backoff?: { initialMs: number; maxMs: number }
  timers?: StreamTimers
}

const realTimers: StreamTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Opens the stream and keeps it open. The returned function closes it for good. */
export function openStream(options: OpenStreamOptions): () => void {
  const timers = options.timers ?? realTimers
  const silenceMs = options.silenceMs ?? STREAM_SILENCE_MS
  const backoff = options.backoff ?? STREAM_BACKOFF

  let source: EventSourceLike | null = null
  let watchdog: unknown = null
  let retry: unknown = null
  let failures = 0
  let stopped = false
  let status: StreamStatus | null = null

  const report = (next: StreamStatus) => {
    if (next === status) return
    status = next
    options.onStatus(next)
  }

  const clear = (handle: unknown) => {
    if (handle !== null) timers.clearTimeout(handle)
  }

  const arm = () => {
    clear(watchdog)
    watchdog = timers.setTimeout(() => {
      watchdog = null
      source?.close()
      report('reconnecting')
      connect()
    }, silenceMs)
  }

  const deliver = (data: string) => {
    if (stopped) return
    arm()
    let parsed: StreamMessage
    try {
      parsed = streamMessageSchema.parse(JSON.parse(data))
    } catch {
      /*
       * A frame outside the contract: the page and the server disagree on its
       * shape. Dropping it would hide a change; reading everything again goes
       * through the same reads as the rest of the page, and those say plainly
       * when the server answers in a shape this page does not understand.
       */
      parsed = { type: 'resync' }
    }
    if (parsed.type === 'ready') {
      failures = 0
      report('live')
    }
    options.onMessage(parsed)
  }

  function connect() {
    if (stopped) return
    const opened = options.create(options.url)
    source = opened
    for (const type of MESSAGE_TYPES) {
      opened.addEventListener(type, (event) => {
        if (source === opened) deliver(event.data)
      })
    }
    opened.onerror = () => {
      if (source !== opened || stopped) return
      if (opened.readyState !== CLOSED) {
        // The browser is already reconnecting; `ready` will follow it.
        report('reconnecting')
        return
      }
      opened.close()
      clear(watchdog)
      watchdog = null
      report('down')
      const delay = Math.min(backoff.initialMs * 2 ** failures, backoff.maxMs)
      failures++
      retry = timers.setTimeout(() => {
        retry = null
        connect()
      }, delay)
    }
    arm()
  }

  report('connecting')
  connect()

  return () => {
    stopped = true
    clear(watchdog)
    clear(retry)
    source?.close()
    source = null
  }
}
