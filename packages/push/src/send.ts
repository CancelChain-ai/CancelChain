import { isPushServiceEndpoint } from '@cancelchain/shared'
import webpush from 'web-push'
import type { PushMessage } from './messages.js'
import type { VapidConfig } from './vapid.js'

/** One browser's subscription, as `push_subscriptions` keeps it. */
export type PushTarget = {
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * What the push service said, sorted by what the caller does next (`T043`).
 *
 * - `delivered` — accepted; the service delivers when the browser is online.
 * - `gone` — the subscription is dead (`404`/`410`: the person turned
 *   notifications off, cleared the site, the browser rotated it). Forget it:
 *   asking again gets the same answer forever.
 * - `refused` — any other `4xx`. Ours to fix (payload, VAPID), and a retry
 *   gets the same answer, so it is logged and not retried.
 * - `unreachable` — `429`, `5xx`, a timeout, no network. Worth a retry.
 */
export type SendOutcome =
  | { state: 'delivered'; status: number }
  | { state: 'gone'; status: number | null }
  | { state: 'refused'; status: number; detail: string }
  | { state: 'unreachable'; status: number | null; detail: string }

export type SendOptions = {
  /** How long the service keeps the push for a browser that is offline. */
  ttlSeconds: number
  urgency: 'very-low' | 'low' | 'normal' | 'high'
}

export type PushSender = {
  send(target: PushTarget, message: PushMessage, options: SendOptions): Promise<SendOutcome>
}

/** The slice of `fetch` the sender needs — narrower, so a test does not fake all of it. */
export type PushFetch = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: Uint8Array
    signal: AbortSignal
    redirect: 'manual'
  },
) => Promise<{ status: number; text(): Promise<string> }>

export type PushSenderOptions = {
  vapid: VapidConfig
  fetch?: PushFetch
  timeoutMs?: number
}

export const PUSH_TIMEOUT_MS = 10_000

/**
 * `web-push` encrypts and signs (`generateRequestDetails`); the request itself
 * goes through `fetch`. Two reasons not to let the library send: a redirect
 * from the push service is not followed (the endpoint list is the only reason
 * the server may call a URL a browser gave it — a redirect would step around
 * it), and a test sees the real encrypted request without a socket.
 */
export function createPushSender(options: PushSenderOptions): PushSender {
  const fetchImpl: PushFetch = options.fetch ?? ((url, init) => fetch(url, init))
  const timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS

  return {
    async send(target, message, { ttlSeconds, urgency }) {
      // Checked again here, not only at the API: a row may predate the list,
      // and the indexer sends to whatever the table holds.
      if (!isPushServiceEndpoint(target.endpoint)) return { state: 'gone', status: null }

      const details = webpush.generateRequestDetails(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(message),
        {
          vapidDetails: options.vapid,
          TTL: ttlSeconds,
          urgency,
          // RFC 8291. The library's default is the older `aesgcm` draft.
          contentEncoding: 'aes128gcm',
        },
      )
      const headers = Object.fromEntries(
        Object.entries(details.headers).map(([name, value]) => [name, String(value)]),
      )

      let response: { status: number; text(): Promise<string> }
      try {
        response = await fetchImpl(details.endpoint, {
          method: 'POST',
          headers,
          body: new Uint8Array(details.body),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual',
        })
      } catch (error) {
        return {
          state: 'unreachable',
          status: null,
          detail: error instanceof Error ? error.message : String(error),
        }
      }

      const { status } = response
      if (status >= 200 && status < 300) return { state: 'delivered', status }
      if (status === 404 || status === 410) return { state: 'gone', status }
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      if (status === 429 || status >= 500) return { state: 'unreachable', status, detail }
      return { state: 'refused', status, detail }
    },
  }
}
