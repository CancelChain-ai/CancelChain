import { apiErrorSchema } from '@cancelchain/shared'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { clientIp, RATE_LIMIT, rateLimit, WINDOW_MS } from './rateLimit.js'
import type { AppEnv } from './types.js'

/** Час у тестах рухається руками: чекати хвилину, щоб перевірити вікно, не годиться. */
function appWith(options: Parameters<typeof rateLimit>[0] = {}) {
  const clock = { at: 1_000_000 }
  const app = new Hono<AppEnv>()
  app.use('*', rateLimit({ now: () => clock.at, ...options }))
  app.get('/probe', (c) => c.json({ ok: true }))
  return { app, clock }
}

const IP = { headers: { 'x-forwarded-for': '203.0.113.7' } }

describe('clientIp', () => {
  it('за проксі бере останній запис x-forwarded-for — його дописав довірений вузол', () => {
    const c = {
      req: {
        header: (name: string) => (name === 'x-forwarded-for' ? '1.1.1.1, 2.2.2.2' : undefined),
      },
    } as unknown as Parameters<typeof clientIp>[0]
    expect(clientIp(c)).toBe('2.2.2.2')
  })

  it('без заголовків — один спільний ключ, а не помилка', () => {
    const c = {
      req: { header: () => undefined },
    } as unknown as Parameters<typeof clientIp>[0]
    expect(clientIp(c)).toBe('unknown')
  })
})

describe('rateLimit', () => {
  it('пропускає рівно 60 запитів за хвилину', async () => {
    const { app } = appWith()
    for (let i = 0; i < RATE_LIMIT; i += 1) {
      expect((await app.request('/probe', IP)).status).toBe(200)
    }
    expect((await app.request('/probe', IP)).status).toBe(429)
  })

  it('відмова несе RATE_LIMITED у форматі зі shared і Retry-After', async () => {
    const { app } = appWith({ limit: 2 })
    await app.request('/probe', IP)
    await app.request('/probe', IP)
    const res = await app.request('/probe', IP)
    expect(res.status).toBe(429)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('RATE_LIMITED')
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(res.headers.get('RateLimit-Remaining')).toBe('0')
  })

  it('лічильник залишку зменшується', async () => {
    const { app } = appWith({ limit: 3 })
    expect((await app.request('/probe', IP)).headers.get('RateLimit-Remaining')).toBe('2')
    expect((await app.request('/probe', IP)).headers.get('RateLimit-Remaining')).toBe('1')
    expect((await app.request('/probe', IP)).headers.get('RateLimit-Remaining')).toBe('0')
  })

  it('вікно ковзне: через хвилину після першого запиту місце звільняється по одному', async () => {
    const { app, clock } = appWith({ limit: 2 })
    await app.request('/probe', IP)
    clock.at += 30_000
    await app.request('/probe', IP)
    expect((await app.request('/probe', IP)).status).toBe(429)

    // Минуло вікно від першого запиту — звільнилося рівно одне місце.
    clock.at += WINDOW_MS - 30_000 + 1
    expect((await app.request('/probe', IP)).status).toBe(200)
    expect((await app.request('/probe', IP)).status).toBe(429)
  })

  it('на межі вікна не пропускає подвійну порцію, як фіксоване вікно', async () => {
    const { app, clock } = appWith({ limit: 4 })
    for (let i = 0; i < 4; i += 1) await app.request('/probe', IP)
    // Фіксоване вікно тут відкрило б новий рахунок і пропустило ще 4 поспіль.
    clock.at += WINDOW_MS / 2
    expect((await app.request('/probe', IP)).status).toBe(429)
  })

  it('різні клієнти рахуються окремо', async () => {
    const { app } = appWith({ limit: 1 })
    expect(
      (await app.request('/probe', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status,
    ).toBe(200)
    expect(
      (await app.request('/probe', { headers: { 'x-forwarded-for': '2.2.2.2' } })).status,
    ).toBe(200)
    expect(
      (await app.request('/probe', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status,
    ).toBe(429)
  })

  it('прибирання мертвих ключів не чіпає живого клієнта', async () => {
    // Понад SWEEP_EVERY запитів від «випадкових» клієнтів: прохід прибирання
    // мусить статися й не має скинути лічильник того, хто щойно стукав.
    const { app } = appWith({ limit: 2 })
    for (let i = 0; i < 600; i += 1) {
      await app.request('/probe', { headers: { 'x-forwarded-for': `10.0.${i >> 8}.${i & 255}` } })
    }
    await app.request('/probe', IP)
    await app.request('/probe', IP)
    expect((await app.request('/probe', IP)).status).toBe(429)
  })

  it('x-real-ip використовується, коли проксі не дописав x-forwarded-for', async () => {
    const { app } = appWith({ limit: 1 })
    expect((await app.request('/probe', { headers: { 'x-real-ip': '198.51.100.9' } })).status).toBe(
      200,
    )
    expect((await app.request('/probe', { headers: { 'x-real-ip': '198.51.100.9' } })).status).toBe(
      429,
    )
  })
})
