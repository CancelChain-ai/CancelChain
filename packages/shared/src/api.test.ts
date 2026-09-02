import { describe, expect, it } from 'vitest'
import {
  listAllowancesQuerySchema,
  listEventsQuerySchema,
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
