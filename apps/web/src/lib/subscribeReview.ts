import {
  buildSubscribeInstructions,
  readSubscribeBounds,
  type SubscribeBounds,
  type SubscribePlan,
  subscribeBoundsAsPlanTerms,
  toAddress,
} from '@cancelchain/chain'
import type { PlanTermField, PlanTerms, PlanView } from '@cancelchain/shared'
import { periodHoursFromSeconds, planTermsDivergence, planTermsOf } from '@cancelchain/shared'
import type { Instruction } from '@solana/kit'
import { createNoopSigner } from '@solana/kit'
import { type Money, USDC_DECIMALS } from './view.js'

/**
 * The subscribe screen's model (`T036`, `FR-008`).
 *
 * The terms on the screen are read **back out of the built instructions**
 * (`readSubscribeBounds`), not copied from the plan the instructions were built
 * from. If the builder ever put something else into the transaction, the screen
 * would show what is actually there — that is the whole point of `FR-008`.
 *
 * Two comparisons, kept apart:
 *
 * - catalog → transaction: what the merchant listed against what will be signed.
 *   A difference is shown field by field, and the transaction wins: it is what
 *   the program enforces.
 * - chain → transaction: must always be empty. A difference means our own
 *   builder is wrong, and the screen refuses to offer the transaction at all.
 */

export type ReviewBlock =
  /** No wallet: there is no subscriber to build the transaction for. */
  | { reason: 'wallet' }
  | { reason: 'subscribed'; subscription: string }
  | { reason: 'no-token-account'; tokenAccount: string }
  | { reason: 'sunset' }
  | { reason: 'ended'; endedAt: Date }
  | { reason: 'no-created-at' }
  /** The built transaction does not match the plan on the network: our bug, never signed. */
  | { reason: 'builder-mismatch'; fields: PlanTermField[] }

export type ReviewTerms = {
  perPeriod: Money
  periodSeconds: number
  mint: string
  /** The plan's identity: a plan re-created under the same address has another one. */
  createdAt: Date | null
}

export type SubscribeTransaction = {
  instructions: Instruction[]
  bounds: SubscribeBounds
  /** The authority for this token is created by this same transaction. */
  initsAuthority: boolean
  /** The account the subscription will live at — known before signing. */
  subscription: string
}

export type SubscribeReview = {
  plan: string
  merchant: string
  /** The merchant's name for the plan. `null` — not named, or the catalog is unreachable. */
  name: string | null
  catalog: PlanView['catalog']['state']
  /**
   * The terms on the screen. From the transaction when there is one; from the
   * plan on the network only when no transaction could be built (`blocked`).
   */
  terms: ReviewTerms
  termsSource: 'transaction' | 'network'
  /** Catalog fields that differ from `terms`. Empty unless the catalog is `named`. */
  mismatch: PlanTermField[]
  /** The catalog's terms, when there is a catalog row. */
  listed: ReviewTerms | null
  /** Not in the transaction. The merchant can change these after anyone subscribes. */
  pullers: string[]
  endsAt: Date | null
  /** Not in the transaction either, but fixed when the plan was created. */
  destinations: string[]
  transaction: SubscribeTransaction | null
  blocked: ReviewBlock | null
  syncedAt: Date
}

function money(amount: bigint, supported: boolean, mint: string): Money {
  return supported
    ? { amount, decimals: USDC_DECIMALS, label: 'USDC' }
    : { amount, decimals: null, label: `${mint.slice(0, 4)}…${mint.slice(-4)}` }
}

function termsFrom(terms: PlanTerms, supported: boolean): ReviewTerms {
  return {
    perPeriod: money(BigInt(terms.amount), supported, terms.mint),
    periodSeconds: terms.periodSeconds,
    mint: terms.mint,
    createdAt: terms.createdAt === null ? null : new Date(terms.createdAt),
  }
}

function planFrom(view: PlanView): SubscribePlan {
  const { chain } = view
  return {
    pda: toAddress(chain.pda),
    owner: toAddress(chain.merchant),
    planId: BigInt(chain.planId),
    mint: toAddress(chain.mint),
    amount: BigInt(chain.amount),
    periodHours: periodHoursFromSeconds(chain.periodSeconds),
    createdAt: chain.createdAt,
    status: chain.status,
    endsAt: chain.endsAt,
  }
}

/** Why no transaction can be offered, checked in the order a person would want to hear it. */
function blockFor(view: PlanView, now: Date): ReviewBlock | null {
  const { chain, subscriber } = view
  if (chain.status === 'sunset') return { reason: 'sunset' }
  if (chain.endsAt !== null && Date.parse(chain.endsAt) <= now.getTime()) {
    return { reason: 'ended', endedAt: new Date(chain.endsAt) }
  }
  if (chain.createdAt === null) return { reason: 'no-created-at' }
  if (subscriber === null) return { reason: 'wallet' }
  if (subscriber.subscribed) return { reason: 'subscribed', subscription: subscriber.subscription }
  // The token account is only needed when the authority is created here.
  if (subscriber.authorityInitId === null && !subscriber.tokenAccountExists) {
    return { reason: 'no-token-account', tokenAccount: subscriber.tokenAccount }
  }
  return null
}

async function buildFor(view: PlanView, now: Date): Promise<SubscribeTransaction> {
  const subscriber = view.subscriber
  if (subscriber === null) throw new Error('a transaction needs a subscriber')
  const signer = createNoopSigner(toAddress(subscriber.address))
  const plan = planFrom(view)
  const instructions = await buildSubscribeInstructions(
    subscriber.authorityInitId === null
      ? {
          plan,
          subscriber: signer,
          now,
          authorityInitId: 'same-transaction',
          initAuthority: {
            tokenProgram: subscriber.tokenProgram,
            userAta: subscriber.tokenAccount,
          },
        }
      : { plan, subscriber: signer, now, authorityInitId: BigInt(subscriber.authorityInitId) },
  )
  const bounds = readSubscribeBounds(instructions)
  return {
    instructions,
    bounds,
    initsAuthority: bounds.initsAuthority,
    subscription: bounds.subscription,
  }
}

export async function reviewSubscription(
  view: PlanView,
  now: Date = new Date(),
): Promise<SubscribeReview> {
  const chainTerms: PlanTerms = {
    mint: view.chain.mint,
    amount: view.chain.amount,
    periodSeconds: view.chain.periodSeconds,
    createdAt: view.chain.createdAt,
  }

  let blocked = blockFor(view, now)
  let transaction: SubscribeTransaction | null = null
  let shown: PlanTerms = chainTerms

  if (blocked === null) {
    const built = await buildFor(view, now)
    const signed = subscribeBoundsAsPlanTerms(built.bounds)
    const drift = planTermsDivergence(chainTerms, signed)
    if (drift.length > 0) {
      blocked = { reason: 'builder-mismatch', fields: drift }
    } else {
      transaction = built
      shown = signed
    }
  }

  const listedPlan = view.catalog.state === 'named' ? view.catalog.plan : null
  return {
    plan: view.chain.pda,
    merchant: view.chain.merchant,
    name: listedPlan?.name ?? null,
    catalog: view.catalog.state,
    terms: termsFrom(shown, view.assetSupported),
    termsSource: transaction === null ? 'network' : 'transaction',
    mismatch: listedPlan === null ? [] : planTermsDivergence(planTermsOf(listedPlan), shown),
    listed: listedPlan === null ? null : termsFrom(planTermsOf(listedPlan), view.assetSupported),
    pullers: view.chain.pullers,
    endsAt: view.chain.endsAt === null ? null : new Date(view.chain.endsAt),
    destinations: view.chain.destinations,
    transaction,
    blocked,
    syncedAt: new Date(view.syncedAt),
  }
}
