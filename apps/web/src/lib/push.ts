import type { Address } from '@cancelchain/shared'
import { ApiRequestError, ApiUnreachableError, type PushApi } from './api.js'

/**
 * Web Push in this browser (`T043`, `FR-018`, `FR-027`).
 *
 * Everything here is optional by construction: a browser without push, a
 * server without VAPID keys, a person who says no — each is a state the page
 * names, and none of them takes anything else away. Every charge and refusal a
 * push would announce is in the feed regardless.
 *
 * - `unsupported` — no service worker or Push API here (an old browser, a
 *   private window in some, iOS outside a home-screen web app).
 * - `disabled` — this installation sends no push (`GET /v1/push/key`).
 * - `blocked` — the person blocked notifications for the site; only the
 *   browser's settings can undo it, so the page says so instead of a button.
 * - `off` / `on` — for the connected wallet, in this browser.
 */
export type PushStatus = 'unsupported' | 'disabled' | 'blocked' | 'off' | 'on'

type Permission = 'default' | 'granted' | 'denied'

export interface PushSubscriptionLike {
  readonly endpoint: string
  readonly options: { readonly applicationServerKey: ArrayBuffer | null }
  toJSON(): { endpoint?: string; keys?: Record<string, string> }
  unsubscribe(): Promise<boolean>
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>
  subscribe(options: {
    userVisibleOnly: true
    applicationServerKey: Uint8Array<ArrayBuffer>
  }): Promise<PushSubscriptionLike>
}

/** The browser's side, narrowed so a test can be the browser. */
export interface BrowserPush {
  readonly supported: boolean
  permission(): Permission
  requestPermission(): Promise<Permission>
  /** The subscription this browser holds, without registering anything. */
  current(): Promise<PushSubscriptionLike | null>
  /** Registers the service worker (once) and hands over its push manager. */
  manager(): Promise<PushManagerLike>
}

/**
 * Which wallets this browser follows. The server keeps the rows; the browser
 * keeps the list it can show a switch from — and it is checked against the
 * browser's own subscription, so a stale list reads as `off`, never as `on`.
 */
export interface FollowedWallets {
  list(): string[]
  set(owners: string[]): void
}

export class PushFailure extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'PushFailure'
    this.cause = cause
  }
}

export type PushController = {
  status(owner: Address): Promise<PushStatus>
  enable(owner: Address): Promise<PushStatus>
  disable(owner: Address): Promise<PushStatus>
}

export function createPushController(deps: {
  api: PushApi
  browser: BrowserPush
  followed: FollowedWallets
}): PushController {
  const { api, browser, followed } = deps

  /** `null` — push is off on the server; the key otherwise. */
  async function serverKey(): Promise<string | null> {
    const answer = await api.getPushKey()
    return answer.enabled ? answer.publicKey : null
  }

  const without = (owner: string) => followed.list().filter((entry) => entry !== owner)

  async function check(owner: Address): Promise<PushStatus> {
    if (!browser.supported) return 'unsupported'
    const key = await serverKey()
    if (key === null) return 'disabled'
    if (browser.permission() === 'denied') return 'blocked'

    const subscription = await browser.current()
    if (subscription === null || !followed.list().includes(owner)) return 'off'
    // A key the server no longer signs with: every push to this subscription
    // would be refused. Off, until the person turns it on again.
    if (!sameKey(subscription, key)) {
      followed.set([])
      return 'off'
    }
    // The same subscription again — idempotent on the server, no welcome
    // push — so a row the server lost comes back on the next visit.
    try {
      await api.subscribePush(bodyOf(owner, subscription))
    } catch (error) {
      if (error instanceof ApiRequestError && error.reason === 'push_service_refused') {
        followed.set(without(owner))
        return 'off'
      }
      // Unreachable or failing: the browser still holds the subscription,
      // and the next visit asks again.
    }
    return 'on'
  }

  return {
    async status(owner) {
      try {
        return await check(owner)
      } catch (error) {
        throw failure(error)
      }
    },

    async enable(owner) {
      if (!browser.supported) return 'unsupported'
      let permission = browser.permission()
      if (permission === 'default') permission = await browser.requestPermission()
      if (permission === 'denied') return 'blocked'
      if (permission !== 'granted') return 'off'

      const key = await serverKey().catch((error: unknown) => {
        throw failure(error)
      })
      if (key === null) return 'disabled'

      try {
        const manager = await browser.manager()
        let subscription = await manager.getSubscription()
        if (subscription !== null && !sameKey(subscription, key)) {
          // Subscribed under a key the server no longer uses: that endpoint is
          // dead to it, and a new one is made with the current key.
          await api.unsubscribePush({ endpoint: subscription.endpoint }).catch(() => {})
          await subscription.unsubscribe()
          followed.set([])
          subscription = null
        }
        subscription ??= await manager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: fromBase64url(key),
        })
        await api.subscribePush(bodyOf(owner, subscription))
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotAllowedError') return 'blocked'
        throw failure(error)
      }
      followed.set([...without(owner), owner])
      return 'on'
    },

    async disable(owner) {
      const subscription = browser.supported ? await browser.current() : null
      const rest = without(owner)
      if (subscription !== null) {
        if (rest.length === 0) {
          // The last wallet: the browser drops the subscription itself, and the
          // server forgets the endpoint whole. A failed request here is not
          // fatal — a dropped endpoint answers `410`, and the indexer removes it.
          await api.unsubscribePush({ endpoint: subscription.endpoint }).catch(() => {})
          await subscription.unsubscribe()
        } else {
          try {
            await api.unsubscribePush({ endpoint: subscription.endpoint, owner })
          } catch (error) {
            throw failure(error)
          }
        }
      }
      followed.set(rest)
      return 'off'
    },
  }
}

function bodyOf(owner: Address, subscription: PushSubscriptionLike) {
  const { keys } = subscription.toJSON()
  const p256dh = keys?.p256dh
  const auth = keys?.auth
  if (p256dh === undefined || auth === undefined) {
    throw new PushFailure(
      'This browser made a subscription without keys, so nothing could be sent to it.',
    )
  }
  return { owner, endpoint: subscription.endpoint, keys: { p256dh, auth } }
}

function sameKey(subscription: PushSubscriptionLike, key: string): boolean {
  const own = subscription.options.applicationServerKey
  return own !== null && toBase64url(new Uint8Array(own)) === key.replace(/=+$/, '')
}

/** Why turning push on or off did not work — in words, as everything else here. */
function failure(error: unknown): PushFailure {
  if (error instanceof PushFailure) return error
  const tail = 'Nothing else changes: every charge and refusal is in the feed.'
  if (error instanceof ApiRequestError && error.reason === 'push_service_refused') {
    return new PushFailure(`This browser's push service refused the subscription. ${tail}`, error)
  }
  if (error instanceof ApiRequestError && error.reason === 'push_disabled') {
    return new PushFailure(`This server does not send notifications. ${tail}`, error)
  }
  if (error instanceof ApiUnreachableError) {
    return new PushFailure(`We could not reach CancelChain. ${tail}`, error)
  }
  if (error instanceof ApiRequestError && error.reason === 'push_service_unreachable') {
    return new PushFailure(`This browser's push service did not answer. ${tail}`, error)
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new PushFailure(`Notifications could not be changed here (${detail}). ${tail}`, error)
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function toBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const FOLLOWED_KEY = 'cancelchain.push.followed'

/** `localStorage`, and an empty list wherever it is unavailable — never a thrown page. */
export function storedFollowedWallets(
  storage: () => Storage = () => window.localStorage,
): FollowedWallets {
  return {
    list() {
      try {
        const value: unknown = JSON.parse(storage().getItem(FOLLOWED_KEY) ?? '[]')
        return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []
      } catch {
        return []
      }
    },
    set(owners) {
      try {
        storage().setItem(FOLLOWED_KEY, JSON.stringify(owners))
      } catch {
        // Private mode and blocked storage: the switch reads `off` next time.
      }
    },
  }
}

/**
 * The real browser. The worker lives at the root of the page's base path
 * (`public/sw.js`), and its scope is the app: a click on a notification opens
 * the app, not some other page on the same host.
 */
export function windowBrowserPush(base: string): BrowserPush {
  const supported =
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  const scope = base.endsWith('/') ? base : `${base}/`
  return {
    supported,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    async current() {
      const registration = await navigator.serviceWorker.getRegistration(scope)
      return (await registration?.pushManager.getSubscription()) ?? null
    },
    async manager() {
      await navigator.serviceWorker.register(`${scope}sw.js`, { scope })
      const registration = await navigator.serviceWorker.ready
      return registration.pushManager
    },
  }
}
