import { describe, expect, it } from 'vitest'
import {
  periodHoursFromSeconds,
  periodSecondsFromDays,
  periodSecondsFromHours,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
} from './period.js'

describe('period conversion', () => {
  it('turns a monthly plan in hours into the seconds the store keeps', () => {
    // PlanTerms.periodHours рахує годинами, RecurringDelegation.periodLengthS — секундами.
    expect(periodSecondsFromHours(720)).toBe(2_592_000)
    expect(periodSecondsFromDays(30)).toBe(2_592_000)
    expect(SECONDS_PER_DAY).toBe(24 * SECONDS_PER_HOUR)
  })

  it('round-trips hours through seconds', () => {
    for (const hours of [1, 24, 168, 720, 8760]) {
      expect(periodHoursFromSeconds(periodSecondsFromHours(hours))).toBe(hours)
    }
  })

  it('refuses to round a period that is not a whole number of hours', () => {
    expect(() => periodHoursFromSeconds(3601)).toThrow(RangeError)
    expect(() => periodHoursFromSeconds(1800)).toThrow(RangeError)
  })

  it('refuses zero, negative and fractional input in both directions', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => periodSecondsFromHours(bad), `hours ${bad}`).toThrow(RangeError)
      expect(() => periodHoursFromSeconds(bad), `seconds ${bad}`).toThrow(RangeError)
      expect(() => periodSecondsFromDays(bad), `days ${bad}`).toThrow(RangeError)
    }
  })

  it('never returns the input unscaled — the 3600× slip is what this file exists for', () => {
    expect(periodSecondsFromHours(720)).not.toBe(720)
    expect(periodHoursFromSeconds(2_592_000)).not.toBe(2_592_000)
  })
})
