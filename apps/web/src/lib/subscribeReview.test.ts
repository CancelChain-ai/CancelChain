import { readSubscribeBounds, subscribeBoundsAsPlanTerms } from '@cancelchain/chain'
import type { PlanSubscriber, PlanView } from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { reviewSubscription } from './subscribeReview'

/** The devnet plan from `T034`, as `GET /v1/plans/:pda` returns it. */
const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const MERCHANT = 'FGHMNoGvR5zP9K5Cs4XrwZhQnAxNrFEQYH3TK22fBkKF'
const SUBSCRIBER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const CREATED_AT = '2026-09-21T11:33:43.000Z'
const NOW = new Date('2026-09-26T12:00:00.000Z')

const SUBSCRIBER_STATE: PlanSubscriber = {
  address: SUBSCRIBER,
  authority: 'CivSovG4Kriz5ZMEVm1wbSjqZcqLTGesA3bHxUdLxLsr',
  authorityInitId: '7',
  tokenProgram: TOKEN_PROGRAM,
  tokenAccount: 'ETWQPJL6dcCrL1T3rAstz2gdGvnf5sYrN3TbR6JWygHN',
  tokenAccountExists: true,
  subscription: 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2',
  subscribed: false,
}

function view(over: Partial<PlanView> = {}, chainOver: Partial<PlanView['chain']> = {}): PlanView {
  return {
    chain: {
      pda: PLAN,
      merchant: MERCHANT,
      planId: '1789990423243',
      mint: USDC,
      amount: '9990000',
      periodSeconds: 2_592_000,
      createdAt: CREATED_AT,
      status: 'active',
      endsAt: null,
      destinations: [MERCHANT],
      pullers: [MERCHANT],
      ...chainOver,
    },
    catalog: {
      state: 'named',
      plan: {
        pda: PLAN,
        merchant: MERCHANT,
        planId: '1789990423243',
        name: 'Studio monthly',
        amount: '9990000',
        periodSeconds: 2_592_000,
        mint: USDC,
        createdAt: CREATED_AT,
      },
    },
    diverged: [],
    assetSupported: true,
    subscriber: SUBSCRIBER_STATE,
    syncedAt: '2026-09-26T11:59:58.000Z',
    ...over,
  }
}

describe('reviewSubscription', () => {
  it('the terms on the screen are the terms decoded from the instructions it carries', async () => {
    const review = await reviewSubscription(view(), NOW)
    if (review.transaction === null) throw new Error('expected a transaction')
    const decoded = subscribeBoundsAsPlanTerms(readSubscribeBounds(review.transaction.instructions))

    expect(review.termsSource).toBe('transaction')
    expect(review.blocked).toBeNull()
    expect(review.terms.perPeriod.amount.toString()).toBe(decoded.amount)
    expect(review.terms.periodSeconds).toBe(decoded.periodSeconds)
    expect(review.terms.mint).toBe(decoded.mint)
    expect(review.terms.createdAt?.toISOString()).toBe(decoded.createdAt)
    expect(review.name).toBe('Studio monthly')
    expect(review.mismatch).toEqual([])
    expect(review.transaction.initsAuthority).toBe(false)
    expect(review.transaction.subscription).toBe(SUBSCRIBER_STATE.subscription)
  })

  it('a catalog that asks for something else is named field by field, and the transaction wins', async () => {
    const base = view()
    if (base.catalog.state !== 'named') throw new Error('fixture')
    const review = await reviewSubscription(
      view({
        catalog: {
          state: 'named',
          plan: { ...base.catalog.plan, amount: '999000', createdAt: '2026-09-20T00:00:00.000Z' },
        },
      }),
      NOW,
    )
    expect(review.mismatch).toEqual(['amount', 'createdAt'])
    expect(review.listed?.perPeriod.amount).toBe(999_000n)
    expect(review.terms.perPeriod.amount).toBe(9_990_000n)
    // A divergence with the catalog does not stop the transaction: the chain is the plan.
    expect(review.transaction).not.toBeNull()
  })

  it('no authority yet: the same transaction creates it', async () => {
    const review = await reviewSubscription(
      view({ subscriber: { ...SUBSCRIBER_STATE, authorityInitId: null } }),
      NOW,
    )
    expect(review.transaction?.initsAuthority).toBe(true)
    expect(review.transaction?.instructions).toHaveLength(2)
  })

  it('no authority and no token account: blocked before signing, with the account named', async () => {
    const review = await reviewSubscription(
      view({
        subscriber: { ...SUBSCRIBER_STATE, authorityInitId: null, tokenAccountExists: false },
      }),
      NOW,
    )
    expect(review.blocked).toEqual({
      reason: 'no-token-account',
      tokenAccount: SUBSCRIBER_STATE.tokenAccount,
    })
    expect(review.transaction).toBeNull()
    expect(review.termsSource).toBe('network')
  })

  it('an existing authority does not need the token account checked', async () => {
    const review = await reviewSubscription(
      view({ subscriber: { ...SUBSCRIBER_STATE, tokenAccountExists: false } }),
      NOW,
    )
    expect(review.blocked).toBeNull()
  })

  it('no wallet: the plan is shown from the network, and nothing is built', async () => {
    const review = await reviewSubscription(view({ subscriber: null }), NOW)
    expect(review.blocked).toEqual({ reason: 'wallet' })
    expect(review.termsSource).toBe('network')
    expect(review.terms.perPeriod.amount).toBe(9_990_000n)
  })

  it('already subscribed', async () => {
    const review = await reviewSubscription(
      view({ subscriber: { ...SUBSCRIBER_STATE, subscribed: true } }),
      NOW,
    )
    expect(review.blocked).toEqual({
      reason: 'subscribed',
      subscription: SUBSCRIBER_STATE.subscription,
    })
  })

  it('a plan being wound down, or already over, takes nobody', async () => {
    expect((await reviewSubscription(view({}, { status: 'sunset' }), NOW)).blocked).toEqual({
      reason: 'sunset',
    })
    expect(
      (await reviewSubscription(view({}, { endsAt: '2026-09-26T00:00:00.000Z' }), NOW)).blocked,
    ).toEqual({ reason: 'ended', endedAt: new Date('2026-09-26T00:00:00.000Z') })
  })

  it('a later end date is shown and does not block', async () => {
    const review = await reviewSubscription(view({}, { endsAt: '2027-01-01T00:00:00.000Z' }), NOW)
    expect(review.blocked).toBeNull()
    expect(review.endsAt).toEqual(new Date('2027-01-01T00:00:00.000Z'))
  })

  it('an unnamed or unreachable catalog has no name and nothing to compare with', async () => {
    for (const catalog of [{ state: 'unnamed' }, { state: 'unavailable' }] as const) {
      const review = await reviewSubscription(view({ catalog }), NOW)
      expect(review.name).toBeNull()
      expect(review.catalog).toBe(catalog.state)
      expect(review.mismatch).toEqual([])
      expect(review.listed).toBeNull()
    }
  })

  it('a plan in another asset is shown in its smallest units, not as USDC', async () => {
    const review = await reviewSubscription(view({ assetSupported: false }), NOW)
    expect(review.terms.perPeriod.decimals).toBeNull()
    expect(review.terms.perPeriod.label).not.toBe('USDC')
  })
})
