import type { AllowanceReadOne, AllowanceReadResult, ReadAllowance } from '@cancelchain/chain'
import type { Address, Allowance, AllowanceStatus } from '@cancelchain/shared'
import {
  getAllowanceParamsSchema,
  getAllowanceResponseSchema,
  listAllowancesQuerySchema,
  listAllowancesResponseSchema,
} from '@cancelchain/shared'
import { Hono } from 'hono'
import type { z } from 'zod'
import { fail } from '../errors.js'
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
  /** Один дозвіл із мережі — звірка перед показом картки й перед дією (`FR-024`). */
  get: (pda: Address) => Promise<AllowanceReadOne>
  /**
   * Збережений стан дозволу або `null`. До індексатора (`T038`) таблиця порожня
   * і звіряти нема з чим — але звірка від цього не стає заглушкою: `null` тут
   * означає «кешу немає», а не «розбіжності немає».
   */
  cached: (pda: Address) => Promise<Allowance | null>
  /**
   * Розрахунковий актив (`FR-020`). Картка рахує позначку сама, а не бере її з
   * читання мережі: скасований дозвіл приходить **зі сховища**, читати в
   * мережі вже нічого, а позначка на картці потрібна однаково.
   */
  settlementMint: Address
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

/**
 * `GET /v1/allowances/:pda` — картка з `chainState` і `diverged`
 * (`FR-022`, `FR-024`, `FR-025`).
 *
 * **Хто тут джерело правди.** Поля верхнього рівня несуть стан **мережі**, а не
 * збережений: пріоритет мережі застосовується один раз тут, на сервері, а не
 * доручається кожному клієнтові, який може про нього забути. `chainState` —
 * той самий прочитаний стан у сирому вигляді (або `null`, якщо акаунта немає),
 * `diverged` — що сховище з ним не збіглося.
 *
 * Верхній рівень і `chainState` розходяться рівно в одному місці — на паузі:
 * `paused` існує тільки в нашому сховищі (мережа тримає паузу й «не поновлювати»
 * в одному полі `expiresAtTs`), тож картка каже `status: "paused"`, а
 * `chainState.status` — `active`. Це не розбіжність, і `diverged` від цього не
 * вмикається: інакше кожна пауза виглядала б збоєм звірки.
 */

/** Поля, які веде мережа. Решта — або наша мітка, або похідне від них. */
const NETWORK_OWNED = [
  'capAmount',
  'spentInPeriod',
  'periodStartedAt',
  'expiresAt',
  'endsAt',
] as const

/**
 * Збережений статус для звірки. `paused` — наша мітка над станом, який мережа
 * читає як `active` (`PLAN.md`: `paused_at` — офчейн-онлі), тож порівнювати
 * його з мережею буквально означало б позначати кожну паузу розбіжністю.
 */
function comparableStatus(status: AllowanceStatus): AllowanceStatus {
  return status === 'paused' ? 'active' : status
}

function diverges(cached: Allowance, chain: Allowance): boolean {
  if (comparableStatus(cached.status) !== comparableStatus(chain.status)) return true
  return NETWORK_OWNED.some((field) => cached[field] !== chain[field])
}

function chainStateOf(chain: Allowance, slot: number) {
  return {
    status: chain.status,
    capAmount: chain.capAmount,
    spentInPeriod: chain.spentInPeriod,
    periodStartedAt: chain.periodStartedAt,
    // Мережа паузи не зберігає — тут завжди `null`, і це не втрата даних.
    pausedAt: null,
    endsAt: chain.endsAt,
    slot,
  }
}

/** Тіло картки: `allowanceDetailSchema` плюс позначка активу. */
export type AllowanceCard = z.infer<typeof getAllowanceResponseSchema>

export type ReconcileInput = {
  cached: Allowance | null
  chain: ReadAllowance | null
  slot: number
  settlementMint: Address
}

/**
 * Збережений стан + стан мережі → тіло картки. `null` — дозволу немає ніде:
 * ані в мережі, ані в сховищі.
 */
export function reconcile(input: ReconcileInput): AllowanceCard | null {
  const { cached, chain, slot, settlementMint } = input

  if (chain === null) {
    if (cached === null) return null
    /*
     * Акаунта в мережі немає — дозвіл закрито. Це найважливіший випадок
     * звірки (`SC-009`): показати тут збережений `active` означало б рівно те,
     * заради чого продукт існує, тільки навпаки. Статус мережі перемагає,
     * мітка паузи знімається разом зі станом, якого вже немає.
     */
    return getAllowanceResponseSchema.parse({
      ...cached,
      status: 'revoked',
      pausedAt: null,
      chainState: null,
      diverged: cached.status !== 'revoked',
      lastSlot: slot,
      assetSupported: cached.mint === settlementMint,
    })
  }

  const paused =
    cached?.pausedAt != null && chain.kind === 'subscription' && chain.status === 'active'

  return getAllowanceResponseSchema.parse({
    ...chain,
    ...(paused ? { status: 'paused', pausedAt: cached?.pausedAt } : {}),
    chainState: chainStateOf(chain, slot),
    diverged: cached !== null && diverges(cached, chain),
    assetSupported: chain.mint === settlementMint,
  })
}

export function allowanceRoute(deps: AllowancesDeps): Hono<AppEnv> {
  return new Hono<AppEnv>().get(
    '/v1/allowances/:pda',
    validate('param', getAllowanceParamsSchema),
    async (c) => {
      const { pda } = c.req.valid('param')
      /*
       * Сховище падає — картка не падає. Правда про дозвіл лежить у мережі
       * (`FR-025`), і недосяжний кеш може забрати лише прапорець `diverged`,
       * а не саму відповідь. Зворотне — читання мережі — впасти може: без нього
       * показувати нічого, і збережений стан тут не заміна.
       */
      const [chain, cached] = await Promise.all([
        deps.get(pda),
        deps.cached(pda).catch((error: unknown) => {
          c.get('logger')?.error({ err: error, pda }, 'cached allowance unreadable')
          return null
        }),
      ])

      if (chain.unreadable !== null) {
        /*
         * Акаунт у мережі є, але цей збірник його не читає (найімовірніше —
         * версія акаунта змінилася). Це не `NOT_FOUND`: дозвіл існує, і сказати
         * «такого немає» означало б збрехати рівно про те, що людина шукає.
         * Категорія назовні йде та сама, що й у списку; текст лишається в лозі.
         */
        c.get('logger')?.error(
          { pda, reason: chain.unreadable.reason, detail: chain.unreadable.detail },
          'allowance account could not be read',
        )
        return fail(c, 'INTERNAL', 'the allowance account could not be read', {
          reason: chain.unreadable.reason,
        })
      }

      const detail = reconcile({
        cached,
        chain: chain.allowance,
        slot: chain.slot,
        settlementMint: deps.settlementMint,
      })
      if (detail === null) return fail(c, 'NOT_FOUND', 'no allowance at this address')

      if (detail.diverged) {
        c.get('logger')?.warn(
          { pda, cachedStatus: cached?.status, chainStatus: detail.chainState?.status ?? null },
          'stored allowance disagreed with the network',
        )
      }

      return c.json(detail)
    },
  )
}
