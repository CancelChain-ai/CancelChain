import {
  chainConfigFromEnv,
  createChainClient,
  readAllowance,
  readAllowances,
  toAddress,
} from '@cancelchain/chain'
import { allowances, indexerCursor } from '@cancelchain/db'
import type { Allowance } from '@cancelchain/shared'
import { allowanceSchema } from '@cancelchain/shared'
import { serve } from '@hono/node-server'
import { desc, eq } from 'drizzle-orm'
import { createApp } from './app.js'
import { createDb, type Db } from './db.js'
import { apiConfigFromEnv } from './env.js'
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

function main(): void {
  const startedAt = Date.now()
  const config = apiConfigFromEnv(process.env)
  const logger = createLogger(config.logLevel)
  // Кидає на mainnet без явного дозволу — сервер читає чужі гроші лише на devnet.
  const chain = createChainClient(chainConfigFromEnv(process.env))
  const database = createDb(config)

  const app = createApp({
    logger,
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
