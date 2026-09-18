import {
  apiErrorSchema,
  healthResponseSchema,
  listAllowancesQuerySchema,
} from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from './app.js'
import { createLogger } from './logger.js'
import { RATE_LIMIT } from './rateLimit.js'
import type { HealthDeps } from './routes/health.js'
import { validate } from './validate.js'

const SLOT = 312_345_678
const START = Date.parse('2026-09-02T12:00:00.000Z')

function health(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    ping: async () => {},
    currentSlot: async () => SLOT,
    cachedAt: async () => null,
    startedAt: START,
    now: () => START,
    ...overrides,
  }
}

const SYNCED_AT = '2026-09-02T12:00:00.000Z'
const EMPTY_LIST = { slot: SLOT, syncedAt: SYNCED_AT, allowances: [], unreadable: [] }

function app(overrides: Partial<AppDeps> = {}) {
  return createApp({
    logger: createLogger('silent'),
    health: health(),
    allowances: {
      list: async () => EMPTY_LIST,
      get: async () => ({ slot: SLOT, syncedAt: SYNCED_AT, allowance: null, unreadable: null }),
      cached: async () => null,
      settlementMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    },
    signatures: {
      history: async () => ({ items: [], syncedAt: SYNCED_AT, more: false }),
    },
    blockhash: {
      latestBlockhash: async () => ({
        blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
        lastValidBlockHeight: 492_096_495n,
        slot: SLOT,
      }),
    },
    ...overrides,
  })
}

describe('GET /health', () => {
  it('віддає рівно ту форму, яку описує healthResponseSchema зі shared', async () => {
    const res = await app().request('/health')
    expect(res.status).toBe(200)
    const body = healthResponseSchema.parse(await res.json())
    expect(body).toEqual({ ok: true, slot: SLOT, lagSeconds: 0 })
  })

  it('база не відповідає — ok: false і 503', async () => {
    const res = await app({
      health: health({
        ping: () => Promise.reject(new Error('pooler is down')),
      }),
    }).request('/health')
    expect(res.status).toBe(503)
    expect(healthResponseSchema.parse(await res.json()).ok).toBe(false)
  })

  it('вузол мережі не відповідає — slot 0 поруч з ok: false, а не вигадане число', async () => {
    const res = await app({
      health: health({ currentSlot: () => Promise.reject(new Error('rpc timeout')) }),
    }).request('/health')
    expect(res.status).toBe(503)
    expect(healthResponseSchema.parse(await res.json())).toEqual({
      ok: false,
      slot: 0,
      lagSeconds: 0,
    })
  })

  it('залежність, що зависла, дає ok: false, а не зависання перевірки', async () => {
    const res = await app({
      health: health({ ping: () => new Promise<void>(() => {}), timeoutMs: 5 }),
    }).request('/health')
    expect(res.status).toBe(503)
    expect(healthResponseSchema.parse(await res.json()).ok).toBe(false)
  })

  it('відставання рахується від позначки курсора індексатора', async () => {
    const res = await app({
      health: health({
        cachedAt: async () => '2026-09-02T11:59:30.000Z',
        now: () => START,
      }),
    }).request('/health')
    expect(healthResponseSchema.parse(await res.json()).lagSeconds).toBe(30)
  })

  it('курсора немає — відлік від старту процесу, а не нуль', async () => {
    // Нуль тут означав би «свіжо», хоча кешу не існує взагалі (до T038).
    const res = await app({
      health: health({ cachedAt: async () => null, now: () => START + 90_000 }),
    }).request('/health')
    expect(healthResponseSchema.parse(await res.json()).lagSeconds).toBe(90)
  })

  it('нерозбірлива позначка часу не валить ручку — відлік іде від старту', async () => {
    const res = await app({
      health: health({ cachedAt: async () => 'not a timestamp', now: () => START + 5_000 }),
    }).request('/health')
    expect(healthResponseSchema.parse(await res.json()).lagSeconds).toBe(5)
  })

  it('розбіжність годинників не робить відставання від’ємним', async () => {
    const res = await app({
      health: health({ cachedAt: async () => '2026-09-02T12:00:10.000Z', now: () => START }),
    }).request('/health')
    expect(healthResponseSchema.parse(await res.json()).lagSeconds).toBe(0)
  })
})

describe('формат помилки', () => {
  it('невідомий шлях — NOT_FOUND у форматі зі shared', async () => {
    const res = await app().request('/nope')
    expect(res.status).toBe(404)
    const body = apiErrorSchema.parse(await res.json())
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('виняток у маршруті — INTERNAL без тексту винятку назовні', async () => {
    const instance = app()
    instance.get('/v1/boom', () => {
      throw new Error('postgresql://user:secret@host:6543/postgres')
    })
    const res = await instance.request('/v1/boom')
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(apiErrorSchema.parse(JSON.parse(raw)).error.code).toBe('INTERNAL')
    expect(raw).not.toContain('secret')
  })

  it('невалідний запит — INVALID_INPUT із полями, а не власний формат валідатора', async () => {
    const instance = app()
    instance.get('/v1/probe', validate('query', listAllowancesQuerySchema), (c) =>
      c.json(c.req.valid('query')),
    )
    const res = await instance.request('/v1/probe?owner=not-an-address')
    expect(res.status).toBe(400)
    const body = apiErrorSchema.parse(await res.json())
    expect(body.error.code).toBe('INVALID_INPUT')
    expect(body.error.details).toMatchObject({ fieldErrors: { owner: expect.any(Array) } })
  })

  it('валідний запит проходить крізь validate до маршруту', async () => {
    const instance = app()
    const owner = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44'
    instance.get('/v1/probe', validate('query', listAllowancesQuerySchema), (c) =>
      c.json(c.req.valid('query')),
    )
    const res = await instance.request(`/v1/probe?owner=${owner}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ owner })
  })
})

describe('ідентифікатор запиту', () => {
  it('присутній у відповіді', async () => {
    const res = await app().request('/health')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('чужий ідентифікатор зберігається — ланцюжок не рветься', async () => {
    const res = await app().request('/health', { headers: { 'x-request-id': 'trace-42' } })
    expect(res.headers.get('x-request-id')).toBe('trace-42')
  })
})

describe('rate limit у складі застосунку', () => {
  it('ліміт стоїть на /v1/*', async () => {
    const instance = app()
    instance.get('/v1/probe', (c) => c.json({ ok: true }))
    for (let i = 0; i < RATE_LIMIT; i += 1) {
      expect((await instance.request('/v1/probe')).status).toBe(200)
    }
    const res = await instance.request('/v1/probe')
    expect(res.status).toBe(429)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('RATE_LIMITED')
  })

  it('/health поза лімітом — його пінгують кожні 14 хв і перевіряє Railway', async () => {
    const instance = app()
    for (let i = 0; i <= RATE_LIMIT; i += 1) {
      expect((await instance.request('/health')).status).toBe(200)
    }
  })
})

describe('CORS для сторінки на іншому хості', () => {
  const PAGES = 'https://cancelchain-ai.github.io'

  it('без CORS_ORIGINS заголовків немає — лише свій origin', async () => {
    const res = await app().request('/health', { headers: { origin: PAGES } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('названий origin отримує дозвіл на /v1, чужий — ні', async () => {
    const instance = app({ corsOrigins: [PAGES] })
    instance.get('/v1/probe', (c) => c.json({ ok: true }))

    const ours = await instance.request('/v1/probe', { headers: { origin: PAGES } })
    expect(ours.headers.get('access-control-allow-origin')).toBe(PAGES)

    const theirs = await instance.request('/v1/probe', {
      headers: { origin: 'https://someone-else.example' },
    })
    expect(theirs.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('preflight відповідає без тіла і без ліміту', async () => {
    const instance = app({ corsOrigins: [PAGES] })
    const res = await instance.request('/v1/allowances?owner=x', {
      method: 'OPTIONS',
      headers: { origin: PAGES, 'access-control-request-method': 'GET' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGES)
  })

  it('429 теж несе заголовок — інакше браузер покаже його як мережевий збій', async () => {
    const instance = app({ corsOrigins: [PAGES] })
    instance.get('/v1/probe', (c) => c.json({ ok: true }))
    for (let i = 0; i < RATE_LIMIT; i += 1) await instance.request('/v1/probe')
    const res = await instance.request('/v1/probe', { headers: { origin: PAGES } })
    expect(res.status).toBe(429)
    expect(res.headers.get('access-control-allow-origin')).toBe(PAGES)
  })
})
