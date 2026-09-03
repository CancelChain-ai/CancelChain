import type { LoggerVariables } from './logger.js'

/**
 * Оточення Hono для всього застосунку. Виділене окремо, щоб маршрути,
 * middleware й обробники помилок бачили однаковий `c.get('logger')` — інакше
 * кожен файл оголошував би свій і типи розходилися б мовчки.
 */
export type AppEnv = {
  Variables: LoggerVariables
}
