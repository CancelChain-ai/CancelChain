import { describe, expect, it } from 'vitest'
import {
  capAmount,
  countKinds,
  missing,
  planAmount,
  planName,
  RECURRING_PERIODS_SECONDS,
  recurringPeriod,
  TARGET,
  TARGET_TOTAL,
} from './composition.js'

describe('the measured wallet', () => {
  it('holds exactly the 100 permissions SC-003 names, of all three kinds', () => {
    expect(TARGET_TOTAL).toBe(100)
    expect(TARGET.subscription).toBeGreaterThan(0)
    expect(TARGET.recurring).toBeGreaterThan(0)
    expect(TARGET.fixed).toBeGreaterThan(0)
  })

  it('tops up only what is missing — the seed after SC-009 grants back what was revoked', () => {
    expect(missing({ subscription: 20, recurring: 45, fixed: 15 })).toEqual({
      subscription: 0,
      recurring: 10,
      fixed: 10,
    })
    expect(missing({ subscription: 0, recurring: 0, fixed: 0 })).toEqual(TARGET)
  })

  it('never asks for a negative grant when the wallet holds more than the target', () => {
    expect(missing({ subscription: 25, recurring: 60, fixed: 30 })).toEqual({
      subscription: 0,
      recurring: 0,
      fixed: 0,
    })
  })

  it('counts kinds and ignores anything that is not one', () => {
    expect(countKinds(['fixed', 'recurring', 'recurring', 'subscription', 'other'])).toEqual({
      subscription: 1,
      recurring: 2,
      fixed: 1,
    })
  })
})

describe('what the cards show', () => {
  it('gives every plan a different name, even past the list of invented merchants', () => {
    const names = Array.from({ length: 30 }, (_, i) => planName(i))
    expect(new Set(names).size).toBe(30)
    expect(planName(10)).toBe('Northwind Music 2')
  })

  it('prices plans in whole devnet-USDC units plus 99 cents', () => {
    expect(planAmount(0)).toBe(3_990_000n)
    expect(planAmount(9)).toBe(21_990_000n)
  })

  it('caps permissions between 5 and 95 USDC', () => {
    expect(capAmount(0)).toBe(5_000_000n)
    expect(capAmount(9)).toBe(95_000_000n)
  })

  it('cycles the periods the screen has words for', () => {
    expect(Array.from({ length: 3 }, (_, i) => recurringPeriod(i))).toEqual([
      ...RECURRING_PERIODS_SECONDS,
    ])
  })
})
