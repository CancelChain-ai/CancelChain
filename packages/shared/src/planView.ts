import { z } from 'zod'
import { type Plan, planSchema } from './allowance.js'
import { addressSchema, timestampSchema, u64Schema } from './primitives.js'

/**
 * `GET /v1/plans/:pda` — the plan behind the subscribe screen (`T036`, `FR-008`).
 *
 * Three sources, and the response keeps them apart instead of merging them:
 *
 * - `chain` — the plan account as the program stores it. This is what a
 *   subscription transaction is built from, and the only one the program
 *   checks.
 * - `catalog` — our off-chain row: the name, plus the terms as they were read
 *   from the chain when the merchant named the plan (`T035`). That is "what the
 *   merchant asked for" on the screen.
 * - `subscriber` — the connected wallet's side, only when `?subscriber=` is given:
 *   its authority for the plan's mint and whether it is already subscribed.
 *
 * The public read sits under `/v1/plans`, not `/v1/merchants`: everything under
 * `/v1/merchants` needs a merchant token, and the person opening a subscribe
 * link is not a merchant.
 */

/** Terms the catalog and the transaction are compared on. The name is not a term. */
export const PLAN_TERM_FIELDS = ['mint', 'amount', 'periodSeconds', 'createdAt'] as const
export type PlanTermField = (typeof PLAN_TERM_FIELDS)[number]
export const planTermFieldSchema = z.enum(PLAN_TERM_FIELDS)

export type PlanTerms = {
  mint: string
  amount: string
  periodSeconds: number
  /** `null` — the chain account carries no creation time. */
  createdAt: string | null
}

/**
 * Fields where `actual` is not what `asked` says. Empty — they agree.
 *
 * One function for both sides: the API compares the catalog with the chain, the
 * screen compares the catalog with the decoded transaction. Two comparisons
 * written separately would sooner or later disagree about what "the same" means
 * (a timestamp with and without milliseconds, an amount with a leading zero).
 */
export function planTermsDivergence(asked: PlanTerms, actual: PlanTerms): PlanTermField[] {
  return PLAN_TERM_FIELDS.filter((field) => {
    if (field === 'createdAt') return sameInstant(asked.createdAt, actual.createdAt) === false
    if (field === 'amount') return BigInt(asked.amount) !== BigInt(actual.amount)
    return asked[field] !== actual[field]
  })
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return Date.parse(a) === Date.parse(b)
}

/** The catalog row's terms. */
export function planTermsOf(plan: Plan): PlanTerms {
  return {
    mint: plan.mint,
    amount: plan.amount,
    periodSeconds: plan.periodSeconds,
    createdAt: plan.createdAt,
  }
}

export const getPlanParamsSchema = z.object({
  pda: addressSchema,
})

export const getPlanQuerySchema = z.object({
  subscriber: addressSchema.optional(),
})

export const chainPlanSchema = z.object({
  pda: addressSchema,
  merchant: addressSchema,
  planId: u64Schema,
  mint: addressSchema,
  /** Per period, in the mint's smallest unit. */
  amount: u64Schema,
  periodSeconds: z.number().int().positive(),
  createdAt: timestampSchema.nullable(),
  /** `sunset` — the merchant is winding the plan down; no new subscribers. */
  status: z.enum(['active', 'sunset']),
  /** Can be moved earlier by the merchant after anyone subscribes. */
  endsAt: timestampSchema.nullable(),
  /** Where charges may go. Fixed at creation. */
  destinations: z.array(addressSchema),
  /** Who may charge. The merchant can change this list at any time. */
  pullers: z.array(addressSchema),
})

export type ChainPlan = z.infer<typeof chainPlanSchema>

/**
 * `unavailable` is not `unnamed`. Storage being down says nothing about whether
 * the merchant named the plan, and the screen must not show "the merchant asked
 * for nothing" when the truth is "we could not look".
 */
export const planCatalogSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('named'), plan: planSchema }),
  z.object({ state: z.literal('unnamed') }),
  z.object({ state: z.literal('unavailable') }),
])

export type PlanCatalog = z.infer<typeof planCatalogSchema>

export const planSubscriberSchema = z.object({
  address: addressSchema,
  /** The wallet's authority account for the plan's mint. */
  authority: addressSchema,
  /** `null` — the authority does not exist yet; the subscription creates it. */
  authorityInitId: u64Schema.nullable(),
  /** Owner program of the plan's mint — needed only to create the authority. */
  tokenProgram: addressSchema,
  /** The wallet's token account for the plan's mint. */
  tokenAccount: addressSchema,
  /**
   * Without it the authority cannot be created, and the program's answer
   * (`InvalidTokenSplTokenAccountData`) would tell the person nothing.
   */
  tokenAccountExists: z.boolean(),
  /** The subscription account for this wallet and plan. */
  subscription: addressSchema,
  /** An account already exists there: the program would answer `AlreadySubscribed`. */
  subscribed: z.boolean(),
})

export type PlanSubscriber = z.infer<typeof planSubscriberSchema>

export const getPlanViewResponseSchema = z.object({
  chain: chainPlanSchema,
  catalog: planCatalogSchema,
  /** Catalog terms that differ from the chain. Empty unless `catalog.state` is `named`. */
  diverged: z.array(planTermFieldSchema),
  /**
   * The plan's mint is the settlement asset (`FR-020`). `false` — amounts are
   * shown in the mint's smallest units and named as such, not guessed at.
   */
  assetSupported: z.boolean(),
  subscriber: planSubscriberSchema.nullable(),
  syncedAt: timestampSchema,
})

export type PlanView = z.infer<typeof getPlanViewResponseSchema>
