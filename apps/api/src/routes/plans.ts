import { NotAPlanError, PlanNotFoundError, type PlanSnapshot } from '@cancelchain/chain'
import type { Address, ChainPlan, Plan, PlanCatalog, PlanSubscriber } from '@cancelchain/shared'
import {
  fromU64,
  getPlanParamsSchema,
  getPlanQuerySchema,
  getPlanViewResponseSchema,
  periodSecondsFromHours,
  planTermsDivergence,
  planTermsOf,
} from '@cancelchain/shared'
import { Hono } from 'hono'
import { fail } from '../errors.js'
import type { AppEnv } from '../types.js'
import { validate } from '../validate.js'

/**
 * `GET /v1/plans/:pda` — the plan behind the subscribe screen (`T036`, `FR-008`).
 *
 * The chain decides whether there is a plan at all: a catalog row without a plan
 * account is `404`, because a subscription to it cannot exist. The catalog only
 * adds what the merchant said (the name, and the terms as they were when the
 * merchant named the plan), and it is allowed to be missing or unreachable — the
 * screen still has everything a subscription is built from.
 *
 * Public, no token: the person opening a subscribe link is the subscriber, not
 * the merchant, and every field here is either public on-chain or meant to be
 * shown to exactly that person.
 */

export type PlansDeps = {
  /** Throws `PlanNotFoundError` / `NotAPlanError`; the route tells them apart. */
  plan: (pda: Address) => Promise<PlanSnapshot>
  /** `null` — no row. Throws when storage cannot be reached. */
  catalog: (pda: Address) => Promise<Plan | null>
  subscriber: (input: { subscriber: Address; plan: PlanSnapshot }) => Promise<PlanSubscriber>
  /** The settlement mint (`USDC_MINT`). Same meaning as in `routes/allowances.ts`. */
  settlementMint: Address
  now?: () => Date
}

export function chainPlanFrom(snapshot: PlanSnapshot): ChainPlan {
  return {
    pda: snapshot.pda,
    merchant: snapshot.owner,
    planId: fromU64(snapshot.planId),
    mint: snapshot.mint,
    amount: fromU64(snapshot.amount),
    periodSeconds: periodSecondsFromHours(snapshot.periodHours),
    createdAt: snapshot.createdAt,
    status: snapshot.status,
    endsAt: snapshot.endsAt,
    destinations: snapshot.destinations,
    pullers: snapshot.pullers,
  }
}

export function plansRoute(deps: PlansDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date())

  return new Hono<AppEnv>().get(
    '/v1/plans/:pda',
    validate('param', getPlanParamsSchema),
    validate('query', getPlanQuerySchema),
    async (c) => {
      const { pda } = c.req.valid('param')
      const { subscriber } = c.req.valid('query')

      let snapshot: PlanSnapshot
      try {
        snapshot = await deps.plan(pda)
      } catch (error) {
        if (error instanceof PlanNotFoundError || error instanceof NotAPlanError) {
          c.get('logger')?.warn({ pda, err: error }, 'no plan at this address')
          return fail(c, 'NOT_FOUND', 'there is no plan at this address')
        }
        throw error
      }
      const chain = chainPlanFrom(snapshot)

      /*
       * Storage down is not "the merchant never named it". The two are kept
       * apart all the way to the screen, which says "could not check" for one
       * and "nothing to compare with" for the other.
       */
      let catalog: PlanCatalog
      try {
        const row = await deps.catalog(pda)
        catalog = row === null ? { state: 'unnamed' } : { state: 'named', plan: row }
      } catch (error) {
        c.get('logger')?.warn({ pda, err: error }, 'plan catalog unavailable')
        catalog = { state: 'unavailable' }
      }

      const diverged =
        catalog.state === 'named' ? planTermsDivergence(planTermsOf(catalog.plan), chain) : []
      if (diverged.length > 0) {
        c.get('logger')?.warn({ pda, diverged }, 'plan catalog diverges from the chain')
      }

      return c.json(
        getPlanViewResponseSchema.parse({
          chain,
          catalog,
          diverged,
          assetSupported: snapshot.mint === deps.settlementMint,
          subscriber:
            subscriber === undefined ? null : await deps.subscriber({ subscriber, plan: snapshot }),
          syncedAt: now().toISOString(),
        }),
      )
    },
  )
}
