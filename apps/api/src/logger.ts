import type { MiddlewareHandler } from 'hono'
import { type Logger as PinoLogger, pino } from 'pino'
import type { LogLevel } from './env.js'

export type Logger = PinoLogger

/**
 * Один рядок JSON на запит. Railway збирає stdout, тож жодного транспорту тут
 * немає: `pino-pretty` — справа розробника локально, не залежність сервісу.
 */
export function createLogger(level: LogLevel, base?: Record<string, unknown>): Logger {
  return pino({
    level,
    base: { service: 'api', ...base },
    // Час у логах — ISO в UTC, як і всюди в системі (`timestampSchema`).
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      // Заголовки авторизації мерчанта не мають права опинитися в логах.
      paths: ['req.headers.authorization', 'req.headers.cookie'],
      remove: true,
    },
  })
}

export type LoggerVariables = {
  logger: Logger
  requestId: string
}

/** Заголовок для зв'язки логу з конкретною відповіддю. */
export const REQUEST_ID_HEADER = 'x-request-id'

/**
 * Лог запиту з ідентифікатором. Чужий `x-request-id` приймається — Railway і
 * браузер уміють його передавати, а склеєний ланцюжок вартий більше, ніж
 * гарантія унікальності: підроблений id псує лише власний слід клієнта.
 */
export function requestLogger(
  logger: Logger,
  now: () => number = () => Date.now(),
): MiddlewareHandler<{ Variables: LoggerVariables }> {
  return async (c, next) => {
    const requestId = c.req.header(REQUEST_ID_HEADER) ?? crypto.randomUUID()
    const child = logger.child({ requestId })
    c.set('requestId', requestId)
    c.set('logger', child)
    c.header(REQUEST_ID_HEADER, requestId)

    const startedAt = now()
    await next()
    child.info(
      {
        method: c.req.method,
        // `path` без query: у рядку запиту їде адреса гаманця, і зайвий раз
        // писати її в лог немає потреби — ручка й так видно з `path`.
        path: c.req.path,
        status: c.res.status,
        durationMs: now() - startedAt,
      },
      'request',
    )
  }
}
