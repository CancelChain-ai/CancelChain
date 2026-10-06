import { describe, expect, it } from 'vitest'
import webpush from 'web-push'
import { PushNotConfiguredError, vapidFromEnv } from './vapid.js'

const pair = webpush.generateVAPIDKeys()
const other = webpush.generateVAPIDKeys()
const SUBJECT = 'mailto:ops@cancelchain.example'

describe('vapidFromEnv', () => {
  it('reads none as push off — a valid installation (FR-027)', () => {
    expect(vapidFromEnv({})).toBeNull()
    expect(vapidFromEnv({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: ' ', VAPID_SUBJECT: '' })).toBe(
      null,
    )
  })

  it('reads all three', () => {
    expect(
      vapidFromEnv({
        VAPID_PUBLIC_KEY: ` ${pair.publicKey} `,
        VAPID_PRIVATE_KEY: pair.privateKey,
        VAPID_SUBJECT: SUBJECT,
      }),
    ).toEqual({ publicKey: pair.publicKey, privateKey: pair.privateKey, subject: SUBJECT })
  })

  it('takes an https subject', () => {
    const config = vapidFromEnv({
      VAPID_PUBLIC_KEY: pair.publicKey,
      VAPID_PRIVATE_KEY: pair.privateKey,
      VAPID_SUBJECT: 'https://cancelchain.example',
    })
    expect(config?.subject).toBe('https://cancelchain.example')
  })

  it('refuses some of them, naming what is missing', () => {
    expect(() => vapidFromEnv({ VAPID_PUBLIC_KEY: pair.publicKey })).toThrow(
      /VAPID_PRIVATE_KEY, VAPID_SUBJECT is empty/,
    )
    expect(() => vapidFromEnv({ VAPID_PUBLIC_KEY: pair.publicKey })).toThrow(PushNotConfiguredError)
  })

  it('refuses a subject a push service cannot write to', () => {
    expect(() =>
      vapidFromEnv({
        VAPID_PUBLIC_KEY: pair.publicKey,
        VAPID_PRIVATE_KEY: pair.privateKey,
        VAPID_SUBJECT: 'ops@cancelchain.example',
      }),
    ).toThrow(/VAPID_SUBJECT/)
  })

  it('refuses a private key that is not one', () => {
    expect(() =>
      vapidFromEnv({
        VAPID_PUBLIC_KEY: pair.publicKey,
        VAPID_PRIVATE_KEY: 'not-a-key',
        VAPID_SUBJECT: SUBJECT,
      }),
    ).toThrow(/VAPID_PRIVATE_KEY is not/)
  })

  it('refuses halves of two different pairs — every push would come back 403', () => {
    expect(() =>
      vapidFromEnv({
        VAPID_PUBLIC_KEY: other.publicKey,
        VAPID_PRIVATE_KEY: pair.privateKey,
        VAPID_SUBJECT: SUBJECT,
      }),
    ).toThrow(/not the public half/)
  })
})
