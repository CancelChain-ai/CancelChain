import { Hono } from 'hono'
import { errorHandler, notFoundHandler } from './errors.js'
import { type Logger, requestLogger } from './logger.js'
import { type RateLimitOptions, rateLimit } from './rateLimit.js'
import { type AllowancesDeps, allowanceRoute, allowancesRoute } from './routes/allowances.js'
import { type BlockhashDeps, blockhashRoute } from './routes/blockhash.js'
import { type HealthDeps, healthRoute } from './routes/health.js'
import type { AppEnv } from './types.js'

export type AppDeps = {
  logger: Logger
  health: HealthDeps
  allowances: AllowancesDeps
  blockhash: BlockhashDeps
  rateLimit?: RateLimitOptions
}

/**
 * Каркас застосунку. Залежності приходять аргументом, а не створюються всередині,
 * — інакше жоден тест не міг би перевірити ані `/health` без бази й вузла мережі,
 * ані ліміт без очікування хвилини.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()

  app.use('*', requestLogger(deps.logger))
  // Ліміт — лише на `/v1/*` (`PLAN.md` → Безпека). `/health` свідомо поза ним:
  // його пінгують healthcheck Railway і keep-alive кожні 14 хв (`T044`), і
  // задушити перевірку живості власним лімітом було б безглуздо.
  app.use('/v1/*', rateLimit(deps.rateLimit))

  app.notFound(notFoundHandler)
  app.onError(errorHandler)

  return app
    .route('/', healthRoute(deps.health))
    .route('/', allowancesRoute(deps.allowances))
    .route('/', allowanceRoute(deps.allowances))
    .route('/', blockhashRoute(deps.blockhash))
}

export type App = ReturnType<typeof createApp>
