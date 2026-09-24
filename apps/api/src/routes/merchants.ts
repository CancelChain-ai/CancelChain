import { NotAPlanError, PlanNotFoundError, type PlanSnapshot } from '@cancelchain/chain'
import type { Address, Plan } from '@cancelchain/shared'
import {
  createPlanBodySchema,
  fromU64,
  getPlanResponseSchema,
  periodSecondsFromHours,
  signInBodySchema,
  signInResponseSchema,
} from '@cancelchain/shared'
import { Hono } from 'hono'
import {
  issueMerchantToken,
  merchantAuth,
  NonceLog,
  type SignInRejection,
  verifySignIn,
} from '../auth.js'
import { fail } from '../errors.js'
import type { AppEnv } from '../types.js'
import { validate } from '../validate.js'

/**
 * Панель мерчанта: вхід підписом гаманця і офчейн-назва плану — `T035`,
 * друга половина `FR-014`.
 *
 * **Що тут насправді зберігається.** Рівно одне поле — `name`. Усе інше в
 * рядку `plans` (мерчант, `planId`, сума, період, мін, дата створення) прямо
 * зараз читається **з мережі** і кладеться в базу таким, яким його віддала
 * програма: тіло запиту ці поля не несе взагалі, і навіть якби несло, ми б їх
 * не взяли. Інакше мерчант міг би записати в каталог «9,99», а списувати за
 * планом 99,90 — і екран підписки (`T036`) показав би брехню, зібрану нами.
 *
 * Назви в мережі немає взагалі (`T034`), тож вона й не звіряється: це єдине,
 * що тут справді офчейн, і при показі це називається вголос.
 *
 * **Право на запис.** План належить гаманцю (`plan.owner`), токен несе адресу
 * гаманця — збігу цих двох і досить. Списку мерчантів, ролей і запрошень
 * немає: реєстрація зводиться до володіння ключем.
 */

export type MerchantsDeps = {
  /** Секрет підпису токенів. Валідується в `env.ts`, сюди приходить готовим. */
  jwtSecret: string
  /**
   * Домен, який людина бачить у вікні гаманця. Підпис для іншого домену не
   * приймається: інакше підпис, зібраний чужим сайтом, відкривав би нашу панель.
   */
  domain: string
  /**
   * План із мережі. Кидає `PlanNotFoundError`, якщо акаунта немає, і
   * `NotAPlanError`, якщо акаунт є, але планом не є — обидва випадки маршрут
   * розбирає сам. Класифікувати їх у точці збирання застосунку означало б
   * тримати найважливішу відмову цієї ручки поза тестами маршруту.
   */
  plan: (pda: Address) => Promise<PlanSnapshot>
  /**
   * Записує рядок каталогу. Нічого не повертає навмисно: у відповідь їде те,
   * що прочитано **з мережі**, а не те, що віддала база. Читати щойно
   * записаний рядок назад означало б показувати кеш там, де правда поруч.
   */
  save: (plan: Plan) => Promise<void>
  /** Перевірка підпису гаманця. Функцією — маршрут тестується без криптографії. */
  verifySignature: (input: {
    address: string
    signature: string
    message: Uint8Array
  }) => Promise<boolean>
  now?: () => Date
}

/** Текст у лог. Назовні йде лише `UNAUTHORIZED` — див. `signInRoute`. */
const REJECTION_DETAIL: Record<SignInRejection, string> = {
  domain: 'the message was signed for another domain',
  stale: 'the message is outside the freshness window',
  replay: 'this nonce has already been used',
  signature: 'the signature does not belong to that address',
}

export function merchantSignInRoute(deps: MerchantsDeps): Hono<AppEnv> {
  const nonces = new NonceLog()
  const now = deps.now ?? (() => new Date())

  return new Hono<AppEnv>().post(
    '/v1/merchants/sign-in',
    validate('json', signInBodySchema),
    async (c) => {
      const { message, signature } = c.req.valid('json')
      const rejection = await verifySignIn({
        message,
        signature,
        domain: deps.domain,
        now: now(),
        nonces,
        verify: deps.verifySignature,
      })

      if (rejection !== null) {
        /*
         * Категорія лишається в лозі, назовні йде один рядок на всі чотири
         * випадки. Сказати «домен не той» чи «nonce вже був» означало б
         * підказувати тому, хто підбирає, що саме ще лишилося підібрати.
         */
        c.get('logger')?.warn(
          { address: message.address, rejection, detail: REJECTION_DETAIL[rejection] },
          'merchant sign-in rejected',
        )
        return fail(c, 'UNAUTHORIZED', 'the signature was not accepted')
      }

      const issued = await issueMerchantToken(message.address, deps.jwtSecret, now())
      c.get('logger')?.info({ address: message.address }, 'merchant signed in')
      return c.json(signInResponseSchema.parse(issued))
    },
  )
}

/**
 * Знімок мережі → рядок каталогу. Назва — єдине, що приходить із запиту.
 *
 * `createdAt` у мережі ставить програма (`T034`). `null` тут означає акаунт,
 * який ми описати не можемо, і вигадувати йому «зараз» не можна: дата створення
 * плану — це те, за чим каталог сортується й старіє.
 */
export function planRowFrom(snapshot: PlanSnapshot, name: string): Plan | null {
  if (snapshot.createdAt === null) return null
  return getPlanResponseSchema.parse({
    pda: snapshot.pda,
    merchant: snapshot.owner,
    planId: fromU64(snapshot.planId),
    name,
    amount: fromU64(snapshot.amount),
    // Години програми в секунди сховища — конвертація завжди явна (`period.ts`).
    periodSeconds: periodSecondsFromHours(snapshot.periodHours),
    mint: snapshot.mint,
    createdAt: snapshot.createdAt,
  })
}

export function merchantPlansRoute(deps: MerchantsDeps): Hono<AppEnv> {
  return new Hono<AppEnv>().post(
    '/v1/merchants/plans',
    merchantAuth(deps.jwtSecret),
    validate('json', createPlanBodySchema),
    async (c) => {
      const { planPda, name } = c.req.valid('json')
      const merchant = c.get('merchant')

      /*
       * Плану немає в мережі — назві нема до чого кріпитися. Запис «наперед»,
       * до створення акаунта, зробив би каталог сховищем намірів: рядок жив би
       * сам по собі, а `T036` показував би план, якого не існує.
       *
       * «Акаунта немає» і «акаунт є, але не план» назовні однакові: для того,
       * хто питав, плану за цією адресою немає в обох випадках. Чим саме
       * виявився акаунт, лишається в лозі.
       */
      let snapshot: PlanSnapshot
      try {
        snapshot = await deps.plan(planPda)
      } catch (error) {
        if (error instanceof PlanNotFoundError || error instanceof NotAPlanError) {
          c.get('logger')?.warn({ merchant, planPda, err: error }, 'no plan at this address')
          return fail(c, 'NOT_FOUND', 'there is no plan at this address')
        }
        throw error
      }

      if (snapshot.owner !== merchant) {
        /*
         * Токен живий, але план чужий. Відповідь — `UNAUTHORIZED`, бо іншого
         * коду в переліку немає (`shared/errors.ts`), а повідомлення каже
         * прямо, що справа не в токені: переввійти тут не допоможе.
         */
        c.get('logger')?.warn(
          { merchant, planPda, owner: snapshot.owner },
          'merchant tried to name a plan it does not own',
        )
        return fail(c, 'UNAUTHORIZED', 'this plan belongs to another wallet')
      }

      const row = planRowFrom(snapshot, name)
      if (row === null) {
        return fail(c, 'INVALID_INPUT', 'this plan account carries no creation time', {
          fieldErrors: { planPda: ['the program did not stamp createdAt'] },
        })
      }

      await deps.save(row)
      c.get('logger')?.info({ merchant, planPda }, 'plan name stored')
      return c.json(row)
    },
  )
}
