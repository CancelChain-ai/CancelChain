import { NotAPlanError, PlanNotFoundError, type PlanSnapshot, toAddress } from '@cancelchain/chain'
import type { Plan } from '@cancelchain/shared'
import {
  apiErrorSchema,
  getPlanResponseSchema,
  MERCHANT_JWT_TTL_SECONDS,
  type SignInMessage,
  signInResponseSchema,
} from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app.js'
import { issueMerchantToken, MIN_JWT_SECRET_LENGTH } from '../auth.js'
import { createLogger } from '../logger.js'
import type { HealthDeps } from './health.js'
import { type MerchantsDeps, planRowFrom } from './merchants.js'

const SECRET = 'c'.repeat(MIN_JWT_SECRET_LENGTH)
const DOMAIN = 'localhost:8879'
const MERCHANT = toAddress('FGHMNoMmKZMSRUPGRyZ8KmSoYaWTgPsudmNXbqjdRSHH')
const STRANGER = toAddress('6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq')
const PLAN_PDA = toAddress('EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg')
const MINT = toAddress('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const SIGNATURE = '5'.repeat(88)
const SLOT = 312_345_678
const SYNCED_AT = '2026-09-24T09:00:00.000Z'

const HEALTH: HealthDeps = {
  ping: async () => {},
  currentSlot: async () => SLOT,
  cachedAt: async () => null,
  startedAt: Date.parse(SYNCED_AT),
  now: () => Date.parse(SYNCED_AT),
}

/** План `EwH6mq…` так, як його віддає devnet (`T034`). */
function snapshot(overrides: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    pda: PLAN_PDA,
    owner: MERCHANT,
    status: 'active',
    planId: 1_789_990_423_243n,
    mint: MINT,
    amount: 9_990_000n,
    periodHours: 720,
    createdAt: '2026-09-21T12:00:00.000Z',
    endsAt: null,
    destinations: [MERCHANT],
    pullers: [MERCHANT],
    metadataUri: '',
    ...overrides,
  }
}

/** Застосунок плюс те, що дійшло до сховища. */
function app(overrides: Partial<MerchantsDeps> = {}) {
  const saved: Plan[] = []
  const merchants: MerchantsDeps = {
    jwtSecret: SECRET,
    domain: DOMAIN,
    plan: async () => snapshot(),
    save: async (plan) => {
      saved.push(plan)
    },
    verifySignature: async () => true,
    ...overrides,
  }
  const deps: AppDeps = {
    logger: createLogger('silent'),
    health: HEALTH,
    allowances: {
      list: async () => ({ slot: SLOT, syncedAt: SYNCED_AT, allowances: [], unreadable: [] }),
      get: async () => ({ slot: SLOT, syncedAt: SYNCED_AT, allowance: null, unreadable: null }),
      cached: async () => null,
      settlementMint: MINT,
    },
    signatures: {
      history: async () => ({ items: [], syncedAt: SYNCED_AT, more: false }),
    },
    merchants,
    blockhash: {
      latestBlockhash: async () => ({
        blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
        lastValidBlockHeight: 492_096_495n,
        slot: SLOT,
      }),
    },
  }
  return { instance: createApp(deps), saved }
}

let nonceCounter = 0

function signIn(message: Partial<SignInMessage> = {}, signature = SIGNATURE) {
  nonceCounter += 1
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        domain: DOMAIN,
        address: MERCHANT,
        nonce: `nonce-${nonceCounter}-${Date.now()}`,
        issuedAt: new Date().toISOString(),
        ...message,
      },
      signature,
    }),
  }
}

function post(token: string | null, body: unknown) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  }
}

async function tokenFor(address: string = MERCHANT): Promise<string> {
  return (await issueMerchantToken(address, SECRET)).token
}

describe('POST /v1/merchants/sign-in', () => {
  it('чесний підпис дає токен на 15 хвилин', async () => {
    const res = await app().instance.request('/v1/merchants/sign-in', signIn())
    expect(res.status).toBe(200)
    const body = signInResponseSchema.parse(await res.json())
    expect(body.address).toBe(MERCHANT)
    const ttl = Date.parse(body.expiresAt) - Date.now()
    expect(ttl).toBeGreaterThan((MERCHANT_JWT_TTL_SECONDS - 30) * 1000)
    expect(ttl).toBeLessThanOrEqual(MERCHANT_JWT_TTL_SECONDS * 1000)
  })

  it('виданий токен одразу відчиняє захищену ручку', async () => {
    const { instance } = app()
    const res = await instance.request('/v1/merchants/sign-in', signIn())
    const { token } = signInResponseSchema.parse(await res.json())
    const stored = await instance.request(
      '/v1/merchants/plans',
      post(token, { planPda: PLAN_PDA, name: 'Pro' }),
    )
    expect(stored.status).toBe(200)
  })

  it('підпис не підійшов — 401', async () => {
    const { instance } = app({ verifySignature: async () => false })
    const res = await instance.request('/v1/merchants/sign-in', signIn())
    expect(res.status).toBe(401)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('UNAUTHORIZED')
  })

  /*
   * Чотири різні причини — одна відповідь, байт у байт. Різниця між ними
   * корисна лише тому, хто підбирає: «домен не той» підказало б, що підпис
   * прийняли б за іншого, а «nonce вже був» — що пара валідна.
   */
  it('усі чотири причини відмови не розрізняються з відповіді', async () => {
    const repeated = signIn({ nonce: 'used-twice' })
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()

    const { instance } = app()
    await instance.request('/v1/merchants/sign-in', repeated)

    const bodies = await Promise.all(
      [
        [instance, signIn({ domain: 'evil.example' })] as const,
        [instance, signIn({ issuedAt: stale })] as const,
        [instance, repeated] as const,
        [app({ verifySignature: async () => false }).instance, signIn()] as const,
      ].map(async ([target, request]) => {
        const res = await target.request('/v1/merchants/sign-in', request)
        expect(res.status).toBe(401)
        return JSON.stringify(await res.json())
      }),
    )
    expect(new Set(bodies).size).toBe(1)
  })

  it('підпис за чужий домен не приймається', async () => {
    const res = await app().instance.request(
      '/v1/merchants/sign-in',
      signIn({ domain: 'evil.example' }),
    )
    expect(res.status).toBe(401)
  })

  it('той самий nonce удруге — теж 401', async () => {
    const { instance } = app()
    const request = signIn({ nonce: 'a-single-use-nonce' })
    expect((await instance.request('/v1/merchants/sign-in', request)).status).toBe(200)
    expect((await instance.request('/v1/merchants/sign-in', request)).status).toBe(401)
  })

  it('підпис, старший за вікно свіжості, не приймається', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const res = await app().instance.request('/v1/merchants/sign-in', signIn({ issuedAt: stale }))
    expect(res.status).toBe(401)
  })

  it('криве тіло — це 400, а не 401', async () => {
    const res = await app().instance.request(
      '/v1/merchants/sign-in',
      post(null, { message: { domain: DOMAIN }, signature: SIGNATURE }),
    )
    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('INVALID_INPUT')
  })
})

describe('POST /v1/merchants/plans', () => {
  it('без токена — 401, і мережу не питали', async () => {
    let asked = 0
    const { instance } = app({
      plan: async () => {
        asked += 1
        return snapshot()
      },
    })
    const res = await instance.request(
      '/v1/merchants/plans',
      post(null, { planPda: PLAN_PDA, name: 'Pro' }),
    )
    expect(res.status).toBe(401)
    expect(asked).toBe(0)
  })

  it('токен, підписаний чужим секретом, не проходить', async () => {
    const { token } = await issueMerchantToken(MERCHANT, 'd'.repeat(MIN_JWT_SECRET_LENGTH))
    const res = await app().instance.request(
      '/v1/merchants/plans',
      post(token, { planPda: PLAN_PDA, name: 'Pro' }),
    )
    expect(res.status).toBe(401)
  })

  it('усе, крім назви, береться з мережі — навіть якщо в тілі лежить інше', async () => {
    const { instance, saved } = app()
    const res = await instance.request(
      '/v1/merchants/plans',
      post(await tokenFor(), {
        planPda: PLAN_PDA,
        name: 'Pro',
        // Цих полів контракт не описує: схема їх відкине, і в рядок потрапить
        // те, що сказала мережа, а не те, що написав мерчант.
        amount: '1',
        merchant: STRANGER,
      }),
    )
    expect(res.status).toBe(200)
    const plan = getPlanResponseSchema.parse(await res.json())
    expect(plan).toEqual({
      pda: PLAN_PDA,
      merchant: MERCHANT,
      planId: '1789990423243',
      name: 'Pro',
      amount: '9990000',
      // 720 годин, а не 720 секунд: одиниці розходяться рівно тут.
      periodSeconds: 720 * 3600,
      mint: MINT,
      createdAt: '2026-09-21T12:00:00.000Z',
    })
    expect(saved).toEqual([plan])
  })

  it('плану в мережі немає — 404, і в базу нічого не пішло', async () => {
    const { instance, saved } = app({
      plan: async () => {
        throw new PlanNotFoundError(PLAN_PDA)
      },
    })
    const res = await instance.request(
      '/v1/merchants/plans',
      post(await tokenFor(), { planPda: PLAN_PDA, name: 'Pro' }),
    )
    expect(res.status).toBe(404)
    expect(saved).toEqual([])
  })

  /*
   * Акаунт за адресою є, але це не план. Знайдено живою перевіркою на devnet:
   * маршрут відповідав `500`, бо цей випадок розбирався в точці збирання
   * застосунку, а не тут — тобто повз усі тести ручки.
   */
  it('акаунт є, але планом не є — теж 404, а не 500', async () => {
    const { instance, saved } = app({
      plan: async () => {
        throw new NotAPlanError(PLAN_PDA, 'it belongs to the system program')
      },
    })
    const res = await instance.request(
      '/v1/merchants/plans',
      post(await tokenFor(), { planPda: PLAN_PDA, name: 'Pro' }),
    )
    expect(res.status).toBe(404)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('NOT_FOUND')
    expect(saved).toEqual([])
  })

  it('мережа впала — це 500, а не «плану немає»', async () => {
    const { instance } = app({
      plan: async () => {
        throw new Error('rpc unreachable')
      },
    })
    const res = await instance.request(
      '/v1/merchants/plans',
      post(await tokenFor(), { planPda: PLAN_PDA, name: 'Pro' }),
    )
    expect(res.status).toBe(500)
  })

  it('чужий план не перейменовується навіть із живим токеном', async () => {
    const { instance, saved } = app()
    const res = await instance.request(
      '/v1/merchants/plans',
      post(await tokenFor(STRANGER), { planPda: PLAN_PDA, name: 'Pro' }),
    )
    expect(res.status).toBe(401)
    const body = apiErrorSchema.parse(await res.json())
    // Переввійти тут не допоможе, і відповідь каже саме це.
    expect(body.error.message).toMatch(/another wallet/)
    expect(saved).toEqual([])
  })

  it('повторний запис міняє назву, а не решту рядка', async () => {
    const { instance, saved } = app()
    const token = await tokenFor()
    await instance.request('/v1/merchants/plans', post(token, { planPda: PLAN_PDA, name: 'Pro' }))
    await instance.request('/v1/merchants/plans', post(token, { planPda: PLAN_PDA, name: 'Pro+' }))
    expect(saved.map((plan) => plan.name)).toEqual(['Pro', 'Pro+'])
    expect(saved[0]?.amount).toBe(saved[1]?.amount)
  })

  it('порожня назва й назва понад 64 символи не проходять', async () => {
    const { instance, saved } = app()
    const token = await tokenFor()
    for (const name of ['', 'x'.repeat(65)]) {
      const res = await instance.request(
        '/v1/merchants/plans',
        post(token, { planPda: PLAN_PDA, name }),
      )
      expect(res.status).toBe(400)
    }
    expect(saved).toEqual([])
  })

  it('адреса, що не є base58, до мережі не доходить', async () => {
    let asked = 0
    const { instance } = app({
      plan: async () => {
        asked += 1
        return snapshot()
      },
    })
    const res = await instance.request(
      '/v1/merchants/plans',
      post(await tokenFor(), { planPda: 'not-an-address', name: 'Pro' }),
    )
    expect(res.status).toBe(400)
    expect(asked).toBe(0)
  })

  it('план без дати створення описати нема чим — 400, не вигадана дата', async () => {
    const { instance, saved } = app({ plan: async () => snapshot({ createdAt: null }) })
    const res = await instance.request(
      '/v1/merchants/plans',
      post(await tokenFor(), { planPda: PLAN_PDA, name: 'Pro' }),
    )
    expect(res.status).toBe(400)
    expect(saved).toEqual([])
  })

  it('план у чужому активі назву отримує — фільтр активу тут не місце', async () => {
    const other = toAddress('So11111111111111111111111111111111111111112')
    const { instance, saved } = app({ plan: async () => snapshot({ mint: other }) })
    const res = await instance.request(
      '/v1/merchants/plans',
      post(await tokenFor(), { planPda: PLAN_PDA, name: 'Pro' }),
    )
    expect(res.status).toBe(200)
    expect(saved[0]?.mint).toBe(other)
  })
})

describe('planRowFrom', () => {
  it('години плану стають секундами сховища, і ніде більше', () => {
    expect(planRowFrom(snapshot(), 'Pro')?.periodSeconds).toBe(2_592_000)
  })

  it('суми їдуть рядками — u64 у double не влазить', () => {
    const row = planRowFrom(snapshot({ amount: 18_446_744_073_709_551_615n }), 'Pro')
    expect(row?.amount).toBe('18446744073709551615')
  })

  it('без дати створення рядка не буде', () => {
    expect(planRowFrom(snapshot({ createdAt: null }), 'Pro')).toBeNull()
  })
})
