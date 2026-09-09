import { latestBlockhashResponseSchema } from '@cancelchain/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'

/**
 * `GET /v1/blockhash` — час життя транзакції для браузера (`FR-003`).
 *
 * **Це не крок до підпису на сервері.** Гаманця в сервера немає й не буде: він
 * віддає рівно те, що будь-який RPC-вузол віддасть кожному, хто спитає, і не
 * бачить ані транзакції, ані підпису. Транзакцію збирає й підписує браузер, і
 * надсилає її сам гаманець.
 *
 * Ручка існує з однієї причини: **URL вузла з ключем провайдера в браузер не
 * потрапляє.** Усе під префіксом `VITE_` вбудовується в бандл, тобто
 * публікується разом зі сторінкою; віддати браузеру `SOLANA_RPC_URL` означало б
 * подарувати ключ Helius кожному, хто відкрив вкладку.
 *
 * Аутентифікації немає з тієї ж причини, що й у читанні дозволів: хеш блоку —
 * публічні дані мережі, і підпис під запитом до них удавав би приватність,
 * якої немає.
 */

export type LatestBlockhash = {
  blockhash: string
  lastValidBlockHeight: bigint
  slot: number
}

export type BlockhashDeps = {
  /**
   * Функцією, а не клієнтом мережі: інакше маршрут не перевіриш без RPC, а
   * перевіряти тут треба форму відповіді й те, що u64 не стає числом.
   */
  latestBlockhash: () => Promise<LatestBlockhash>
}

export function blockhashRoute(deps: BlockhashDeps): Hono<AppEnv> {
  return new Hono<AppEnv>().get('/v1/blockhash', async (c) => {
    const { blockhash, lastValidBlockHeight, slot } = await deps.latestBlockhash()
    return c.json(
      latestBlockhashResponseSchema.parse({
        blockhash,
        // Рядком, а не числом: правило про u64 не має винятку «поки що влазить».
        lastValidBlockHeight: lastValidBlockHeight.toString(10),
        slot,
      }),
    )
  })
}
