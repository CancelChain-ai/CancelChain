import { z } from 'zod'
import { allowanceDetailSchema, allowanceSchema, eventSchema, planSchema } from './allowance.js'
import {
  addressSchema,
  blockhashSchema,
  signatureSchema,
  slotSchema,
  timestampSchema,
  u64Schema,
} from './primitives.js'

/**
 * Контракти `/v1`. Одні й ті самі схеми валідують запит на сервері й розбирають
 * відповідь у браузері — розбіжність між двома сторонами тут неможлива за побудовою.
 */

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  slot: slotSchema,
  lagSeconds: z.number().nonnegative(),
})

/**
 * Час життя транзакції для браузера — `GET /v1/blockhash` (`FR-003`).
 *
 * Ручка існує не тому, що сервер щось підписує, — він гаманця не має й мати не
 * буде. Вона існує тому, що **URL вузла з ключем провайдера в браузер не
 * потрапляє**: усе під префіксом `VITE_` вбудовується в бандл, тобто
 * публікується. А з `getLatestBlockhash` сервер віддає рівно те, що будь-який
 * RPC-вузол віддасть кожному, хто спитає.
 *
 * `lastValidBlockHeight` — u64, тож їде **рядком** (`primitives.ts`): висота
 * блоку в double влізе ще довго, але правило про u64 не має винятків «поки що
 * влазить», інакше перший виняток стає прецедентом для суми.
 */
export const latestBlockhashResponseSchema = z.object({
  blockhash: blockhashSchema,
  lastValidBlockHeight: u64Schema,
  /** Слот, на якому хеш прочитано. Показувати не обов'язково — звіряти корисно. */
  slot: slotSchema,
})

export type LatestBlockhashResponse = z.infer<typeof latestBlockhashResponseSchema>

export const listAllowancesQuerySchema = z.object({
  owner: addressSchema,
})

/**
 * Дозвіл у списку — збережена форма плюс позначка активу (`FR-020`).
 *
 * `assetSupported` навмисно **не** входить у `allowanceSchema`: та описує рядок
 * сховища, а тут ідеться про похідне від конфігурації (`USDC_MINT`), яке
 * рахується в момент читання. Тримати його в рядку означало б, що зміна
 * розрахункового активу вимагає переписати таблицю.
 *
 * `false` не ховає дозвіл зі списку і не забороняє скасування — воно лишається
 * єдиною дією, яку над таким дозволом пропонують.
 */
export const listedAllowanceSchema = allowanceSchema.extend({
  assetSupported: z.boolean(),
})

export type ListedAllowance = z.infer<typeof listedAllowanceSchema>

/**
 * Чому акаунт власника не став карткою. Перелік скінченний із тієї ж причини,
 * що й категорії відмови (`reasons.ts`): невідома причина мусить бути видимою
 * діркою, а не рядком, який ніхто не читає.
 *
 * `empty` / `discriminator` / `length` — акаунт не декодується; `version` —
 * версія акаунта не та, під яку зібрано клієнт; `plan` — підписка є, а її плану
 * знайти не вдалося (без плану невідомий актив); `fields` — акаунт прочитано,
 * але значення поля не лягає в модель.
 */
export const ALLOWANCE_UNREADABLE_REASONS = [
  'empty',
  'discriminator',
  'length',
  'version',
  'plan',
  'fields',
] as const

export type AllowanceUnreadableReason = (typeof ALLOWANCE_UNREADABLE_REASONS)[number]
export const allowanceUnreadableReasonSchema = z.enum(ALLOWANCE_UNREADABLE_REASONS)

/**
 * Акаунт, який у списку показати не вийшло. Текст помилки назовні не йде — він
 * лишається в лозі, склеєний із відповіддю через `requestId`; клієнтові потрібна
 * категорія, а не діагностика.
 */
export const unreadableAllowanceSchema = z.object({
  address: addressSchema,
  reason: allowanceUnreadableReasonSchema,
})

export type UnreadableAllowanceItem = z.infer<typeof unreadableAllowanceSchema>

export const listAllowancesResponseSchema = z.object({
  items: z.array(listedAllowanceSchema),
  syncedAt: timestampSchema,
  /** Кеш старший за поріг свіжості. Показується, а не мовчить (`FR-024`). */
  stale: z.boolean(),
  /**
   * Акаунти гаманця, яких немає в `items`. Порожній масив — це твердження
   * «показано все»: `FR-006` не дозволяє списку тихо коротшати, тож клієнт
   * мусить мати з чого сказати «ще N дозволів прочитати не вдалося».
   */
  unreadable: z.array(unreadableAllowanceSchema),
})

export const getAllowanceParamsSchema = z.object({
  pda: addressSchema,
})

/**
 * Картка несе ту саму позначку активу, що й список (`FR-020`) — і саме тут вона
 * має вагу: дії живуть у картці, а над дозволом у чужому активі не пропонується
 * жодної, крім скасування. Без цього поля клієнтові довелося б знати
 * розрахунковий мін самому, тобто дублювати конфігурацію сервера.
 */
export const getAllowanceResponseSchema = allowanceDetailSchema.extend({
  assetSupported: z.boolean(),
})

/**
 * Транзакції, що торкнулися адреси дозволу —
 * `GET /v1/allowances/:pda/signatures` (`T030`, мінімальна форма `FR-005`).
 *
 * **Це не `/v1/allowances/:pda/events`.** Там будуть події з індексатора,
 * декодовані до «списано стільки» і «відмовлено з такої причини» (`T038`…`T041`).
 * Тут — рівно те, що віддає `getSignaturesForAddress`, і ані байтом більше:
 * підпис, слот, час блоку і чи транзакція впала. Що саме вона робила, з цієї
 * відповіді **не видно**, тож жодна зі сторін цього не вигадує.
 *
 * Історія тут — історія **адреси**, а не дозволу. Акаунт дозволу закривається
 * скасуванням, а ті самі сіди дають ту саму адресу знову, тож у старих рядках
 * може лежати дозвіл, якого вже немає. Інтерфейс зобов'язаний казати саме
 * «торкнулися цієї адреси».
 */
export const MAX_SIGNATURES_PAGE = 50
export const DEFAULT_SIGNATURES_PAGE = 25

export const listSignaturesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_SIGNATURES_PAGE).default(DEFAULT_SIGNATURES_PAGE),
})

export const addressSignatureSchema = z.object({
  signature: signatureSchema,
  slot: slotSchema,
  /** `null` — вузол не знає часу цього блоку. Порядком лишається слот. */
  blockTime: timestampSchema.nullable(),
  /**
   * Транзакція впала. **Чому** — тут не сказано і сказано не буде: категорія
   * відмови мапиться з коду програми окремою задачею (`T040`, `reasons.ts`), а
   * сирий код помилки на екрані не означає для людини нічого.
   */
  failed: z.boolean(),
})

export type AddressSignature = z.infer<typeof addressSignatureSchema>

export const listSignaturesResponseSchema = z.object({
  /** Найновіші першими — так їх віддає вузол. */
  items: z.array(addressSignatureSchema),
  syncedAt: timestampSchema,
  /**
   * За межею `limit` є старіші транзакції. Без цього прапорця вікно з 25 рядків
   * виглядало б як уся історія адреси — тобто мовчазний обрив, той самий, який
   * `SC-013` забороняє стрічці індексатора.
   */
  more: z.boolean(),
})

export type ListSignaturesResponse = z.infer<typeof listSignaturesResponseSchema>

export const MAX_EVENTS_PAGE = 100

export const listEventsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_EVENTS_PAGE).default(50),
})

export const listEventsResponseSchema = z.object({
  items: z.array(eventSchema),
  nextCursor: z.string().min(1).nullable(),
  /**
   * Стрічка впирається у вікно зберігання (`FR-029`, `SC-013`). Прапорець каже
   * інтерфейсу показати обрив із посиланням у мережу — мовчазних обривів нема.
   */
  truncatedAt: timestampSchema.nullable(),
})

export const streamQuerySchema = z.object({
  owner: addressSchema,
})

/** Події SSE `/v1/stream`. */
export const streamMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('allowance.updated'),
    allowance: allowanceSchema,
  }),
  z.object({
    type: z.literal('event.appended'),
    allowancePda: addressSchema,
    event: eventSchema,
  }),
])

export type StreamMessage = z.infer<typeof streamMessageSchema>

export const pushSubscribeBodySchema = z.object({
  owner: addressSchema,
  endpoint: z.url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
})

export const pushUnsubscribeBodySchema = z.object({
  endpoint: z.url(),
})

export const okResponseSchema = z.object({ ok: z.literal(true) })

export const createPlanBodySchema = z.object({
  planPda: addressSchema,
  name: z.string().min(1).max(64),
})

export const getPlanResponseSchema = planSchema

export const merchantSubscriptionsParamsSchema = z.object({
  address: addressSchema,
})

export const merchantSubscriptionsResponseSchema = z.object({
  items: z.array(allowanceSchema),
  activeCount: z.number().int().nonnegative(),
  /** Очікуваний виторг за період — сума стель активних дозволів на мерчанта. */
  expectedPerPeriod: u64Schema,
})

/**
 * Sign-in with Solana для панелі мерчанта. Підписується рівно цей об'єкт;
 * сервер перевіряє підпис і видає stateless JWT на 15 хвилин.
 */
export const signInMessageSchema = z.object({
  domain: z.string().min(1),
  address: addressSchema,
  nonce: z.string().min(8),
  issuedAt: timestampSchema,
})

export type SignInMessage = z.infer<typeof signInMessageSchema>

/**
 * Рядок, який людина бачить у вікні гаманця. Текст — частина того, що
 * підписується: гаманець показує байти, а не структуру, тож підпис без
 * читабельного тексту був би підписом наосліп.
 *
 * Формат зібрано з **рівно тих** полів, що є в `signInMessageSchema`, і збирає
 * його одна функція на обидві сторони. Зліпи браузер свій рядок, а сервер свій
 * — розбіжність в одному пробілі давала б `401` на чесному підписі, тобто
 * помилку, яку неможливо побачити з відповіді.
 */
export const SIGN_IN_STATEMENT = 'Sign in to CancelChain as a merchant.'

export function signInMessageText(message: SignInMessage): string {
  return [
    `${message.domain} wants you to sign in with your Solana account:`,
    message.address,
    '',
    SIGN_IN_STATEMENT,
    '',
    `Nonce: ${message.nonce}`,
    `Issued At: ${message.issuedAt}`,
  ].join('\n')
}

/**
 * Скільки живе сам **підпис** входу. Це не час життя токена: підпис лише
 * доводить володіння ключем один раз, а далі носієм права стає JWT.
 *
 * Дві хвилини — це вікно на те, щоб людина встигла прочитати текст у гаманці й
 * натиснути. Ширше вікно подовжує час, у який перехоплений підпис ще можна
 * обміняти на токен; вужче ламає вхід тому, хто читає повільно.
 */
export const SIGN_IN_MAX_AGE_SECONDS = 120

export const signInBodySchema = z.object({
  message: signInMessageSchema,
  /** Base58, 64 байти — той самий формат, що й у підпису транзакції. */
  signature: signatureSchema,
})

export type SignInBody = z.infer<typeof signInBodySchema>

export const signInResponseSchema = z.object({
  token: z.string().min(1),
  /** Кому видано. Клієнт не мусить розбирати JWT, щоб це знати. */
  address: addressSchema,
  /** Коли токен перестає діяти. Не «скільки лишилось» — годинники різні. */
  expiresAt: timestampSchema,
})

export type SignInResponse = z.infer<typeof signInResponseSchema>

/**
 * Токен мерчанта живе 15 хвилин і не поновлюється. Він stateless: відкликати
 * його ми не можемо, тож єдине, що обмежує вкрадений токен, — це строк.
 */
export const MERCHANT_JWT_TTL_SECONDS = 15 * 60
