import { z } from 'zod'

/**
 * Where a browser's push subscription may point (`T043`).
 *
 * The endpoint comes from the request body and the server then sends HTTPS
 * requests to it — with no list, `POST /v1/push/subscribe` would be a way to make
 * our API and indexer call any URL at all, internal ones included. Every browser
 * that has Web Push hands out an endpoint on its vendor's push service, so the
 * list is short and closed: a browser outside it gets a named refusal, and every
 * function of the product works without push anyway (`FR-027`).
 *
 * An exact host, or `.suffix` for a vendor that spreads endpoints over many hosts.
 */
export const PUSH_SERVICE_HOSTS = [
  // Chrome, Opera, Samsung Internet, Brave and other Chromium browsers.
  'fcm.googleapis.com',
  // Firefox.
  'updates.push.services.mozilla.com',
  // Safari on macOS, and iOS from 16.4 for a web app added to the home screen.
  'web.push.apple.com',
  // Edge (`wns2-par02p.notify.windows.com` and the like).
  '.notify.windows.com',
] as const

export function isPushServiceEndpoint(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  // Credentials or an explicit port would be ours to invent, not a browser's.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return false
  }
  const host = url.hostname.toLowerCase()
  return PUSH_SERVICE_HOSTS.some((entry) =>
    entry.startsWith('.') ? host.endsWith(entry) && host.length > entry.length : host === entry,
  )
}

/** Push services hand out endpoints well under this; a longer one is not a browser's. */
export const MAX_PUSH_ENDPOINT_LENGTH = 1024

export const pushEndpointSchema = z
  .string()
  .max(MAX_PUSH_ENDPOINT_LENGTH)
  .refine(isPushServiceEndpoint, 'expected an https endpoint of a browser push service')

/** The browser's keys come base64url-encoded (`PushSubscription.toJSON()`). */
const base64urlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'expected base64url')
  .max(256)

export const pushKeysSchema = z.object({
  /** The browser's P-256 public key: what the payload is encrypted to. */
  p256dh: base64urlSchema,
  /** The 16-byte authentication secret of the subscription. */
  auth: base64urlSchema,
})
