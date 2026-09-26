import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { errorHandler, notFoundHandler } from './errors.js'
import { type Logger, requestLogger } from './logger.js'
import { type RateLimitOptions, rateLimit } from './rateLimit.js'
import { type AllowancesDeps, allowanceRoute, allowancesRoute } from './routes/allowances.js'
import { type BlockhashDeps, blockhashRoute } from './routes/blockhash.js'
import { type HealthDeps, healthRoute } from './routes/health.js'
import { type MerchantsDeps, merchantPlansRoute, merchantSignInRoute } from './routes/merchants.js'
import { type PlansDeps, plansRoute } from './routes/plans.js'
import { type SignaturesDeps, signaturesRoute } from './routes/signatures.js'
import type { AppEnv } from './types.js'

export type AppDeps = {
  logger: Logger
  health: HealthDeps
  allowances: AllowancesDeps
  blockhash: BlockhashDeps
  signatures: SignaturesDeps
  merchants: MerchantsDeps
  plans: PlansDeps
  rateLimit?: RateLimitOptions
  /**
   * Origin-и браузерів, яким можна читати `/v1` з іншого хоста (сторінка на
   * GitHub Pages, API на Render). Порожньо або не задано — заголовків CORS
   * немає взагалі, тобто лише свій origin.
   */
  corsOrigins?: readonly string[]
}

/**
 * Каркас застосунку. Залежності приходять аргументом, а не створюються всередині,
 * — інакше жоден тест не міг би перевірити ані `/health` без бази й вузла мережі,
 * ані ліміт без очікування хвилини.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()

  app.use('*', requestLogger(deps.logger))
  // CORS стоїть **перед** лімітом: інакше `429` приходить без заголовків, і
  // браузер показує його як мережевий збій, а не як названу відмову.
  if (deps.corsOrigins !== undefined && deps.corsOrigins.length > 0) {
    app.use(
      '/v1/*',
      cors({
        origin: [...deps.corsOrigins],
        // POST — це вхід мерчанта й назва плану (`T035`); `Authorization`
        // без цього переліку браузер у крос-доменний запит просто не покладе.
        allowMethods: ['GET', 'POST'],
        allowHeaders: ['Content-Type', 'Authorization'],
      }),
    )
  }
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
    .route('/', signaturesRoute(deps.signatures))
    .route('/', blockhashRoute(deps.blockhash))
    .route('/', merchantSignInRoute(deps.merchants))
    .route('/', merchantPlansRoute(deps.merchants))
    .route('/', plansRoute(deps.plans))
}

export type App = ReturnType<typeof createApp>
