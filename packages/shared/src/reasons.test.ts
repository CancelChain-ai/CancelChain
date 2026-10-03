import { describe, expect, it } from 'vitest'
import {
  classifyRejection,
  REJECT_REASON_LABELS,
  REJECT_REASONS,
  type RejectionFacts,
  rejectionFactsSchema,
  rejectReasonLabel,
  rejectReasonOrUnknownSchema,
  rejectReasonSchema,
  SUBSCRIPTIONS_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
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
      'merchant_account_missing',
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

describe('classifyRejection — the key is (raisedBy, code)', () => {
  const custom = (raisedBy: string | null, code: number): RejectionFacts => ({
    failure: { type: 'custom', code },
    raisedBy,
  })
  const active = { paused: false }

  it.each([
    [SUBSCRIPTIONS_PROGRAM, 300, 'cap_exceeded'],
    [SUBSCRIPTIONS_PROGRAM, 400, 'cap_exceeded'],
    [SUBSCRIPTIONS_PROGRAM, 401, 'not_due_yet'],
    [SUBSCRIPTIONS_PROGRAM, 407, 'not_due_yet'],
    [SUBSCRIPTIONS_PROGRAM, 128, 'expired'],
    [SUBSCRIPTIONS_PROGRAM, 501, 'expired'],
    [SUBSCRIPTIONS_PROGRAM, 125, 'wrong_mint'],
    [SUBSCRIPTIONS_PROGRAM, 136, 'revoked'],
    [TOKEN_PROGRAM, 1, 'insufficient_funds'],
    [TOKEN_2022_PROGRAM, 1, 'insufficient_funds'],
    [TOKEN_PROGRAM, 3, 'wrong_mint'],
  ] as const)('%s / %i → %s', (raisedBy, code, reason) => {
    expect(classifyRejection(custom(raisedBy, code), active)).toEqual({ reason })
  })

  it('the same code from another program is another fact', () => {
    // `Custom 1` of the token program is a lack of funds; this program has no code 1.
    expect(classifyRejection(custom(SUBSCRIPTIONS_PROGRAM, 1), active).reason).toBeNull()
    // `400` is ours, not the token program's.
    expect(classifyRejection(custom(TOKEN_PROGRAM, 400), active).reason).toBeNull()
  })

  it('a code without its program maps to nothing', () => {
    expect(classifyRejection(custom(null, 400), active)).toEqual({
      reason: null,
      unmapped: 'the logs name no failing program',
    })
  })

  it('a charge against a closed permission is `revoked` — a runtime error, not a code', () => {
    const facts: RejectionFacts = {
      failure: { type: 'runtime', name: 'InvalidAccountOwner' },
      raisedBy: SUBSCRIPTIONS_PROGRAM,
    }
    expect(classifyRejection(facts, active)).toEqual({ reason: 'revoked' })
    expect(
      classifyRejection(
        { ...facts, failure: { type: 'runtime', name: 'AccountNotFound' } },
        active,
      ),
    ).toEqual({ reason: null, unmapped: `runtime AccountNotFound from ${SUBSCRIPTIONS_PROGRAM}` })
  })

  it('`508` is a pause where our label is, and a cancellation everywhere else', () => {
    expect(classifyRejection(custom(SUBSCRIPTIONS_PROGRAM, 508), active)).toEqual({
      reason: 'revoked',
    })
    expect(classifyRejection(custom(SUBSCRIPTIONS_PROGRAM, 508), { paused: true })).toEqual({
      reason: 'paused',
    })
  })

  it('`110` blames the merchant only when the transaction shows the merchant’s account missing', () => {
    const with110 = (existed: RejectionFacts['tokenAccountsExisted']) => ({
      ...custom(SUBSCRIPTIONS_PROGRAM, 110),
      tokenAccountsExisted: existed,
    })
    expect(classifyRejection(with110({ source: true, destination: false }), active)).toEqual({
      reason: 'merchant_account_missing',
    })
    // The subscriber's account missing answers `110` too — that is not the merchant.
    expect(
      classifyRejection(with110({ source: false, destination: true }), active).reason,
    ).toBeNull()
    expect(
      classifyRejection(with110({ source: false, destination: false }), active).reason,
    ).toBeNull()
    // A row written before the record existed.
    expect(classifyRejection(with110(undefined), active)).toEqual({
      reason: null,
      unmapped: `custom 110 from ${SUBSCRIPTIONS_PROGRAM}: no record of which token account was missing`,
    })
    // Token-2022's twin of the same check.
    expect(
      classifyRejection(
        {
          ...custom(SUBSCRIPTIONS_PROGRAM, 107),
          tokenAccountsExisted: { source: true, destination: false },
        },
        active,
      ).reason,
    ).toBe('merchant_account_missing')
  })

  it('an unknown code is null with the pair in words, never a guess', () => {
    expect(classifyRejection(custom(SUBSCRIPTIONS_PROGRAM, 999), active)).toEqual({
      reason: null,
      unmapped: `custom 999 from ${SUBSCRIPTIONS_PROGRAM}`,
    })
    expect(
      classifyRejection(
        { failure: { type: 'unrecognised', error: { Weird: 1 } }, raisedBy: TOKEN_PROGRAM },
        active,
      ).reason,
    ).toBeNull()
  })

  it('reads the facts the indexer stores in raw, with or without the token-account record', () => {
    const raw = {
      logs: ['…'],
      logCount: 3,
      failure: { type: 'custom', code: 400 },
      raisedBy: SUBSCRIPTIONS_PROGRAM,
    }
    expect(rejectionFactsSchema.parse(raw)).toEqual({
      failure: { type: 'custom', code: 400 },
      raisedBy: SUBSCRIPTIONS_PROGRAM,
    })
    expect(rejectionFactsSchema.safeParse({ logs: [] }).success).toBe(false)
  })
})
