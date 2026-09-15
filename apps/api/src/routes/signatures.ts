import type { AddressHistory } from '@cancelchain/chain'
import type { Address } from '@cancelchain/shared'
import {
  getAllowanceParamsSchema,
  listSignaturesQuerySchema,
  listSignaturesResponseSchema,
} from '@cancelchain/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { validate } from '../validate.js'

/**
 * `GET /v1/allowances/:pda/signatures` — мінімальна стрічка на вимогу (`T030`,
 * `FR-005`).
 *
 * **Чому ручка тут, а не в браузері.** Та сама причина, що й у `/v1/blockhash`:
 * усе під префіксом `VITE_` вбудовується в бандл, тож URL вузла з ключем
 * провайдера в браузер не потрапляє. Даних це не приховує — історію адреси
 * віддасть будь-який RPC-вузол кожному, хто спитає, і аутентифікації тут немає
 * з тієї ж причини, що й у читанні дозволів.
 *
 * **Чому це не `/events`.** `/v1/allowances/:pda/events` (`T041`) віддаватиме
 * події індексатора: суму списання й категорію відмови. Тут немає ні того, ні
 * іншого — `getSignaturesForAddress` каже лише, що транзакція згадала цю
 * адресу, і чи вона впала. Дві різні ручки, бо це дві різні обіцянки, і
 * підмінити другу першою означало б показати вікно підписів як історію подій.
 *
 * **Сховище тут не бере участі взагалі** — воно порожнє до `T038`, і саме тому
 * стрічка тягнеться на вимогу: інакше екран картки мовчав би про історію,
 * якої не існує лише в нас.
 */

export type SignaturesDeps = {
  /**
   * Історія адреси. Функцією, а не клієнтом мережі: інакше маршрут не
   * перевіриш без RPC, а перевіряти тут треба форму відповіді.
   */
  history: (pda: Address, limit: number) => Promise<AddressHistory>
}

export function signaturesRoute(deps: SignaturesDeps): Hono<AppEnv> {
  return new Hono<AppEnv>().get(
    '/v1/allowances/:pda/signatures',
    validate('param', getAllowanceParamsSchema),
    validate('query', listSignaturesQuerySchema),
    async (c) => {
      const { pda } = c.req.valid('param')
      const { limit } = c.req.valid('query')
      const history = await deps.history(pda, limit)
      /*
       * Порожній `items` — це відповідь «за цією адресою нічого не було», а не
       * `NOT_FOUND`: адреса дозволу існує незалежно від того, чи хтось її
       * торкався, і 404 тут читався б як «дозволу немає».
       */
      return c.json(listSignaturesResponseSchema.parse(history))
    },
  )
}
