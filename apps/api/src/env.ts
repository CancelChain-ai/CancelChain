import { z } from 'zod'

/**
 * Оточення API. Читається з будь-якої мапи рядків, а не напряму з `process.env`,
 * — так конфігурацію можна перевірити тестом без глобального стану (той самий
 * прийом, що й `chainConfigFromEnv` у `packages/chain`).
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * Порт transaction pooler'а Supabase. Пряме підключення на 5432 на free tier
 * дає **2 конекшени на всі сервіси**, а їх у нас двоє (`api`, `indexer`), тож
 * другий сервіс не підніметься. Плюс pgbouncer у transaction mode не вміє
 * prepared statements — звідси `prepare: false` у `db.ts`.
 */
export const POOLER_PORT = 6543

export const DEFAULT_PORT = 8080

function postgresUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:' ? url : null
  } catch {
    return null
  }
}

const databaseUrlSchema = z
  .string()
  .refine((value) => postgresUrl(value) !== null, 'expected a postgres:// connection string')

export const apiConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65_535).default(DEFAULT_PORT),
  databaseUrl: databaseUrlSchema,
  logLevel: z.enum(LOG_LEVELS).default('info'),
  /**
   * Знімає вимогу підключатися через pooler. За замовчуванням `false`: помилковий
   * `5432` у `.env` не падає одразу, він падає під навантаженням і на **іншому**
   * сервісі — далеко від причини. Прапорець потрібен локальному Postgres у тестах.
   */
  allowDirectDatabase: z.boolean().default(false),
})

export type ApiConfig = z.infer<typeof apiConfigSchema>

export class DirectDatabaseConnectionError extends Error {
  constructor(port: string) {
    super(
      `DATABASE_URL points at port ${port || '(default)'}, not the transaction pooler ` +
        `(${POOLER_PORT}). Supabase free tier gives 2 direct connections for both services. ` +
        'Set ALLOW_DIRECT_DATABASE=true to opt in explicitly.',
    )
    this.name = 'DirectDatabaseConnectionError'
  }
}

/** Порт із рядка підключення. `null`, якщо рядок не є postgres-URL. */
export function databasePort(databaseUrl: string): string | null {
  return postgresUrl(databaseUrl)?.port ?? null
}

/** Кидає, якщо підключення не через pooler і виняток не дозволено явно. */
export function assertPooledDatabase(config: ApiConfig): void {
  if (config.allowDirectDatabase) return
  const port = databasePort(config.databaseUrl)
  if (port !== String(POOLER_PORT)) throw new DirectDatabaseConnectionError(port ?? '')
}

function boolFromEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  return value === 'true' || value === '1'
}

export function apiConfigFromEnv(env: Record<string, string | undefined>): ApiConfig {
  return apiConfigSchema.parse({
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL,
    allowDirectDatabase: boolFromEnv(env.ALLOW_DIRECT_DATABASE),
  })
}
