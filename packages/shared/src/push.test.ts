import { describe, expect, it } from 'vitest'
import { isPushServiceEndpoint, MAX_PUSH_ENDPOINT_LENGTH, pushEndpointSchema } from './push.js'

describe('isPushServiceEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bH',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABl',
    'https://web.push.apple.com/QGuQyavXutnMH8',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
    'https://FCM.googleapis.com/fcm/send/abc',
  ])('takes a browser push service: %s', (endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(true)
  })

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['an internal address', 'https://169.254.169.254/latest/meta-data'],
    ['localhost', 'https://localhost/push'],
    ['a look-alike host', 'https://fcm.googleapis.com.evil.example/x'],
    ['a suffix without a dot', 'https://evilnotify.windows.com/x'],
    ['the bare suffix', 'https://notify.windows.com/x'],
    ['an explicit port', 'https://fcm.googleapis.com:8443/fcm/send/abc'],
    ['credentials', 'https://user:pass@fcm.googleapis.com/fcm/send/abc'],
    ['not a URL', 'fcm.googleapis.com/fcm/send/abc'],
  ])('refuses %s', (_, endpoint) => {
    expect(isPushServiceEndpoint(endpoint)).toBe(false)
  })
})

describe('pushEndpointSchema', () => {
  it('refuses an endpoint longer than any push service hands out', () => {
    const long = `https://fcm.googleapis.com/fcm/send/${'a'.repeat(MAX_PUSH_ENDPOINT_LENGTH)}`
    expect(pushEndpointSchema.safeParse(long).success).toBe(false)
  })
})
