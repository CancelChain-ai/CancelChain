import { describe, expect, it } from 'vitest'
import { allowanceDetailSchema, allowanceSchema, eventSchema, planSchema } from './allowance.js'

const OWNER = '11111111111111111111111111111111'
const DELEGATE = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44'
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const PDA = 'SysvarC1ock11111111111111111111111111111111'
const SIGNATURE = '5'.repeat(88)

const recurring = {
  pda: PDA,
  owner: OWNER,
  delegate: DELEGATE,
  mint: MINT,
  kind: 'recurring' as const,
  capAmount: '24000000',
  periodSeconds: 2_592_000,
  spentInPeriod: '24000000',
  periodStartedAt: '2026-08-07T00:00:00.000Z',
  expiresAt: null,
  pausedAt: null,
  endsAt: null,
  status: 'active' as const,
  planPda: null,
  lastSlot: 325_100_442,
  syncedAt: '2026-09-02T10:15:00.000Z',
}

const subscription = { ...recurring, kind: 'subscription' as const, planPda: DELEGATE }

describe('allowanceSchema', () => {
  it('accepts a plain recurring allowance', () => {
    expect(allowanceSchema.parse(recurring)).toEqual(recurring)
  })

  it('demands a period for recurring and subscription, and refuses one for fixed', () => {
    expect(allowanceSchema.safeParse({ ...recurring, periodSeconds: null }).success).toBe(false)
    expect(
      allowanceSchema.safeParse({
        ...recurring,
        kind: 'fixed',
        periodSeconds: null,
        periodStartedAt: null,
      }).success,
    ).toBe(true)
    expect(allowanceSchema.safeParse({ ...recurring, kind: 'fixed' }).success).toBe(false)
  })

  it('lets only a plan subscription be paused (FR-011)', () => {
    const pausedAt = '2026-08-19T00:00:00.000Z'
    expect(allowanceSchema.safeParse({ ...subscription, status: 'paused', pausedAt }).success).toBe(
      true,
    )
    expect(allowanceSchema.safeParse({ ...recurring, status: 'paused', pausedAt }).success).toBe(
      false,
    )
  })

  it('lets only a plan subscription be scheduled to end (FR-028)', () => {
    const endsAt = '2026-09-27T00:00:00.000Z'
    expect(allowanceSchema.safeParse({ ...subscription, endsAt }).success).toBe(true)
    expect(allowanceSchema.safeParse({ ...recurring, endsAt }).success).toBe(false)
  })

  it('keeps status and the pause timestamp from drifting apart', () => {
    expect(allowanceSchema.safeParse({ ...subscription, status: 'paused' }).success).toBe(false)
    expect(
      allowanceSchema.safeParse({ ...subscription, pausedAt: '2026-08-19T00:00:00.000Z' }).success,
    ).toBe(false)
  })

  it('accepts spent above the ceiling on purpose — FR-025 shows divergence, it does not hide it', () => {
    const overspent = { ...recurring, capAmount: '24000000', spentInPeriod: '25000000' }
    expect(allowanceSchema.safeParse(overspent).success).toBe(true)
  })
})

describe('allowanceDetailSchema', () => {
  it('carries the network read alongside the stored state', () => {
    const detail = {
      ...recurring,
      chainState: {
        status: 'revoked' as const,
        capAmount: '24000000',
        spentInPeriod: '24000000',
        periodStartedAt: '2026-08-07T00:00:00.000Z',
        pausedAt: null,
        endsAt: null,
        slot: 325_100_500,
      },
      diverged: true,
    }
    expect(allowanceDetailSchema.parse(detail)).toEqual(detail)
  })

  it('allows a missing on-chain account — the allowance was closed', () => {
    const detail = { ...recurring, chainState: null, diverged: true }
    expect(allowanceDetailSchema.parse(detail)).toEqual(detail)
  })

  it('applies the same invariants as the plain allowance', () => {
    expect(
      allowanceDetailSchema.safeParse({
        ...recurring,
        endsAt: '2026-09-27T00:00:00.000Z',
        chainState: null,
        diverged: false,
      }).success,
    ).toBe(false)
  })
})

describe('eventSchema', () => {
  const base = {
    id: '1',
    allowancePda: PDA,
    kind: 'charged' as const,
    amount: '24000000',
    reason: null,
    signature: SIGNATURE,
    slot: 325_100_442,
    blockTime: '2026-08-07T00:00:00.000Z',
  }

  it('accepts a charge', () => {
    expect(eventSchema.parse(base)).toEqual(base)
  })

  it('requires an amount on a charge', () => {
    expect(eventSchema.safeParse({ ...base, amount: null }).success).toBe(false)
  })

  it('carries a reason only on a rejection', () => {
    expect(
      eventSchema.safeParse({
        ...base,
        kind: 'rejected',
        amount: null,
        reason: 'cap_exceeded',
      }).success,
    ).toBe(true)
    expect(eventSchema.safeParse({ ...base, reason: 'cap_exceeded' }).success).toBe(false)
  })

  it('allows a rejection whose program code we could not map', () => {
    expect(
      eventSchema.safeParse({ ...base, kind: 'rejected', amount: null, reason: null }).success,
    ).toBe(true)
  })
})

describe('planSchema', () => {
  it('keeps the period in seconds, never in the hours the plan speaks', () => {
    const plan = {
      pda: PDA,
      merchant: DELEGATE,
      planId: '1',
      name: 'Halcyon Audio — Standard',
      amount: '11500000',
      periodSeconds: 2_592_000,
      mint: MINT,
      createdAt: '2026-07-22T00:00:00.000Z',
    }
    expect(planSchema.parse(plan)).toEqual(plan)
    expect(planSchema.safeParse({ ...plan, periodSeconds: 0 }).success).toBe(false)
    expect(planSchema.safeParse({ ...plan, name: '' }).success).toBe(false)
  })
})
