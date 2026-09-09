import { describe, expect, it } from 'vitest'
import {
  latestBlockhashResponseSchema,
  listAllowancesQuerySchema,
  listAllowancesResponseSchema,
  listEventsQuerySchema,
  listedAllowanceSchema,
  MAX_EVENTS_PAGE,
  pushSubscribeBodySchema,
  signInMessageSchema,
  streamMessageSchema,
} from './api.js'

const OWNER = '11111111111111111111111111111111'
const PDA = 'SysvarC1ock11111111111111111111111111111111'

describe('listAllowancesQuerySchema', () => {
  it('demands a real address', () => {
    expect(listAllowancesQuerySchema.parse({ owner: OWNER })).toEqual({ owner: OWNER })
    expect(listAllowancesQuerySchema.safeParse({ owner: 'not-an-address' }).success).toBe(false)
  })
})

describe('listEventsQuerySchema', () => {
  it('defaults the page size and coerces it from the query string', () => {
    expect(listEventsQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(listEventsQuerySchema.parse({ limit: '25' }).limit).toBe(25)
  })

  it('caps the page at the documented maximum', () => {
    expect(listEventsQuerySchema.parse({ limit: String(MAX_EVENTS_PAGE) }).limit).toBe(
      MAX_EVENTS_PAGE,
    )
    expect(listEventsQuerySchema.safeParse({ limit: MAX_EVENTS_PAGE + 1 }).success).toBe(false)
    expect(listEventsQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
  })
})

describe('streamMessageSchema', () => {
  it('rejects a message with no known type', () => {
    expect(streamMessageSchema.safeParse({ type: 'allowance.deleted' }).success).toBe(false)
  })

  it('accepts an appended event', () => {
    const message = {
      type: 'event.appended' as const,
      allowancePda: PDA,
      event: {
        id: '7',
        allowancePda: PDA,
        kind: 'rejected' as const,
        amount: null,
        reason: 'revoked' as const,
        signature: '5'.repeat(88),
        slot: 325_100_442,
        blockTime: '2026-09-02T10:15:00.000Z',
      },
    }
    expect(streamMessageSchema.parse(message)).toEqual(message)
  })
})

describe('pushSubscribeBodySchema', () => {
  it('takes a browser endpoint and both keys', () => {
    const body = {
      owner: OWNER,
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'key', auth: 'auth' },
    }
    expect(pushSubscribeBodySchema.parse(body)).toEqual(body)
    expect(pushSubscribeBodySchema.safeParse({ ...body, endpoint: 'nope' }).success).toBe(false)
  })
})

describe('signInMessageSchema', () => {
  it('needs a nonce long enough not to be guessed', () => {
    const message = {
      domain: 'cancelchain.app',
      address: OWNER,
      nonce: 'a1b2c3d4e5',
      issuedAt: '2026-09-02T10:15:00.000Z',
    }
    expect(signInMessageSchema.parse(message)).toEqual(message)
    expect(signInMessageSchema.safeParse({ ...message, nonce: 'short' }).success).toBe(false)
  })
})

const LISTED_ALLOWANCE = {
  pda: PDA,
  owner: OWNER,
  delegate: PDA,
  mint: OWNER,
  kind: 'fixed',
  capAmount: '25000000',
  periodSeconds: null,
  spentInPeriod: '0',
  periodStartedAt: null,
  expiresAt: null,
  pausedAt: null,
  endsAt: null,
  status: 'active',
  planPda: null,
  lastSlot: 412_345_678,
  syncedAt: '2026-09-02T00:00:00.000Z',
  assetSupported: false,
}

describe('listedAllowanceSchema', () => {
  /**
   * Without the extension the mark would be stripped in silence: an object
   * schema drops unknown keys, the response would still validate, and an
   * allowance in a foreign asset would reach the screen looking ordinary.
   */
  it('keeps the asset mark instead of stripping it', () => {
    expect(listedAllowanceSchema.parse(LISTED_ALLOWANCE).assetSupported).toBe(false)
  })

  it('demands the mark — an allowance without it is not a list item', () => {
    const { assetSupported: _omitted, ...withoutMark } = LISTED_ALLOWANCE
    expect(listedAllowanceSchema.safeParse(withoutMark).success).toBe(false)
  })

  /** The extension must not lose the invariants of the allowance itself. */
  it('still enforces that a periodic allowance has a period', () => {
    const recurring = { ...LISTED_ALLOWANCE, kind: 'recurring' }
    expect(listedAllowanceSchema.safeParse(recurring).success).toBe(false)
  })
})

describe('listAllowancesResponseSchema', () => {
  it('carries the accounts that could not be read, with a category and no free text', () => {
    const parsed = listAllowancesResponseSchema.parse({
      items: [],
      syncedAt: '2026-09-02T00:00:00.000Z',
      stale: false,
      unreadable: [{ address: PDA, reason: 'version', detail: 'account version 2' }],
    })
    expect(parsed.unreadable).toEqual([{ address: PDA, reason: 'version' }])
  })

  it('rejects a reason outside the finite list', () => {
    const body = {
      items: [],
      syncedAt: '2026-09-02T00:00:00.000Z',
      stale: false,
      unreadable: [{ address: PDA, reason: 'other' }],
    }
    expect(listAllowancesResponseSchema.safeParse(body).success).toBe(false)
  })

  it('demands the unreadable list — "shown everything" has to be said, not assumed', () => {
    const body = { items: [], syncedAt: '2026-09-02T00:00:00.000Z', stale: false }
    expect(listAllowancesResponseSchema.safeParse(body).success).toBe(false)
  })
})

describe('latestBlockhashResponseSchema', () => {
  const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'

  it('takes the height as a decimal string', () => {
    const parsed = latestBlockhashResponseSchema.parse({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: '492096795',
      slot: 492_096_495,
    })
    expect(BigInt(parsed.lastValidBlockHeight)).toBe(492_096_795n)
  })

  /**
   * Числом ця межа мовчки округлює. Тут вона не мовчить: висота блоку живе на
   * тому самому правилі, що й суми, і винятку «поки що влазить» у нього немає.
   */
  it('refuses a height that came as a number', () => {
    const body = { blockhash: BLOCKHASH, lastValidBlockHeight: 492_096_795, slot: 1 }
    expect(latestBlockhashResponseSchema.safeParse(body).success).toBe(false)
  })

  it('refuses a blockhash that is not base58', () => {
    const body = { blockhash: 'not a blockhash', lastValidBlockHeight: '1', slot: 1 }
    expect(latestBlockhashResponseSchema.safeParse(body).success).toBe(false)
  })
})
