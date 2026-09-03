import type { Context, MiddlewareHandler } from 'hono'
import { fail } from './errors.js'
import type { AppEnv } from './types.js'

/** `PLAN.md` → Безпека: 60 запитів/хв на IP на `/v1/*`, `RATE_LIMITED` у відповіді. */
export const RATE_LIMIT = 60
export const WINDOW_MS = 60_000

/**
 * Ковзне вікно: на ключ зберігаються позначки часу запитів за останню хвилину.
 * Фіксоване вікно дешевше, але на межі двох вікон пропускає 120 запитів поспіль
 * — тобто рівно вдвічі більше, ніж написано в плані.
 *
 * Лічильник **у пам'яті процесу**: при двох інстансах ліміт множиться на два.
 * Для одного контейнера на Railway цього досить, і це свідомий компроміс, а не
 * недогляд — спільний лічильник вимагав би Redis, якого в стеку немає.
 */
type Window = number[]

export type RateLimitOptions = {
  limit?: number
  windowMs?: number
  now?: () => number
  /** Чим розрізняються клієнти. Замінюється в тестах; за замовчуванням — IP. */
  clientKey?: (c: Context<AppEnv>) => string
}

/**
 * Прибирання мертвих ключів. Таймера тут немає навмисно: `setInterval` тримав би
 * процес живим і робив би поведінку залежною від годинника в тестах. Замість
 * нього — прохід по мапі раз на `SWEEP_EVERY` запитів.
 */
const SWEEP_EVERY = 512

/**
 * IP клієнта. За проксі (Railway) справжня адреса — **остання** в
 * `x-forwarded-for`: кожен проксі дописує в кінець, тож останній запис поставив
 * найближчий до нас довірений вузол, а перші клієнт може написати сам.
 */
export function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded !== undefined) {
    const parts = forwarded
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    const last = parts.at(-1)
    if (last !== undefined) return last
  }
  return c.req.header('x-real-ip') ?? 'unknown'
}

export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler<AppEnv> {
  const limit = options.limit ?? RATE_LIMIT
  const windowMs = options.windowMs ?? WINDOW_MS
  const now = options.now ?? (() => Date.now())
  const clientKey = options.clientKey ?? clientIp
  const windows = new Map<string, Window>()
  let sinceSweep = 0

  function prune(window: Window, threshold: number): Window {
    // Позначки додаються за зростанням часу, тож достатньо знайти першу живу.
    const firstAlive = window.findIndex((at) => at > threshold)
    return firstAlive === -1 ? [] : window.slice(firstAlive)
  }

  return async (c, next) => {
    const at = now()
    const threshold = at - windowMs
    const key = clientKey(c)

    if (++sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0
      for (const [otherKey, window] of windows) {
        const alive = prune(window, threshold)
        if (alive.length === 0) windows.delete(otherKey)
        else windows.set(otherKey, alive)
      }
    }

    const window = prune(windows.get(key) ?? [], threshold)
    const oldest = window[0]

    if (window.length >= limit && oldest !== undefined) {
      windows.set(key, window)
      const resetSeconds = Math.max(1, Math.ceil((oldest + windowMs - at) / 1000))
      c.header('RateLimit-Limit', String(limit))
      c.header('RateLimit-Remaining', '0')
      c.header('RateLimit-Reset', String(resetSeconds))
      c.header('Retry-After', String(resetSeconds))
      c.get('logger')?.warn({ key, limit, windowMs }, 'rate limited')
      return fail(c, 'RATE_LIMITED', `too many requests: limit is ${limit} per minute`)
    }

    window.push(at)
    windows.set(key, window)
    c.header('RateLimit-Limit', String(limit))
    c.header('RateLimit-Remaining', String(limit - window.length))
    await next()
  }
}
