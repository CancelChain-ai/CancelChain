import { apiError, type ErrorCode, httpStatusFor } from '@cancelchain/shared'
import type { Context, Env, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './types.js'

/**
 * Єдиний спосіб відповісти помилкою. Тіло будує `apiError` зі `shared`, статус —
 * `httpStatusFor` звідти ж: жоден маршрут не складає ані об'єкта, ані статусу
 * руками, тож дві ручки не можуть відповісти по-різному на те саме.
 */
export function fail<E extends Env, P extends string>(
  c: Context<E, P>,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return c.json(apiError(code, message, details), httpStatusFor(code))
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  fail(c, 'NOT_FOUND', 'no route matches this path')

/** Статуси, які Hono кидає сам (`HTTPException`), у наші коди. */
const CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
}

/**
 * Останній рубіж. Назовні йде рівно `INTERNAL` без тексту винятку: повідомлення
 * помилки несе рядки підключення, SQL і адреси вузлів. Причина лишається в лозі,
 * склеєна з відповіддю через `requestId`.
 */
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const logger = c.get('logger')
  if (err instanceof HTTPException) {
    const code = CODE_BY_STATUS[err.status]
    if (code !== undefined) {
      logger?.warn({ err, status: err.status }, 'request rejected')
      return fail(c, code, err.message)
    }
  }
  logger?.error({ err }, 'unhandled error')
  return fail(c, 'INTERNAL', 'internal error')
}
