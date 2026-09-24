import type { MerchantVariables } from './auth.js'
import type { LoggerVariables } from './logger.js'

/**
 * Оточення Hono для всього застосунку. Виділене окремо, щоб маршрути,
 * middleware й обробники помилок бачили однаковий `c.get('logger')` — інакше
 * кожен файл оголошував би свій і типи розходилися б мовчки.
 */
export type AppEnv = {
  /**
   * `merchant` ставить лише `merchantAuth` і лише на захищених маршрутах, тож
   * у решті він `undefined` — Hono саме так типізує змінні, які middleware
   * міг не поставити. Читати його без `merchantAuth` попереду безглуздо.
   */
  Variables: LoggerVariables & Partial<MerchantVariables>
}
