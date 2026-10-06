import type { Address, PushSubscribeBody, PushUnsubscribeBody } from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { ApiRequestError, ApiUnreachableError, type PushApi } from './api'
import {
  type BrowserPush,
  createPushController,
  type FollowedWallets,
  fromBase64url,
  PushFailure,
  type PushSubscriptionLike,
  storedFollowedWallets,
  toBase64url,
} from './push'

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR' as Address
const OTHER = 'FGHMNoNNq3aMvTxrfeNRzS6SwE7SKZp6UyZ7FMjjf3nk' as Address
const KEY =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
const ROTATED =
  'BJUEmb65cIdmtTv5AEa41wHzRk0NOWQyu8WEBoDs4m_9sUeHN9dsAEP_zovRAHbvwZWc_tFSriTNA0NciFv6r6c'
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/browser'

/** A browser's subscription made under `key`. */
function subscription(key = KEY, endpoint = ENDPOINT) {
  const state = { unsubscribed: false }
  const value: PushSubscriptionLike = {
    endpoint,
    options: { applicationServerKey: fromBase64url(key).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'BKey', auth: 'auth' } }),
    unsubscribe: async () => {
      state.unsubscribed = true
      return true
    },
  }
  return { value, state }
}

/** A browser whose answers the test sets, and what the controller asked of it. */
function browser(options: {
  permission?: 'default' | 'granted' | 'denied'
  answer?: 'default' | 'granted' | 'denied'
  held?: PushSubscriptionLike | null
  supported?: boolean
  subscribeFails?: DOMException
}) {
  let held = options.held ?? null
  let permission = options.permission ?? 'granted'
  const asked = { permission: 0, subscribe: [] as Uint8Array[] }
  const made = subscription()
  const value: BrowserPush = {
    supported: options.supported ?? true,
    permission: () => permission,
    requestPermission: async () => {
      asked.permission += 1
      permission = options.answer ?? 'granted'
      return permission
    },
    current: async () => held,
    manager: async () => ({
      getSubscription: async () => held,
      subscribe: async ({ applicationServerKey }) => {
        asked.subscribe.push(applicationServerKey)
        if (options.subscribeFails !== undefined) throw options.subscribeFails
        held = made.value
        return made.value
      },
    }),
  }
  return { value, asked }
}

function api(options: { key?: string | null; subscribe?: Error } = {}) {
  const subscribed: PushSubscribeBody[] = []
  const unsubscribed: PushUnsubscribeBody[] = []
  const value: PushApi = {
    getPushKey: async () =>
      options.key === null ? { enabled: false } : { enabled: true, publicKey: options.key ?? KEY },
    subscribePush: async (body) => {
      if (options.subscribe !== undefined) throw options.subscribe
      subscribed.push(body)
    },
    unsubscribePush: async (body) => {
      unsubscribed.push(body)
    },
  }
  return { value, subscribed, unsubscribed }
}

function memory(initial: string[] = []): FollowedWallets & { owners: string[] } {
  const store = {
    owners: [...initial],
    list: () => [...store.owners],
    set: (owners: string[]) => {
      store.owners = [...owners]
    },
  }
  return store
}

const REFUSED = new ApiRequestError(400, 'INVALID_INPUT', 'refused', 'push_service_refused')

describe('status', () => {
  it('names a browser without push, a server without it and a block — before anything else', async () => {
    const followed = memory([OWNER])
    expect(
      await createPushController({
        api: api().value,
        browser: browser({ supported: false }).value,
        followed,
      }).status(OWNER),
    ).toBe('unsupported')
    expect(
      await createPushController({
        api: api({ key: null }).value,
        browser: browser({}).value,
        followed,
      }).status(OWNER),
    ).toBe('disabled')
    expect(
      await createPushController({
        api: api().value,
        browser: browser({ permission: 'denied', held: subscription().value }).value,
        followed,
      }).status(OWNER),
    ).toBe('blocked')
  })

  it('is on only when the browser holds a subscription and follows this wallet', async () => {
    const held = subscription().value
    const server = api()
    const controller = (followed: FollowedWallets, value: PushSubscriptionLike | null) =>
      createPushController({ api: server.value, browser: browser({ held: value }).value, followed })

    expect(await controller(memory([OWNER]), held).status(OWNER)).toBe('on')
    expect(await controller(memory([OTHER]), held).status(OWNER)).toBe('off')
    // A list without a subscription is a stale list, not "on".
    expect(await controller(memory([OWNER]), null).status(OWNER)).toBe('off')
  })

  it('hands the server the same subscription again, so a lost row comes back', async () => {
    const server = api()
    await createPushController({
      api: server.value,
      browser: browser({ held: subscription().value }).value,
      followed: memory([OWNER]),
    }).status(OWNER)
    expect(server.subscribed).toEqual([
      { owner: OWNER, endpoint: ENDPOINT, keys: { p256dh: 'BKey', auth: 'auth' } },
    ])
  })

  it('reads a subscription the push service now refuses as off', async () => {
    const followed = memory([OWNER, OTHER])
    expect(
      await createPushController({
        api: api({ subscribe: REFUSED }).value,
        browser: browser({ held: subscription().value }).value,
        followed,
      }).status(OWNER),
    ).toBe('off')
    expect(followed.owners).toEqual([OTHER])
  })

  it('stays on when the server cannot be reached for that refresh', async () => {
    expect(
      await createPushController({
        api: api({ subscribe: new ApiUnreachableError('/v1/push/subscribe', null) }).value,
        browser: browser({ held: subscription().value }).value,
        followed: memory([OWNER]),
      }).status(OWNER),
    ).toBe('on')
  })

  it('reads a subscription under a key the server no longer signs with as off', async () => {
    const followed = memory([OWNER])
    expect(
      await createPushController({
        api: api({ key: ROTATED }).value,
        browser: browser({ held: subscription(KEY).value }).value,
        followed,
      }).status(OWNER),
    ).toBe('off')
    expect(followed.owners).toEqual([])
  })
})

describe('enable', () => {
  it('asks once, subscribes with the server key and tells the server', async () => {
    const server = api()
    const followed = memory()
    const { value, asked } = browser({ permission: 'default' })
    expect(
      await createPushController({ api: server.value, browser: value, followed }).enable(OWNER),
    ).toBe('on')
    expect(asked.permission).toBe(1)
    expect(asked.subscribe.map((key) => toBase64url(key))).toEqual([KEY])
    expect(server.subscribed.map((body) => body.owner)).toEqual([OWNER])
    expect(followed.owners).toEqual([OWNER])
  })

  it('adds a second wallet on the same subscription', async () => {
    const server = api()
    const followed = memory([OTHER])
    const { value, asked } = browser({ held: subscription().value })
    await createPushController({ api: server.value, browser: value, followed }).enable(OWNER)
    expect(asked.subscribe).toEqual([])
    expect(followed.owners).toEqual([OTHER, OWNER])
  })

  it('replaces a subscription made under an old key', async () => {
    const server = api({ key: ROTATED })
    const old = subscription(KEY, 'https://fcm.googleapis.com/fcm/send/old')
    const { value, asked } = browser({ held: old.value })
    await createPushController({
      api: server.value,
      browser: value,
      followed: memory([OTHER]),
    }).enable(OWNER)
    expect(old.state.unsubscribed).toBe(true)
    expect(server.unsubscribed).toEqual([{ endpoint: 'https://fcm.googleapis.com/fcm/send/old' }])
    expect(asked.subscribe.map((key) => toBase64url(key))).toEqual([ROTATED])
  })

  it.each([
    ['said no', 'denied', 'blocked'],
    ['closed the prompt', 'default', 'off'],
  ] as const)('subscribes nothing when the person %s', async (_, answer, expected) => {
    const server = api()
    const { value, asked } = browser({ permission: 'default', answer })
    expect(
      await createPushController({ api: server.value, browser: value, followed: memory() }).enable(
        OWNER,
      ),
    ).toBe(expected)
    expect(asked.subscribe).toEqual([])
    expect(server.subscribed).toEqual([])
  })

  it('says disabled when the server sends no push', async () => {
    const { value, asked } = browser({})
    expect(
      await createPushController({
        api: api({ key: null }).value,
        browser: value,
        followed: memory(),
      }).enable(OWNER),
    ).toBe('disabled')
    expect(asked.subscribe).toEqual([])
  })

  it('names a refusal of the push service and keeps the wallet off', async () => {
    const followed = memory()
    const failure = await createPushController({
      api: api({ subscribe: REFUSED }).value,
      browser: browser({}).value,
      followed,
    })
      .enable(OWNER)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PushFailure)
    expect((failure as PushFailure).message).toMatch(/push service refused/)
    expect((failure as PushFailure).message).toMatch(/in the feed/)
    expect(followed.owners).toEqual([])
  })

  it('reads a subscribe the browser refused as blocked', async () => {
    expect(
      await createPushController({
        api: api().value,
        browser: browser({ subscribeFails: new DOMException('no', 'NotAllowedError') }).value,
        followed: memory(),
      }).enable(OWNER),
    ).toBe('blocked')
  })
})

describe('disable', () => {
  it('stops one wallet and keeps the subscription for the others', async () => {
    const server = api()
    const held = subscription()
    const followed = memory([OWNER, OTHER])
    expect(
      await createPushController({
        api: server.value,
        browser: browser({ held: held.value }).value,
        followed,
      }).disable(OWNER),
    ).toBe('off')
    expect(server.unsubscribed).toEqual([{ endpoint: ENDPOINT, owner: OWNER }])
    expect(held.state.unsubscribed).toBe(false)
    expect(followed.owners).toEqual([OTHER])
  })

  it('drops the subscription with the last wallet, and the server forgets the browser', async () => {
    const server = api()
    const held = subscription()
    await createPushController({
      api: server.value,
      browser: browser({ held: held.value }).value,
      followed: memory([OWNER]),
    }).disable(OWNER)
    expect(server.unsubscribed).toEqual([{ endpoint: ENDPOINT }])
    expect(held.state.unsubscribed).toBe(true)
  })
})

describe('storedFollowedWallets', () => {
  it('reads nothing, rather than throwing, where storage is unavailable', () => {
    const followed = storedFollowedWallets(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(followed.list()).toEqual([])
    expect(() => followed.set([OWNER])).not.toThrow()
  })
})

describe('base64url', () => {
  it('round-trips a VAPID key into the bytes the browser subscribes with', () => {
    const bytes = fromBase64url(KEY)
    expect(bytes).toHaveLength(65)
    expect(bytes[0]).toBe(4)
    expect(toBase64url(bytes)).toBe(KEY)
  })
})
