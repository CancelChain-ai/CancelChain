import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from 'node:crypto'
import { describe, expect, it } from 'vitest'
import webpush from 'web-push'
import { type PushMessage, pushMessageSchema, welcomeMessage } from './messages.js'
import { createPushSender, type PushFetch, type PushTarget } from './send.js'

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bH'
const vapid = { ...webpush.generateVAPIDKeys(), subject: 'mailto:ops@cancelchain.example' }

/** A browser: its own P-256 pair and auth secret, as `PushManager.subscribe` makes them. */
function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  const target: PushTarget = {
    endpoint: ENDPOINT,
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
  }
  return { ecdh, auth, target }
}

/**
 * What the browser does with the body (RFC 8291 over RFC 8188, one record) —
 * written out here rather than taken from the library, so the test checks the
 * library and not itself.
 */
function decrypt(body: Uint8Array, ua: ReturnType<typeof browser>): string {
  const bytes = Buffer.from(body)
  const salt = bytes.subarray(0, 16)
  const idLength = bytes.readUInt8(20)
  const asPublic = bytes.subarray(21, 21 + idLength)
  const record = bytes.subarray(21 + idLength)

  const secret = ua.ecdh.computeSecret(asPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.ecdh.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', secret, ua.auth, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12))

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(record.subarray(record.length - 16))
  const plain = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ])
  // The last record ends with the delimiter 0x02 and optional zero padding.
  const end = plain.lastIndexOf(2)
  expect(end).toBeGreaterThanOrEqual(0)
  expect(plain.subarray(end + 1).every((byte) => byte === 0)).toBe(true)
  return plain.subarray(0, end).toString('utf8')
}

type Call = Parameters<PushFetch>[1] & { url: string }

function recording(status: number, text = ''): { fetch: PushFetch; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, ...init })
      return { status, text: async () => text }
    },
  }
}

const OPTIONS = { ttlSeconds: 3600, urgency: 'normal' as const }

describe('createPushSender', () => {
  it('sends what the browser can decrypt back into the same message', async () => {
    const ua = browser()
    const { fetch, calls } = recording(201)
    const message: PushMessage = welcomeMessage(OWNER)

    const outcome = await createPushSender({ vapid, fetch }).send(ua.target, message, OPTIONS)

    expect(outcome).toEqual({ state: 'delivered', status: 201 })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (call === undefined) throw new Error('no request')
    expect(call.url).toBe(ENDPOINT)
    expect(pushMessageSchema.parse(JSON.parse(decrypt(call.body, ua)))).toEqual(message)
  })

  it('says how long to keep it, how urgent it is, and how it is encoded', async () => {
    const { fetch, calls } = recording(201)
    await createPushSender({ vapid, fetch }).send(browser().target, welcomeMessage(OWNER), {
      ttlSeconds: 86_400,
      urgency: 'high',
    })
    const headers = calls[0]?.headers ?? {}
    expect(headers.TTL).toBe('86400')
    expect(headers.Urgency).toBe('high')
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(calls[0]?.redirect).toBe('manual')
  })

  it('signs for the push service it sends to, with the configured key', async () => {
    const { fetch, calls } = recording(201)
    await createPushSender({ vapid, fetch }).send(browser().target, welcomeMessage(OWNER), OPTIONS)

    const authorization = calls[0]?.headers.Authorization ?? ''
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization)
    expect(match).not.toBeNull()
    const [, token = '', key = ''] = match ?? []
    expect(key).toBe(vapid.publicKey)

    const [header = '', payload = '', signature = ''] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    expect(claims.aud).toBe('https://fcm.googleapis.com')
    expect(claims.sub).toBe(vapid.subject)

    const point = Buffer.from(vapid.publicKey, 'base64url')
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    })
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true)
  })

  it.each([
    [201, { state: 'delivered', status: 201 }],
    [404, { state: 'gone', status: 404 }],
    [410, { state: 'gone', status: 410 }],
    [400, { state: 'refused', status: 400, detail: 'body' }],
    [403, { state: 'refused', status: 403, detail: 'body' }],
    [301, { state: 'refused', status: 301, detail: 'body' }],
    [413, { state: 'refused', status: 413, detail: 'body' }],
    [429, { state: 'unreachable', status: 429, detail: 'body' }],
    [503, { state: 'unreachable', status: 503, detail: 'body' }],
  ])('sorts %i by what to do next', async (status, expected) => {
    const { fetch } = recording(status, 'body')
    expect(
      await createPushSender({ vapid, fetch }).send(
        browser().target,
        welcomeMessage(OWNER),
        OPTIONS,
      ),
    ).toEqual(expected)
  })

  it('reads a failed request as worth a retry', async () => {
    const fetch: PushFetch = async () => {
      throw new TypeError('fetch failed')
    }
    expect(
      await createPushSender({ vapid, fetch }).send(
        browser().target,
        welcomeMessage(OWNER),
        OPTIONS,
      ),
    ).toEqual({ state: 'unreachable', status: null, detail: 'fetch failed' })
  })

  it('never calls an endpoint outside the push services, whatever the table holds', async () => {
    const { fetch, calls } = recording(201)
    const target = { ...browser().target, endpoint: 'https://169.254.169.254/latest' }
    expect(
      await createPushSender({ vapid, fetch }).send(target, welcomeMessage(OWNER), OPTIONS),
    ).toEqual({ state: 'gone', status: null })
    expect(calls).toHaveLength(0)
  })
})
