import { describe, expect, it } from 'vitest'
import {
  getPlanQuerySchema,
  getPlanViewResponseSchema,
  type PlanTerms,
  planTermsDivergence,
} from './planView.js'

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const OTHER_MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr'
const PDA = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const MERCHANT = 'FGHMNoGvR5zP9K5Cs4XrwZhQnAxNrFEQYH3TK22fBkKF'

const TERMS: PlanTerms = {
  mint: MINT,
  amount: '9990000',
  periodSeconds: 2_592_000,
  createdAt: '2026-09-21T10:00:00.000Z',
}

describe('planTermsDivergence', () => {
  it('identical terms do not diverge', () => {
    expect(planTermsDivergence(TERMS, { ...TERMS })).toEqual([])
  })

  it('names every field that differs, in a fixed order', () => {
    expect(
      planTermsDivergence(TERMS, {
        mint: OTHER_MINT,
        amount: '99900000',
        periodSeconds: 3600,
        createdAt: '2026-09-22T10:00:00.000Z',
      }),
    ).toEqual(['mint', 'amount', 'periodSeconds', 'createdAt'])
  })

  it('compares amounts as numbers and instants as instants, not as strings', () => {
    expect(
      planTermsDivergence(TERMS, {
        ...TERMS,
        amount: '09990000',
        createdAt: '2026-09-21T10:00:00Z',
      }),
    ).toEqual([])
  })

  it('a missing creation time on one side is a divergence; on both it is not', () => {
    expect(planTermsDivergence(TERMS, { ...TERMS, createdAt: null })).toEqual(['createdAt'])
    expect(
      planTermsDivergence({ ...TERMS, createdAt: null }, { ...TERMS, createdAt: null }),
    ).toEqual([])
  })
})

describe('getPlanQuerySchema', () => {
  it('the subscriber is optional, and must be an address when present', () => {
    expect(getPlanQuerySchema.parse({})).toEqual({})
    expect(getPlanQuerySchema.safeParse({ subscriber: 'nope' }).success).toBe(false)
  })
})

describe('getPlanViewResponseSchema', () => {
  const chain = {
    pda: PDA,
    merchant: MERCHANT,
    planId: '1',
    mint: MINT,
    amount: '9990000',
    periodSeconds: 2_592_000,
    createdAt: '2026-09-21T10:00:00.000Z',
    status: 'active',
    endsAt: null,
    destinations: [MERCHANT],
    pullers: [MERCHANT],
  }

  it('keeps "could not look" apart from "not named"', () => {
    const base = {
      chain,
      diverged: [],
      assetSupported: true,
      subscriber: null,
      syncedAt: '2026-09-26T12:00:00.000Z',
    }
    expect(
      getPlanViewResponseSchema.parse({ ...base, catalog: { state: 'unavailable' } }).catalog,
    ).toEqual({ state: 'unavailable' })
    expect(
      getPlanViewResponseSchema.parse({ ...base, catalog: { state: 'unnamed' } }).catalog,
    ).toEqual({ state: 'unnamed' })
    expect(
      getPlanViewResponseSchema.safeParse({ ...base, catalog: { state: 'named' } }).success,
    ).toBe(false)
  })

  it('refuses an unknown divergence field', () => {
    expect(
      getPlanViewResponseSchema.safeParse({
        chain,
        catalog: { state: 'unnamed' },
        diverged: ['name'],
        assetSupported: true,
        subscriber: null,
        syncedAt: '2026-09-26T12:00:00.000Z',
      }).success,
    ).toBe(false)
  })
})
