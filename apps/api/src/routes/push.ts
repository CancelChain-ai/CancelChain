import type { SendOutcome } from '@cancelchain/push'
import {
  okResponseSchema,
  type PushKeyResponse,
  type PushSubscribeBody,
  type PushUnsubscribeBody,
  pushKeyResponseSchema,
  pushSubscribeBodySchema,
  pushUnsubscribeBodySchema,
} from '@cancelchain/shared'
import { type Context, type Env, Hono } from 'hono'
import { fail } from '../errors.js'
import type { AppEnv } from '../types.js'
import { validate } from '../validate.js'

/**
 * Web Push subscriptions (`T043`, `FR-018`).
 *
 * **No wallet signature.** Every other read here is open because the data is
 * public on the chain, and a push carries nothing else: a stranger who follows
 * someone's wallet learns what any explorer shows, and the wallet's owner gets
 * nothing from it — the push goes to the stranger's browser. What does need a
 * guard is the endpoint: the server sends requests to it, so it must belong to
 * a browser push service (`pushEndpointSchema`), and it must be live — a
 * welcome push goes out before the row is written, and a push service that
 * refuses it gets the subscription refused.
 *
 * **Push off is an installation, not an error** (`FR-027`). Without VAPID keys
 * `deps` is absent: `/v1/push/key` says `enabled: false` and the page offers no
 * switch; the two writes answer `404` with `reason: push_disabled`.
 */
export type PushDeps = {
  publicKey: string
  /** The same browser already follows the same wallet with the same keys. */
  has(subscription: PushSubscribeBody): Promise<boolean>
  /** Insert, or replace the keys of, the (endpoint, owner) row. */
  save(subscription: PushSubscribeBody): Promise<void>
  /** Rows removed. */
  remove(request: PushUnsubscribeBody): Promise<number>
  /** The welcome push — proof the endpoint is live and the keys are the browser's. */
  probe(subscription: PushSubscribeBody): Promise<SendOutcome>
}

export function pushRoute(deps: PushDeps | undefined): Hono<AppEnv> {
  return new Hono<AppEnv>()
    .get('/v1/push/key', (c) => {
      const body: PushKeyResponse =
        deps === undefined ? { enabled: false } : { enabled: true, publicKey: deps.publicKey }
      return c.json(pushKeyResponseSchema.parse(body))
    })
    .post('/v1/push/subscribe', validate('json', pushSubscribeBodySchema), async (c) => {
      if (deps === undefined) return disabled(c)
      const subscription = c.req.valid('json')
      // Idempotent: a page that subscribes again on every visit does not buzz
      // the phone on every visit.
      if (await deps.has(subscription)) return c.json(okResponseSchema.parse({ ok: true }))

      const outcome = await deps.probe(subscription)
      const logger = c.get('logger')
      switch (outcome.state) {
        case 'delivered':
          await deps.save(subscription)
          logger?.info({ owner: subscription.owner }, 'push subscription saved')
          return c.json(okResponseSchema.parse({ ok: true }))
        case 'gone':
        case 'refused':
          logger?.warn(
            { owner: subscription.owner, outcome },
            'push service refused the welcome push',
          )
          return fail(c, 'INVALID_INPUT', 'the browser push service refused this subscription', {
            reason: 'push_service_refused',
            status: outcome.status,
          })
        case 'unreachable':
          logger?.error({ owner: subscription.owner, outcome }, 'push service unreachable')
          return fail(c, 'INTERNAL', 'the browser push service could not be reached', {
            reason: 'push_service_unreachable',
          })
      }
    })
    .delete('/v1/push/subscribe', validate('json', pushUnsubscribeBodySchema), async (c) => {
      if (deps === undefined) return disabled(c)
      const removed = await deps.remove(c.req.valid('json'))
      c.get('logger')?.info({ removed }, 'push subscription removed')
      return c.json(okResponseSchema.parse({ ok: true }))
    })
}

function disabled<E extends Env, P extends string>(c: Context<E, P>) {
  return fail(c, 'NOT_FOUND', 'push notifications are not set up on this server', {
    reason: 'push_disabled',
  })
}
