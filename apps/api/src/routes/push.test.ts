import type { SendOutcome } from '@cancelchain/push'
import {
  apiErrorSchema,
  okResponseSchema,
  type PushSubscribeBody,
  type PushUnsubscribeBody,
  pushKeyResponseSchema,
} from '@cancelchain/shared'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { errorHandler, notFoundHandler } from '../errors.js'
import type { AppEnv } from '../types.js'
import { type PushDeps, pushRoute } from './push.js'

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const PUBLIC_KEY =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
const SUBSCRIPTION: PushSubscribeBody = {
  owner: OWNER,
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'BKey', auth: 'auth' },
}

/** The route plus what reached storage and the push service. */
function app(outcome: SendOutcome = { state: 'delivered', status: 201 }, known = false) {
  const saved: PushSubscribeBody[] = []
  const removed: PushUnsubscribeBody[] = []
  const probed: PushSubscribeBody[] = []
  const deps: PushDeps = {
    publicKey: PUBLIC_KEY,
    has: async () => known,
    save: async (body) => {
      saved.push(body)
    },
    remove: async (body) => {
      removed.push(body)
      return 1
    },
    probe: async (body) => {
      probed.push(body)
      return outcome
    },
  }
  return { app: mount(deps), saved, removed, probed }
}

function mount(deps: PushDeps | undefined) {
  const app = new Hono<AppEnv>()
  app.notFound(notFoundHandler)
  app.onError(errorHandler)
  return app.route('/', pushRoute(deps))
}

function send(target: Hono<AppEnv>, method: 'POST' | 'DELETE', body: unknown) {
  return target.request('/v1/push/subscribe', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('GET /v1/push/key', () => {
  it('hands out the public key when push is on', async () => {
    const res = await app().app.request('/v1/push/key')
    expect(res.status).toBe(200)
    expect(pushKeyResponseSchema.parse(await res.json())).toEqual({
      enabled: true,
      publicKey: PUBLIC_KEY,
    })
  })

  it('says push is off instead of failing (FR-027)', async () => {
    const res = await mount(undefined).request('/v1/push/key')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false })
  })
})

describe('POST /v1/push/subscribe', () => {
  it('sends the welcome push first and keeps the row only after it went through', async () => {
    const { app: target, saved, probed } = app()
    const res = await send(target, 'POST', SUBSCRIPTION)
    expect(res.status).toBe(200)
    expect(okResponseSchema.parse(await res.json())).toEqual({ ok: true })
    expect(probed).toEqual([SUBSCRIPTION])
    expect(saved).toEqual([SUBSCRIPTION])
  })

  it('does not buzz the phone again for a subscription it already has', async () => {
    const { app: target, saved, probed } = app(undefined, true)
    expect((await send(target, 'POST', SUBSCRIPTION)).status).toBe(200)
    expect(probed).toEqual([])
    expect(saved).toEqual([])
  })

  it.each([
    { state: 'gone', status: 410 },
    { state: 'refused', status: 403, detail: 'bad jwt' },
  ] as const)('refuses what the push service refused ($state)', async (outcome) => {
    const { app: target, saved } = app(outcome)
    const res = await send(target, 'POST', SUBSCRIPTION)
    expect(res.status).toBe(400)
    const error = apiErrorSchema.parse(await res.json()).error
    expect(error.code).toBe('INVALID_INPUT')
    expect(error.details).toEqual({ reason: 'push_service_refused', status: outcome.status })
    expect(saved).toEqual([])
  })

  it('names an unreachable push service and keeps nothing', async () => {
    const { app: target, saved } = app({ state: 'unreachable', status: 503, detail: '' })
    const res = await send(target, 'POST', SUBSCRIPTION)
    expect(res.status).toBe(500)
    expect(apiErrorSchema.parse(await res.json()).error.details).toEqual({
      reason: 'push_service_unreachable',
    })
    expect(saved).toEqual([])
  })

  it('never calls an endpoint outside the browser push services', async () => {
    const { app: target, probed } = app()
    const res = await send(target, 'POST', {
      ...SUBSCRIPTION,
      endpoint: 'https://169.254.169.254/latest/meta-data',
    })
    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('INVALID_INPUT')
    expect(probed).toEqual([])
  })

  it('answers 404 push_disabled without VAPID keys', async () => {
    const res = await send(mount(undefined), 'POST', SUBSCRIPTION)
    expect(res.status).toBe(404)
    expect(apiErrorSchema.parse(await res.json()).error.details).toEqual({
      reason: 'push_disabled',
    })
  })
})

describe('DELETE /v1/push/subscribe', () => {
  it('removes one wallet of a browser, or the whole browser', async () => {
    const { app: target, removed } = app()
    const endpoint = SUBSCRIPTION.endpoint
    expect((await send(target, 'DELETE', { endpoint, owner: OWNER })).status).toBe(200)
    expect((await send(target, 'DELETE', { endpoint })).status).toBe(200)
    expect(removed).toEqual([{ endpoint, owner: OWNER }, { endpoint }])
  })

  it('answers 404 push_disabled without VAPID keys', async () => {
    const res = await send(mount(undefined), 'DELETE', { endpoint: SUBSCRIPTION.endpoint })
    expect(res.status).toBe(404)
  })
})
