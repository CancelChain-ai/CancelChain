import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Logger } from './logger.js'

/**
 * Keeps one `LISTEN` on the stream channel alive (`T042`) and says when it may
 * have missed something.
 *
 * postgres.js re-listens by itself whenever the socket **closes** — a stopped
 * server, a refused or timed-out connect (checked live, 2026-10-05). What it
 * cannot see is a connection that stays open and carries nothing: a NAT entry
 * dropped, a pooler that lost its backend without a reset. No close comes, TCP
 * keepalive notices only after minutes, and notifications sent meanwhile are
 * lost without an error anywhere — live, a permission revoked during 25 s of
 * that never reached the stream. So the listener checks itself. Every
 * `probeEveryMs` it sends a probe notification and waits for its own echo; no
 * echo within `probeTimeoutMs` means the subscription is deaf, and it is
 * rebuilt from a new connection.
 *
 * `onListen` fires after every successful `LISTEN`, the first one included:
 * whatever was announced before it was not heard, so the streams must read
 * again (`resync`).
 *
 * Probes from any process are kept away from `onNotice` — two API instances on
 * one database hear each other's.
 */

export type ListenConnection = {
  /** Resolves once `LISTEN` is active; `onListen` fires then and after each re-listen of the driver. */
  listen: (
    channel: string,
    onNotify: (payload: string) => void,
    onListen: () => void,
  ) => Promise<void>
  close: () => Promise<void>
}

export type ListenerDeps = {
  connect: () => ListenConnection
  /** Sends a notification on the channel — through the ordinary pool, not the listening session. */
  notify: (channel: string, payload: string) => Promise<void>
  channel: string
  onNotice: (payload: string) => void
  onListen: () => void
  logger: Logger
  probeEveryMs?: number
  probeTimeoutMs?: number
  retryMs?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export const PROBE_EVERY_MS = 30_000
export const PROBE_TIMEOUT_MS = 10_000
export const RETRY_MS = 5_000

const PROBE_KIND = 'probe'

export class ProbeLostError extends Error {
  constructor(timeoutMs: number) {
    super(`the probe notification did not come back within ${timeoutMs} ms`)
    this.name = 'ProbeLostError'
  }
}

const probeSchema = z.object({ kind: z.literal(PROBE_KIND), nonce: z.string() })

function probeNonce(payload: string): string | null {
  if (!payload.includes(PROBE_KIND)) return null
  try {
    const parsed = probeSchema.safeParse(JSON.parse(payload))
    return parsed.success ? parsed.data.nonce : null
  } catch {
    return null
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

export function startListener(deps: ListenerDeps): { stop: () => Promise<void> } {
  const probeEveryMs = deps.probeEveryMs ?? PROBE_EVERY_MS
  const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  const retryMs = deps.retryMs ?? RETRY_MS
  const sleep = deps.sleep ?? abortableSleep
  const stopping = new AbortController()
  const { signal } = stopping

  async function session(): Promise<void> {
    const connection = deps.connect()
    let echo: { nonce: string; arrived: () => void } | null = null
    try {
      await connection.listen(
        deps.channel,
        (payload) => {
          const nonce = probeNonce(payload)
          if (nonce === null) deps.onNotice(payload)
          else if (echo !== null && nonce === echo.nonce) echo.arrived()
        },
        deps.onListen,
      )
      deps.logger.info({ channel: deps.channel }, 'listening for stream notifications')

      while (!signal.aborted) {
        await sleep(probeEveryMs, signal)
        if (signal.aborted) break
        const nonce = randomUUID()
        const arrived = new Promise<void>((resolve) => {
          echo = { nonce, arrived: resolve }
        })
        const expired = new AbortController()
        const lost = sleep(probeTimeoutMs, AbortSignal.any([signal, expired.signal])).then(() => {
          throw new ProbeLostError(probeTimeoutMs)
        })
        try {
          await deps.notify(deps.channel, JSON.stringify({ kind: PROBE_KIND, nonce }))
          await Promise.race([arrived, lost])
        } finally {
          expired.abort()
          lost.catch(() => {})
          echo = null
        }
      }
    } finally {
      await connection.close().catch(() => {})
    }
  }

  const running = (async () => {
    while (!signal.aborted) {
      try {
        await session()
      } catch (error) {
        if (signal.aborted) break
        deps.logger.error(
          { err: error, channel: deps.channel },
          'stream listener lost; reconnecting',
        )
      }
      if (!signal.aborted) await sleep(retryMs, signal)
    }
  })()

  return {
    stop: async () => {
      stopping.abort()
      await running
    },
  }
}
