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
import { plans, STREAM_CHANNEL } from '@cancelchain/db'
import { indexerConfigFromEnv, startIndexer } from '@cancelchain/indexer'
import { createPushSender, vapidFromEnv, welcomeMessage } from '@cancelchain/push'
import type { Plan } from '@cancelchain/shared'
import { fromU64, planSchema, toU64 } from '@cancelchain/shared'
import { serve } from '@hono/node-server'
import { eq } from 'drizzle-orm'
import { createApp } from './app.js'
import { readCachedAllowance } from './cache.js'
import { createDb, type Db, listenConnection } from './db.js'
import { apiConfigFromEnv, listenDatabaseUrl, merchantAuthConfig } from './env.js'
import { heartbeatAt, readEvent, readFeed, readRetention } from './feed.js'
import { startListener } from './listen.js'
import { createLogger } from './logger.js'
import { hasPushSubscription, removePushSubscriptions, savePushSubscription } from './push.js'
import type { PushDeps } from './routes/push.js'
import { createStreamHub } from './stream.js'
import { superviseIndexer } from './supervise.js'

/**
 * Точка входу сервісу. Усе, що тут відбувається, — читання оточення, створення
 * залежностей і передача їх у `createApp`; сама логіка живе в модулях, які
 * перевіряються без сокета й без мережі.
 */

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

async function main(): Promise<void> {
  const startedAt = Date.now()
  const config = apiConfigFromEnv(process.env)
  const logger = createLogger(config.logLevel)
  // Кидає на mainnet без явного дозволу — сервер читає чужі гроші лише на devnet.
  const chain = createChainClient(chainConfigFromEnv(process.env))
  // Кидає при старті, якщо секрет або домен не налаштовані: `401` на чесному
  // підписі — найгірший спосіб дізнатися про порожній `JWT_SECRET`.
  const auth = merchantAuthConfig(config)
  // Throws at start too: a stream that never hears the database looks exactly
  // like a quiet wallet (`T042`).
  const listenUrl = listenDatabaseUrl(config)
  const database = createDb(config)
  // Throws on a half-set VAPID trio; none at all is push off (`T043`, `FR-027`).
  const vapid = vapidFromEnv(process.env)
  if (vapid === null)
    logger.warn('push is off: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT are not set')
  const push: PushDeps | undefined =
    vapid === null
      ? undefined
      : (() => {
          const sender = createPushSender({ vapid })
          return {
            publicKey: vapid.publicKey,
            has: (body) => hasPushSubscription(database.db, body),
            save: (body) => savePushSubscription(database.db, body),
            remove: (body) => removePushSubscriptions(database.db, body),
            // Short-lived: a browser that is offline right now gains nothing
            // from hearing "notifications are on" tomorrow.
            probe: (body) =>
              sender.send(
                { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth },
                welcomeMessage(body.owner),
                { ttlSeconds: 300, urgency: 'normal' },
              ),
          }
        })()
  const hub = createStreamHub({
    read: {
      allowance: (pda) => readCachedAllowance(database.db, pda),
      event: (id) => readEvent(database.db, id),
    },
    logger,
  })

  const app = createApp({
    logger,
    corsOrigins: config.corsOrigins,
    health: {
      ping: database.ping,
      currentSlot: async () => Number(await chain.rpc.getSlot({ commitment: 'confirmed' }).send()),
      // The indexer's pulse, not its cursor: the cursor stands still whenever
      // the program is quiet, the pulse only when the indexer is (`T041`).
      cachedAt: () => heartbeatAt(database.db),
      startedAt,
    },
    allowances: {
      // До індексатора (`T038`) список читається з мережі на кожен запит; сховище
      // в цьому шляху не бере участі взагалі.
      // `confirmed`, as everywhere else here: without it the node answers at
      // `finalized`, ~13 s behind, and a subscription just signed stays invisible
      // longer than `SC-010` allows (`T037`).
      list: (owner, minSlot) =>
        readAllowances(chain, {
          owner: toAddress(owner),
          commitment: 'confirmed',
          ...(minSlot === undefined ? {} : { minContextSlot: minSlot }),
        }),
      get: (pda, minSlot) =>
        readAllowance(chain, {
          pda: toAddress(pda),
          commitment: 'confirmed',
          ...(minSlot === undefined ? {} : { minContextSlot: minSlot }),
        }),
      cached: (pda) => readCachedAllowance(database.db, pda),
      settlementMint: chain.usdcMint,
    },
    events: {
      feed: (pda, page) => readFeed(database.db, pda, page),
      aliveAt: () => heartbeatAt(database.db),
      retention: () => readRetention(database.db),
    },
    stream: { hub },
    push,
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

  // One free web service for both (`T044`): the indexer starts in this process,
  // before the server binds, so a health check never sees an API whose worker
  // is still missing. Its own pool, its own logger name.
  const indexer = config.runIndexer
    ? await startIndexer({
        config: indexerConfigFromEnv(process.env),
        vapid,
        log: createLogger(config.logLevel, { service: 'indexer' }),
      })
    : null

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    logger.info({ port: info.port, cluster: chain.cluster }, 'api listening')
  })

  const listener = startListener({
    connect: () => listenConnection(listenUrl),
    notify: async (channel, payload) => {
      await database.sql.notify(channel, payload)
    },
    channel: STREAM_CHANNEL,
    onNotice: (payload) => void hub.notify(payload),
    onListen: () => hub.resync(),
    logger,
  })

  // Railway надсилає SIGTERM при перевикатці. Без цього пул до пулера лишається
  // відкритим до таймауту, а конекшенів на free tier усього два.
  let stopping = false
  const shutdown = (code: number) => {
    if (stopping) return
    stopping = true
    // Open streams would keep `server.close` waiting forever: end them first.
    hub.close()
    server.close(() => {
      void listener
        .stop()
        .then(() => indexer?.stop())
        .then(() => database.close())
        .finally(() => process.exit(code))
    })
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down')
      shutdown(0)
    })
  }
  if (indexer !== null) {
    superviseIndexer({
      done: indexer.done,
      isStopping: () => stopping,
      logger,
      onFatal: () => shutdown(1),
    })
  }
}

await main()
