import {
  chainConfigFromEnv,
  createChainClient,
  readAddressHistory,
  readAllowance,
  readAllowances,
  readPlan,
  readSubscriberState,
  toAddress,
  verifyWalletSignature,
} from '@cancelchain/chain'
import { allowances, indexerCursor, plans } from '@cancelchain/db'
import type { Allowance, Plan } from '@cancelchain/shared'
import { allowanceSchema, fromU64, planSchema, toU64 } from '@cancelchain/shared'
import { serve } from '@hono/node-server'
import { desc, eq } from 'drizzle-orm'
import { createApp } from './app.js'
import { createDb, type Db } from './db.js'
import { apiConfigFromEnv, merchantAuthConfig } from './env.js'
import { createLogger } from './logger.js'

/**
 * Точка входу сервісу. Усе, що тут відбувається, — читання оточення, створення
 * залежностей і передача їх у `createApp`; сама логіка живе в модулях, які
 * перевіряються без сокета й без мережі.
 */

/**
 * Найсвіжіша позначка курсора індексатора. До `T038` таблиця порожня, і `null`
 * тут означає рівно «індексатора ще немає» — див. `lagSeconds` у `routes/health.ts`.
 */
async function latestCursorAt(db: Db): Promise<string | null> {
  const rows = await db
    .select({ updatedAt: indexerCursor.updatedAt })
    .from(indexerCursor)
    .orderBy(desc(indexerCursor.updatedAt))
    .limit(1)
  return rows[0]?.updatedAt ?? null
}

/**
 * Збережений дозвіл із кеша. До `T038` таблиця порожня, і запит завжди дає
 * `null` — але не заглушка: рядок з'явиться в ту саму мить, коли індексатор
 * почне писати, і звірка (`FR-024`) запрацює без правок у маршруті.
 *
 * Схема зі `shared` проганяється й тут: рядок у базі писав інший процес, і
 * довіряти його формі на слово означало б пустити невалідний статус на картку.
 */
async function cachedAllowance(db: Db, pda: string): Promise<Allowance | null> {
  const rows = await db.select().from(allowances).where(eq(allowances.pda, pda)).limit(1)
  const row = rows[0]
  return row === undefined ? null : allowanceSchema.parse(row)
}

/**
 * Рядок каталогу планів. Назва — єдине, що прийшло від мерчанта; решта полів
 * уже прочитана з мережі (`routes/merchants.ts`), і повторний запис тими
 * самими значеннями оновлює саме назву.
 *
 * Суми в сховищі — `bigint`, у контракті API — рядки (`u64Schema`). Конвертація
 * стоїть рівно тут, на межі, і ніде більше.
 */
async function savePlan(db: Db, plan: Plan): Promise<void> {
  const fields = {
    merchant: plan.merchant,
    planId: toU64(plan.planId),
    name: plan.name,
    amount: toU64(plan.amount),
    periodSeconds: plan.periodSeconds,
    mint: plan.mint,
    createdAt: plan.createdAt,
  }
  await db
    .insert(plans)
    .values({ pda: plan.pda, ...fields })
    .onConflictDoUpdate({ target: plans.pda, set: fields })
}

/**
 * The catalog row for a plan, or `null`. Throws when storage cannot be reached —
 * the route turns that into `catalog: unavailable`, not into "no row".
 *
 * `created_at` comes back from Postgres as `2026-09-21 10:00:00+00`, not as ISO
 * 8601, so it is normalised here; the shared schema would refuse the raw form.
 */
async function catalogPlan(db: Db, pda: string): Promise<Plan | null> {
  const rows = await db.select().from(plans).where(eq(plans.pda, pda)).limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return planSchema.parse({
    ...row,
    planId: fromU64(row.planId),
    amount: fromU64(row.amount),
    createdAt: new Date(row.createdAt).toISOString(),
  })
}

function main(): void {
  const startedAt = Date.now()
  const config = apiConfigFromEnv(process.env)
  const logger = createLogger(config.logLevel)
  // Кидає на mainnet без явного дозволу — сервер читає чужі гроші лише на devnet.
  const chain = createChainClient(chainConfigFromEnv(process.env))
  // Кидає при старті, якщо секрет або домен не налаштовані: `401` на чесному
  // підписі — найгірший спосіб дізнатися про порожній `JWT_SECRET`.
  const auth = merchantAuthConfig(config)
  const database = createDb(config)

  const app = createApp({
    logger,
    corsOrigins: config.corsOrigins,
    health: {
      ping: database.ping,
      currentSlot: async () => Number(await chain.rpc.getSlot({ commitment: 'confirmed' }).send()),
      cachedAt: () => latestCursorAt(database.db),
      startedAt,
    },
    allowances: {
      // До індексатора (`T038`) список читається з мережі на кожен запит; сховище
      // в цьому шляху не бере участі взагалі.
      list: (owner) => readAllowances(chain, { owner: toAddress(owner) }),
      get: (pda) => readAllowance(chain, { pda: toAddress(pda) }),
      cached: (pda) => cachedAllowance(database.db, pda),
      settlementMint: chain.usdcMint,
    },
    signatures: {
      // Стрічка на вимогу (`T030`): сховище порожнє до `T038`, тож історія
      // адреси береться з мережі на кожен запит картки.
      history: (pda, limit) => readAddressHistory(chain, { address: toAddress(pda), limit }),
    },
    merchants: {
      jwtSecret: auth.jwtSecret,
      domain: auth.domain,
      // Помилки читання плану розбирає сам маршрут — див. `routes/merchants.ts`.
      plan: (pda) => readPlan(chain.rpc, toAddress(pda), { commitment: 'confirmed' }),
      save: (plan) => savePlan(database.db, plan),
      verifySignature: (input) =>
        verifyWalletSignature({
          address: toAddress(input.address),
          signature: input.signature,
          message: input.message,
        }),
    },
    plans: {
      plan: (pda) => readPlan(chain.rpc, toAddress(pda), { commitment: 'confirmed' }),
      catalog: (pda) => catalogPlan(database.db, pda),
      settlementMint: chain.usdcMint,
      subscriber: async ({ subscriber, plan }) => {
        const state = await readSubscriberState(
          chain.rpc,
          { subscriber, planPda: plan.pda, mint: plan.mint },
          { commitment: 'confirmed' },
        )
        return {
          ...state,
          authorityInitId: state.authorityInitId === null ? null : fromU64(state.authorityInitId),
        }
      },
    },
    blockhash: {
      // `confirmed`, як і слот у `/health`: `finalized` дав би хеш на пів
      // хвилини старший, тобто вкоротив би вікно, у якому гаманець ще встигає
      // надіслати підписану транзакцію.
      latestBlockhash: async () => {
        const { context, value } = await chain.rpc
          .getLatestBlockhash({ commitment: 'confirmed' })
          .send()
        return {
          blockhash: value.blockhash,
          lastValidBlockHeight: value.lastValidBlockHeight,
          slot: Number(context.slot),
        }
      },
    },
  })

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    logger.info({ port: info.port, cluster: chain.cluster }, 'api listening')
  })

  // Railway надсилає SIGTERM при перевикатці. Без цього пул до пулера лишається
  // відкритим до таймауту, а конекшенів на free tier усього два.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down')
      server.close(() => {
        void database.close().finally(() => process.exit(0))
      })
    })
  }
}

main()
