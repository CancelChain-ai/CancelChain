import { describe, expect, it } from 'vitest'
import {
  REJECT_REASON_LABELS,
  REJECT_REASONS,
  rejectReasonLabel,
  rejectReasonOrUnknownSchema,
  rejectReasonSchema,
  UNKNOWN_REJECT_REASON_LABEL,
} from './reasons.js'

describe('reject reasons', () => {
  it('is the exact finite list the contract names', () => {
    expect([...REJECT_REASONS]).toEqual([
      'revoked',
      'cap_exceeded',
      'paused',
      'expired',
      'insufficient_funds',
      'wrong_mint',
      'not_due_yet',
    ])
  })

  it('has no catch-all category — SC-011 measures the hole, so the hole must stay visible', () => {
    for (const trash of ['other', 'unknown', 'error', 'misc']) {
      expect(rejectReasonSchema.safeParse(trash).success, trash).toBe(false)
    }
  })

  it('accepts null as "the program returned a code we do not map"', () => {
    expect(rejectReasonOrUnknownSchema.parse(null)).toBe(null)
  })

  it('gives every reason a plain-words label, and never a code', () => {
    expect(Object.keys(REJECT_REASON_LABELS).sort()).toEqual([...REJECT_REASONS].sort())
    for (const reason of REJECT_REASONS) {
      const label = rejectReasonLabel(reason)
      expect(label.length).toBeGreaterThan(0)
      expect(label).not.toContain('_')
    }
  })

  it('says out loud when the code was not recognised', () => {
    expect(rejectReasonLabel(null)).toBe(UNKNOWN_REJECT_REASON_LABEL)
  })
})
