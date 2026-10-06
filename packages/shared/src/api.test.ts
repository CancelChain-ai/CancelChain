import { describe, expect, it } from 'vitest'
import {
  getAllowanceQuerySchema,
  latestBlockhashResponseSchema,
  listAllowancesQuerySchema,
  listAllowancesResponseSchema,
  listEventsQuerySchema,
  listedAllowanceSchema,
  MAX_EVENTS_PAGE,
  MERCHANT_JWT_TTL_SECONDS,
  pushKeyResponseSchema,
  pushSubscribeBodySchema,
  pushUnsubscribeBodySchema,
  SIGN_IN_MAX_AGE_SECONDS,
  signInBodySchema,
  signInMessageSchema,
  signInMessageText,
  signInResponseSchema,
  streamMessageSchema,
} from './api.js'

const OWNER = '11111111111111111111111111111111'
const PDA = 'SysvarC1ock11111111111111111111111111111111'

describe('listAllowancesQuerySchema', () => {
  it('demands a real address', () => {
    expect(listAllowancesQuerySchema.parse({ owner: OWNER })).toEqual({ owner: OWNER })
    expect(listAllowancesQuerySchema.safeParse({ owner: 'not-an-address' }).success).toBe(false)
  })

  it('takes a slot floor from the query string, and none when it is absent', () => {
    expect(listAllowancesQuerySchema.parse({ owner: OWNER, minSlot: '325100442' }).minSlot).toBe(
      325_100_442,
    )
    expect('minSlot' in listAllowancesQuerySchema.parse({ owner: OWNER })).toBe(false)
    expect(getAllowanceQuerySchema.parse({}).minSlot).toBeUndefined()
  })

  it('refuses a slot floor that is not a slot', () => {
    for (const minSlot of ['-1', '1.5', 'latest', '']) {
      expect(listAllowancesQuerySchema.safeParse({ owner: OWNER, minSlot }).success).toBe(false)
      expect(getAllowanceQuerySchema.safeParse({ minSlot }).success).toBe(false)
    }
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

  it('accepts the two "read everything again" signals, which carry nothing', () => {
    expect(streamMessageSchema.parse({ type: 'ready' })).toEqual({ type: 'ready' })
    expect(streamMessageSchema.parse({ type: 'resync' })).toEqual({ type: 'resync' })
  })

  it('accepts the heartbeat as a message of its own', () => {
    expect(streamMessageSchema.parse({ type: 'ping' })).toEqual({ type: 'ping' })
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
        chargesStopAt: null,
      },
    }
    expect(streamMessageSchema.parse(message)).toEqual(message)
  })
})

describe('pushSubscribeBodySchema', () => {
  const body = {
    owner: OWNER,
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: {
      p256dh:
        'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
      auth: 'tBHItJI5svbpez7KI4CCXg',
    },
  }

  it('takes a browser endpoint and both keys', () => {
    expect(pushSubscribeBodySchema.parse(body)).toEqual(body)
  })

  it('refuses an endpoint outside the browser push services', () => {
    for (const endpoint of ['nope', 'https://example.com/push', 'http://fcm.googleapis.com/x']) {
      expect(pushSubscribeBodySchema.safeParse({ ...body, endpoint }).success).toBe(false)
    }
  })

  it('refuses keys that are not base64url', () => {
    const keys = { ...body.keys, auth: 'not base64/url' }
    expect(pushSubscribeBodySchema.safeParse({ ...body, keys }).success).toBe(false)
  })
})

describe('pushUnsubscribeBodySchema', () => {
  it('takes an endpoint with or without the wallet', () => {
    const endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/abc'
    expect(pushUnsubscribeBodySchema.parse({ endpoint })).toEqual({ endpoint })
    expect(pushUnsubscribeBodySchema.parse({ endpoint, owner: OWNER })).toEqual({
      endpoint,
      owner: OWNER,
    })
  })
})

describe('pushKeyResponseSchema', () => {
  it('carries the key only when push is on', () => {
    const publicKey =
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
    expect(pushKeyResponseSchema.parse({ enabled: true, publicKey })).toEqual({
      enabled: true,
      publicKey,
    })
    expect(pushKeyResponseSchema.parse({ enabled: false })).toEqual({ enabled: false })
    expect(pushKeyResponseSchema.safeParse({ enabled: true }).success).toBe(false)
    expect(pushKeyResponseSchema.safeParse({ enabled: true, publicKey: 'short' }).success).toBe(
      false,
    )
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

describe('sign-in message', () => {
  const message = {
    domain: 'localhost:8879',
    address: OWNER,
    nonce: 'a1b2c3d4e5f6',
    issuedAt: '2026-09-24T09:00:00.000Z',
  }

  it('carries every field of the message and nothing else', () => {
    const text = signInMessageText(message)
    for (const value of Object.values(message)) expect(text).toContain(value)
  })

  /*
   * The wallet shows bytes, and both sides build those bytes from this one
   * function. A test that rebuilt the text by hand would only prove the test
   * agrees with itself, so it pins the exact shape instead.
   */
  it('is byte-for-byte stable', () => {
    expect(signInMessageText(message)).toBe(
      [
        'localhost:8879 wants you to sign in with your Solana account:',
        OWNER,
        '',
        'Sign in to CancelChain as a merchant.',
        '',
        'Nonce: a1b2c3d4e5f6',
        'Issued At: 2026-09-24T09:00:00.000Z',
      ].join('\n'),
    )
  })

  it('changes with every field, so no two messages share a signature', () => {
    const base = signInMessageText(message)
    expect(signInMessageText({ ...message, nonce: 'a1b2c3d4e5f7' })).not.toBe(base)
    expect(signInMessageText({ ...message, domain: 'cancelchain.example' })).not.toBe(base)
    expect(signInMessageText({ ...message, issuedAt: '2026-09-24T09:00:01.000Z' })).not.toBe(base)
  })

  it('refuses a nonce short enough to collide', () => {
    expect(signInMessageSchema.safeParse({ ...message, nonce: 'abc' }).success).toBe(false)
  })

  it('takes a base58 signature next to the message', () => {
    const signature = '5'.repeat(88)
    expect(signInBodySchema.safeParse({ message, signature }).success).toBe(true)
    expect(signInBodySchema.safeParse({ message, signature: 'not base58 0OIl' }).success).toBe(
      false,
    )
  })

  it('answers with a deadline, not a duration', () => {
    const body = { token: 'header.payload.signature', address: OWNER, expiresAt: message.issuedAt }
    expect(signInResponseSchema.parse(body)).toEqual(body)
    expect(signInResponseSchema.safeParse({ ...body, expiresAt: 900 }).success).toBe(false)
  })

  it('keeps the signature window shorter than the token it buys', () => {
    expect(SIGN_IN_MAX_AGE_SECONDS).toBeLessThan(MERCHANT_JWT_TTL_SECONDS)
  })
})
