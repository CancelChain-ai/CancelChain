import type { AllowanceReadResult } from '@cancelchain/chain'
import type { Address } from '@cancelchain/shared'
import { listAllowancesQuerySchema, listAllowancesResponseSchema } from '@cancelchain/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../types.js'
import { validate } from '../validate.js'

/**
 * `GET /v1/allowances?owner=…` — `{ items, syncedAt, stale, unreadable }`
 * (`PLAN.md` → API-контракти), закриває `FR-001` і `FR-002`.
 *
 * **Аутентифікації тут немає навмисно.** Дозволи гаманця публічні в мережі: той
 * самий список віддасть будь-який RPC-вузол кожному, хто спитає. Ставити на
 * читання підпис означало б удавати приватність, якої в даних немає, і водночас
 * вимагати підпис там, де `FR-017` обіцяє вхід самим лише підключенням гаманця.
 *
 * **Нічого не кешується й нічого не пишеться в базу.** До індексатора (`T038`)
 * список береться з мережі на кожен запит: сховище порожнє, а показувати
 * порожній кеш як «дозволів немає» — це рівно те, що `FR-022` забороняє.
 */

export type AllowancesDeps = {
  /**
   * Читання дозволів гаманця. Функцією, а не клієнтом мережі: інакше жоден тест
   * маршруту не обійшовся б без RPC, а перевіряти тут треба форму відповіді.
   */
  list: (owner: Address) => Promise<AllowanceReadResult>
}

export function allowancesRoute(deps: AllowancesDeps): Hono<AppEnv> {
  return new Hono<AppEnv>().get(
    '/v1/allowances',
    validate('query', listAllowancesQuerySchema),
    async (c) => {
      const { owner } = c.req.valid('query')
      const result = await deps.list(owner)

      const logger = c.get('logger')
      for (const entry of result.unreadable) {
        // Текст помилки лишається тут, а не їде клієнтові: назовні йде категорія
        // (`unreadable[].reason`), у лозі — чому саме, склеєне з відповіддю
        // через `requestId`.
        logger?.warn(
          { owner, address: entry.address, reason: entry.reason, detail: entry.detail },
          'allowance account could not be read',
        )
      }

      return c.json(
        listAllowancesResponseSchema.parse({
          items: result.allowances,
          syncedAt: result.syncedAt,
          /*
           * `stale` — про вік **кешу**, а не про вік відповіді. Кешу до `T038`
           * не існує, відповідь щойно прочитана з мережі, тож тут завжди `false`
           * і це не заглушка: щойно з'явиться сховище, прапорець почне рахуватися
           * з його мітки, а форма відповіді не зміниться.
           */
          stale: false,
          unreadable: result.unreadable.map((entry) => ({
            address: entry.address,
            reason: entry.reason,
          })),
        }),
      )
    },
  )
}
