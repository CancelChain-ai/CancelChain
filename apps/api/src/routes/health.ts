import { healthResponseSchema } from '@cancelchain/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'

/**
 * `GET /health` — `{ ok, slot, lagSeconds }` (`PLAN.md` → API-контракти).
 *
 * Ручка робить дві різні речі, і їх варто не плутати:
 *
 * `ok` — **досяжність залежностей** (Postgres відповідає, RPC відповідає). Саме
 * це питає healthcheck Railway і keep-alive-пінг раз на 14 хв (`T044`), тож
 * порожня база тут не привід відповідати «нездоровий»: щойно розгорнутий сервіс
 * із порожнім кешем працює правильно.
 *
 * `lagSeconds` — **вік найсвіжішого кешованого стану**: скільки секунд минуло з
 * моменту, коли наш знімок мережі востаннє був актуальним (позначка курсора
 * індексатора). Нуль за відсутності курсора був би брехнею — порожній курсор
 * означає не «свіжо», а «нічого немає», — тому відлік тоді йде від старту
 * процесу: щойно піднятий сервіс показує маленьке відставання (це правда), а
 * сервіс, що добу пропрацював без індексатора, показує добу.
 */

export const HEALTH_TIMEOUT_MS = 2_000
/** Індексатора немає до `T038`; до нього `cachedAt` завжди повертає `null`. */
export const UNKNOWN_SLOT = 0

export type HealthDeps = {
  /** Перевірка бази — `select 1` через пулер. */
  ping: () => Promise<void>
  currentSlot: () => Promise<number>
  /** ISO-позначка останнього оновлення курсора індексатора або `null`. */
  cachedAt: () => Promise<string | null>
  /** Момент старту процесу, мс. */
  startedAt: number
  now?: () => number
  timeoutMs?: number
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`dependency did not answer in ${ms} ms`)
    this.name = 'TimeoutError'
  }
}

/**
 * Залежність, що зависла, — не те саме, що залежність, яка відповіла помилкою,
 * але для healthcheck це один результат. Без обмеження часу перевірка живості
 * висить рівно стільки, скільки висить база, і Railway бачить таймаут замість
 * відповіді `ok: false`.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export function healthRoute(deps: HealthDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => Date.now())
  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS

  return new Hono<AppEnv>().get('/health', async (c) => {
    const [db, slot, cached] = await Promise.allSettled([
      withTimeout(deps.ping(), timeoutMs),
      withTimeout(deps.currentSlot(), timeoutMs),
      withTimeout(deps.cachedAt(), timeoutMs),
    ])

    const logger = c.get('logger')
    if (db.status === 'rejected') logger?.error({ err: db.reason }, 'health: database unreachable')
    if (slot.status === 'rejected') logger?.error({ err: slot.reason }, 'health: rpc unreachable')
    if (cached.status === 'rejected') {
      logger?.error({ err: cached.reason }, 'health: indexer cursor unreadable')
    }

    const ok = db.status === 'fulfilled' && slot.status === 'fulfilled'
    const at = now()
    const freshAt =
      cached.status === 'fulfilled' && cached.value !== null
        ? Date.parse(cached.value)
        : deps.startedAt
    if (Number.isNaN(freshAt)) {
      logger?.error(
        { cachedAt: cached.status === 'fulfilled' ? cached.value : null },
        'health: cursor timestamp is not parsable',
      )
    }
    const reference = Number.isNaN(freshAt) ? deps.startedAt : freshAt

    const body = healthResponseSchema.parse({
      ok,
      // Слот невідомий — це `0` поруч із `ok: false`, а не вигадане число:
      // підставити сюди останній відомий означало б показати мережу свіжішою,
      // ніж вона є для нас у цю мить.
      slot: slot.status === 'fulfilled' ? slot.value : UNKNOWN_SLOT,
      // Годинник бази і наш можуть розійтися на секунди; від'ємне відставання
      // не буває, і схема його не приймає.
      lagSeconds: Math.max(0, Math.round((at - reference) / 1000)),
    })

    return c.json(body, ok ? 200 : 503)
  })
}
