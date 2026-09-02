import { describe, expect, it } from 'vitest'
import {
  addressSchema,
  fromU64,
  signatureSchema,
  slotSchema,
  timestampSchema,
  toU64,
  U64_MAX,
  u64Schema,
} from './primitives.js'

const PROGRAM = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44'
const SYSTEM = '11111111111111111111111111111111'

describe('addressSchema', () => {
  it('accepts real base58 addresses of both common lengths', () => {
    expect(addressSchema.parse(PROGRAM)).toBe(PROGRAM)
    expect(addressSchema.parse(SYSTEM)).toBe(SYSTEM)
  })

  it('rejects the four characters base58 does not have', () => {
    for (const bad of ['0', 'O', 'I', 'l']) {
      expect(addressSchema.safeParse(SYSTEM.slice(1) + bad).success).toBe(false)
    }
  })

  it('rejects strings that are too short or too long', () => {
    expect(addressSchema.safeParse('1'.repeat(31)).success).toBe(false)
    expect(addressSchema.safeParse('1'.repeat(45)).success).toBe(false)
  })
})

describe('signatureSchema', () => {
  it('accepts 88 base58 characters and rejects an address', () => {
    expect(signatureSchema.safeParse('5'.repeat(88)).success).toBe(true)
    expect(signatureSchema.safeParse(PROGRAM).success).toBe(false)
  })
})

describe('u64Schema', () => {
  it('accepts zero and the largest u64', () => {
    expect(u64Schema.parse('0')).toBe('0')
    expect(u64Schema.parse(U64_MAX.toString())).toBe(U64_MAX.toString())
  })

  it('rejects one past the largest u64', () => {
    expect(u64Schema.safeParse((U64_MAX + 1n).toString()).success).toBe(false)
  })

  it('rejects anything that is not a plain decimal integer', () => {
    for (const bad of ['-1', '1.5', '007', '', ' 1', '1e6', '0x10', 'NaN']) {
      expect(u64Schema.safeParse(bad).success, bad).toBe(false)
    }
  })

  it('rejects numbers — amounts travel as strings, never as JSON numbers', () => {
    expect(u64Schema.safeParse(24_000_000).success).toBe(false)
  })

  it('round-trips a sum that a double would have silently rounded', () => {
    // 9 007 199 254 740 993 = MAX_SAFE_INTEGER + 2: a double collapses it onto
    // its neighbour, the decimal string does not.
    const beyondDouble = 9_007_199_254_740_993n
    expect(BigInt(Number(beyondDouble))).not.toBe(beyondDouble)
    expect(toU64(fromU64(beyondDouble))).toBe(beyondDouble)
  })

  it('fromU64 refuses values that do not fit', () => {
    expect(() => fromU64(-1n)).toThrow(RangeError)
    expect(() => fromU64(U64_MAX + 1n)).toThrow(RangeError)
  })
})

describe('slotSchema', () => {
  it('accepts a whole non-negative slot and rejects a fractional one', () => {
    expect(slotSchema.parse(325_100_442)).toBe(325_100_442)
    expect(slotSchema.safeParse(-1).success).toBe(false)
    expect(slotSchema.safeParse(1.5).success).toBe(false)
  })
})

describe('timestampSchema', () => {
  it('accepts UTC and refuses a local offset', () => {
    expect(timestampSchema.safeParse('2026-09-02T10:15:00.000Z').success).toBe(true)
    expect(timestampSchema.safeParse('2026-09-02T10:15:00+03:00').success).toBe(false)
    expect(timestampSchema.safeParse('2026-09-02').success).toBe(false)
  })
})
