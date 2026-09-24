import {
  MERCHANT_JWT_TTL_SECONDS,
  SIGN_IN_MAX_AGE_SECONDS,
  type SignInMessage,
} from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import {
  bearerToken,
  issueMerchantToken,
  MIN_JWT_SECRET_LENGTH,
  merchantFromToken,
  NonceLog,
  verifySignIn,
} from './auth.js'

const SECRET = 'a'.repeat(MIN_JWT_SECRET_LENGTH)
const OTHER_SECRET = 'b'.repeat(MIN_JWT_SECRET_LENGTH)
const MERCHANT = 'FGHMNo1111111111111111111111111111111111111'
const NOW = new Date('2026-09-24T09:00:00.000Z')

function message(overrides: Partial<SignInMessage> = {}): SignInMessage {
  return {
    domain: 'localhost:8879',
    address: MERCHANT,
    nonce: 'a1b2c3d4e5f6',
    issuedAt: NOW.toISOString(),
    ...overrides,
  }
}

const accepts = async () => true

describe('токен мерчанта', () => {
  it('живе рівно 15 хвилин і каже це датою, а не тривалістю', async () => {
    const issued = await issueMerchantToken(MERCHANT, SECRET, NOW)
    expect(issued.address).toBe(MERCHANT)
    expect(Date.parse(issued.expiresAt) - NOW.getTime()).toBe(MERCHANT_JWT_TTL_SECONDS * 1000)
  })

  /*
   * Видається токен на справжній годинник: `exp` перевіряє `hono/jwt` проти
   * поточного часу, і підставний `NOW` із фікстур тут означав би токен, що
   * протух ще до перевірки.
   */
  it('читається назад тим самим секретом', async () => {
    const { token } = await issueMerchantToken(MERCHANT, SECRET)
    expect(await merchantFromToken(token, SECRET)).toBe(MERCHANT)
  })

  it('чужим секретом не читається — і це не виняток', async () => {
    const { token } = await issueMerchantToken(MERCHANT, SECRET)
    await expect(merchantFromToken(token, OTHER_SECRET)).resolves.toBeNull()
  })

  it('протухлий токен не приймається', async () => {
    const past = new Date(Date.now() - (MERCHANT_JWT_TTL_SECONDS + 60) * 1000)
    const { token } = await issueMerchantToken(MERCHANT, SECRET, past)
    expect(await merchantFromToken(token, SECRET)).toBeNull()
  })

  it('сміття замість токена — null, не виняток', async () => {
    for (const bad of ['', 'not.a.jwt', 'a.b', 'eyJhbGciOiJub25lIn0..']) {
      await expect(merchantFromToken(bad, SECRET)).resolves.toBeNull()
    }
  })
})

describe('bearerToken', () => {
  it('бере токен лише зі схеми Bearer', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken('abc.def.ghi')).toBeNull()
    expect(bearerToken('Basic abc')).toBeNull()
    expect(bearerToken('bearer abc')).toBeNull()
    expect(bearerToken('Bearer ')).toBeNull()
    expect(bearerToken('Bearer a b')).toBeNull()
  })
})

describe('NonceLog', () => {
  it('той самий nonce вдруге не проходить', () => {
    const log = new NonceLog(60)
    expect(log.claim('n1', 0)).toBe(true)
    expect(log.claim('n1', 0)).toBe(false)
    expect(log.claim('n2', 0)).toBe(true)
  })

  it('після вікна свіжості значення забувається — бо старий підпис відсіється й так', () => {
    const log = new NonceLog(60)
    expect(log.claim('n1', 0)).toBe(true)
    expect(log.claim('n1', 60_001)).toBe(true)
  })
})

describe('verifySignIn', () => {
  it('свіжий підпис за свій домен приймається', async () => {
    const rejection = await verifySignIn({
      message: message(),
      signature: 'sig',
      domain: 'localhost:8879',
      now: NOW,
      nonces: new NonceLog(),
      verify: accepts,
    })
    expect(rejection).toBeNull()
  })

  it('чужий домен — відмова, і криптографію не турбували', async () => {
    let called = 0
    const rejection = await verifySignIn({
      message: message({ domain: 'evil.example' }),
      signature: 'sig',
      domain: 'localhost:8879',
      now: NOW,
      nonces: new NonceLog(),
      verify: async () => {
        called += 1
        return true
      },
    })
    expect(rejection).toBe('domain')
    expect(called).toBe(0)
  })

  it('підпис, старший за вікно, не приймається', async () => {
    const late = new Date(NOW.getTime() + (SIGN_IN_MAX_AGE_SECONDS + 1) * 1000)
    const rejection = await verifySignIn({
      message: message(),
      signature: 'sig',
      domain: 'localhost:8879',
      now: late,
      nonces: new NonceLog(),
      verify: accepts,
    })
    expect(rejection).toBe('stale')
  })

  it('вікно симетричне: годинник клієнта на секунду вперед не ламає вхід', async () => {
    const nonces = new NonceLog()
    const early = new Date(NOW.getTime() - 1000)
    expect(
      await verifySignIn({
        message: message(),
        signature: 'sig',
        domain: 'localhost:8879',
        now: early,
        nonces,
        verify: accepts,
      }),
    ).toBeNull()

    const tooEarly = new Date(NOW.getTime() - (SIGN_IN_MAX_AGE_SECONDS + 1) * 1000)
    expect(
      await verifySignIn({
        message: message({ nonce: 'other-nonce-1' }),
        signature: 'sig',
        domain: 'localhost:8879',
        now: tooEarly,
        nonces,
        verify: accepts,
      }),
    ).toBe('stale')
  })

  it('той самий підпис удруге — повтор, навіть у межах вікна', async () => {
    const nonces = new NonceLog()
    const input = {
      message: message(),
      signature: 'sig',
      domain: 'localhost:8879',
      now: NOW,
      nonces,
      verify: accepts,
    }
    expect(await verifySignIn(input)).toBeNull()
    expect(await verifySignIn(input)).toBe('replay')
  })

  /*
   * Nonce «витрачається» до перевірки підпису навмисно. Інакше чужий валідний
   * nonce можна було б зайняти лише разом із чесним підписом — тобто не можна;
   * а заповнити лог вигаданими парами змогла б будь-яка спроба.
   */
  it('невалідний підпис теж витрачає nonce', async () => {
    const nonces = new NonceLog()
    const input = {
      message: message(),
      signature: 'sig',
      domain: 'localhost:8879',
      now: NOW,
      nonces,
      verify: async () => false,
    }
    expect(await verifySignIn(input)).toBe('signature')
    expect(await verifySignIn({ ...input, verify: accepts })).toBe('replay')
  })

  it('перевіряється рівно той текст, що описує signInMessageText', async () => {
    let seen: Uint8Array | null = null
    await verifySignIn({
      message: message(),
      signature: 'sig',
      domain: 'localhost:8879',
      now: NOW,
      nonces: new NonceLog(),
      verify: async (input) => {
        seen = input.message
        return true
      },
    })
    const text = new TextDecoder().decode(seen ?? new Uint8Array())
    expect(text).toContain('localhost:8879 wants you to sign in')
    expect(text).toContain(MERCHANT)
    expect(text).toContain('Nonce: a1b2c3d4e5f6')
  })
})
