import { createECDH } from 'node:crypto'
import { z } from 'zod'

/**
 * The installation's VAPID identity (`T043`) — the same three variables for the
 * API (the welcome push) and the indexer (everything else).
 *
 * All three or none. None is a valid installation: push is off, every function
 * still works and every event is in the feed (`FR-027`). Some of them is not —
 * it is a typo, and a typo here fails silently, far from its cause: every push
 * answered `403` by the push service while the page says "Notifications on".
 */
export type VapidConfig = {
  /** base64url, uncompressed P-256 point: what the browser subscribes with. */
  publicKey: string
  /** base64url, 32 bytes. */
  privateKey: string
  /** `mailto:` or `https:` — how a push service reaches whoever runs this. */
  subject: string
}

export class PushNotConfiguredError extends Error {
  constructor(detail: string) {
    super(
      `push is half-configured: ${detail}. Set all of VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY ` +
        'and VAPID_SUBJECT (mailto: or https:), or none of them to run without push. ' +
        'A key pair: `npx web-push generate-vapid-keys`.',
    )
    this.name = 'PushNotConfiguredError'
  }
}

const base64url = /^[A-Za-z0-9_-]+$/

const subjectSchema = z.string().refine((value) => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'mailto:' || protocol === 'https:'
  } catch {
    return false
  }
})

/** Reads any map of strings, as the other `*FromEnv` do — testable without globals. */
export function vapidFromEnv(env: Record<string, string | undefined>): VapidConfig | null {
  const given = {
    VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY?.trim() ?? '',
    VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY?.trim() ?? '',
    VAPID_SUBJECT: env.VAPID_SUBJECT?.trim() ?? '',
  }
  const missing = Object.entries(given).flatMap(([name, value]) => (value === '' ? [name] : []))
  if (missing.length === 3) return null
  if (missing.length > 0) throw new PushNotConfiguredError(`${missing.join(', ')} is empty`)

  const config = {
    publicKey: given.VAPID_PUBLIC_KEY,
    privateKey: given.VAPID_PRIVATE_KEY,
    subject: given.VAPID_SUBJECT,
  }
  if (!subjectSchema.safeParse(config.subject).success) {
    throw new PushNotConfiguredError('VAPID_SUBJECT is neither a mailto: nor an https: URL')
  }
  const derived = publicKeyOf(config.privateKey)
  if (derived === null) {
    throw new PushNotConfiguredError('VAPID_PRIVATE_KEY is not a base64url P-256 private key')
  }
  // Two keys from two different pairs pass every format check, and then every
  // push service refuses every push: the browser subscribed with one key and
  // the server signs with the other.
  if (derived !== config.publicKey.replace(/=+$/, '')) {
    throw new PushNotConfiguredError('VAPID_PUBLIC_KEY is not the public half of VAPID_PRIVATE_KEY')
  }
  return config
}

/** The public key a private one makes, or `null` when it is not a P-256 private key. */
function publicKeyOf(privateKey: string): string | null {
  const bare = privateKey.replace(/=+$/, '')
  if (!base64url.test(bare)) return null
  const bytes = Buffer.from(bare, 'base64url')
  if (bytes.length !== 32) return null
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(bytes)
    return ecdh.getPublicKey().toString('base64url')
  } catch {
    return null
  }
}
