import { z } from 'zod'
import { allowanceDetailSchema, allowanceSchema, eventSchema, planSchema } from './allowance.js'
import { addressSchema, slotSchema, timestampSchema, u64Schema } from './primitives.js'

/**
 * Контракти `/v1`. Одні й ті самі схеми валідують запит на сервері й розбирають
 * відповідь у браузері — розбіжність між двома сторонами тут неможлива за побудовою.
 */

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  slot: slotSchema,
  lagSeconds: z.number().nonnegative(),
})

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

export const MERCHANT_JWT_TTL_SECONDS = 15 * 60
