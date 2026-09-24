import {
  MERCHANT_JWT_TTL_SECONDS,
  SIGN_IN_MAX_AGE_SECONDS,
  type SignInMessage,
  signInMessageText,
} from '@cancelchain/shared'
import type { MiddlewareHandler } from 'hono'
import { sign, verify } from 'hono/jwt'
import { fail } from './errors.js'
import type { AppEnv } from './types.js'

/**
 * Вхід мерчанта підписом гаманця і короткоживучий токен — серверна половина
 * `T035`.
 *
 * **Чому взагалі підпис.** Читання дозволів аутентифікації не має і мати не
 * буде: ті дані публічні в мережі (`routes/allowances.ts`). А от назва плану —
 * запис, і писати її має право лише власник плану. Ончейн-плану належить
 * гаманець; єдиний спосіб довести, що за запитом стоїть саме він, — підпис.
 * Обліковий запис із паролем тут був би другою сутністю про ту саму людину і
 * порушив би `FR-017`.
 *
 * **Чому токен, а не підпис на кожен запит.** Кожен підпис — це вікно гаманця
 * перед людиною. Панель мерчанта робить кілька записів поспіль, і підпис на
 * кожен перетворив би її на клікер. Токен на 15 хвилин — компроміс: одне
 * вікно на сесію.
 *
 * **Токен stateless і невідкличний.** Списку виданих токенів ми не тримаємо,
 * тож вкрадений токен діє до кінця свого строку, і скоротити його можна лише
 * змінивши `JWT_SECRET` — тобто виваливши всіх. Це свідомий компроміс: сховище
 * сесій вимагало б рядка в БД на кожен запит панелі. Строк тому й короткий.
 */

export const MERCHANT_JWT_ALGORITHM = 'HS256'

/**
 * Мінімальна довжина секрета. 32 байти — не забаганка: HS256 із коротким
 * секретом підбирається офлайн за наявним токеном, а `JWT_SECRET=secret` у
 * проді нічим себе не виявляє, доки хтось не підпише собі чужий токен.
 */
export const MIN_JWT_SECRET_LENGTH = 32

/** Що лежить у токені. Нічого, крім адреси й строків, — ні імен, ні прав. */
export type MerchantClaims = {
  /** Адреса гаманця мерчанта. */
  sub: string
  /** Видано / діє до — секунди Unix, як вимагає JWT. */
  iat: number
  exp: number
}

export type MerchantVariables = {
  /** Адреса з перевіреного токена. Ставить `merchantAuth`, і більше ніхто. */
  merchant: string
}

export type IssuedToken = {
  token: string
  address: string
  expiresAt: string
}

/** Підписує токен на `MERCHANT_JWT_TTL_SECONDS` від `now`. */
export async function issueMerchantToken(
  address: string,
  secret: string,
  now: Date = new Date(),
): Promise<IssuedToken> {
  const issuedAt = Math.floor(now.getTime() / 1000)
  const expiresAt = issuedAt + MERCHANT_JWT_TTL_SECONDS
  const claims: MerchantClaims = { sub: address, iat: issuedAt, exp: expiresAt }
  return {
    token: await sign(claims, secret, MERCHANT_JWT_ALGORITHM),
    address,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  }
}

/**
 * Адреса з токена або `null`. `hono/jwt` сам перевіряє підпис і `exp`; усе, що
 * лишається, — не повірити в токен без `sub`.
 */
export async function merchantFromToken(token: string, secret: string): Promise<string | null> {
  try {
    const claims = await verify(token, secret, MERCHANT_JWT_ALGORITHM)
    const sub = claims.sub
    return typeof sub === 'string' && sub.length > 0 ? sub : null
  } catch {
    return null
  }
}

const BEARER = /^Bearer (\S+)$/

/** `Authorization: Bearer <jwt>` → сам токен. Інша схема — не наш токен. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null
  return BEARER.exec(header)?.[1] ?? null
}

/**
 * Пускає далі лише з живим токеном і кладе адресу в `c.get('merchant')`.
 *
 * Відмова назовні однакова для «заголовка немає», «токен зіпсовано» і «токен
 * протух»: різниця між ними корисна лише тому, хто підбирає токени.
 */
export function merchantAuth(secret: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header('authorization'))
    const address = token === null ? null : await merchantFromToken(token, secret)
    if (address === null) {
      return fail(c, 'UNAUTHORIZED', 'a live merchant token is required')
    }
    c.set('merchant', address)
    await next()
  }
}

/**
 * Чому підпис не прийнято. Перелік скінченний із тієї ж причини, що й
 * категорії відмови: назовні йде категорія, у лог — деталі.
 */
export type SignInRejection = 'domain' | 'stale' | 'replay' | 'signature'

/**
 * Одноразовість `nonce` **у пам'яті процесу**.
 *
 * Без неї підпис, перехоплений протягом `SIGN_IN_MAX_AGE_SECONDS`, можна
 * обміняти на токен ще раз — саме від цього в повідомленні є `nonce`. Тримати
 * використані значення довше за вікно свіжості не потрібно: старший підпис
 * відсіється і так.
 *
 * Межа чесно називається: при двох інстансах повтор, що втрапив на сусідній,
 * пройде — лічильник спільним не є, як і в `rateLimit.ts`. Спільне сховище
 * вимагало б Redis, якого в стеку немає.
 */
export class NonceLog {
  private readonly seen = new Map<string, number>()

  constructor(private readonly ttlSeconds: number = SIGN_IN_MAX_AGE_SECONDS) {}

  /** `true` — цей nonce бачать уперше; він одразу стає використаним. */
  claim(nonce: string, now: number): boolean {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key)
    }
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, now + this.ttlSeconds * 1000)
    return true
  }
}

export type VerifySignInInput = {
  message: SignInMessage
  signature: string
  /** Домен, за який ми відповідаємо. Підпис для іншого домену — не для нас. */
  domain: string
  now: Date
  nonces: NonceLog
  /** Перевірка підпису. Функцією — щоб маршрут перевірявся без криптографії. */
  verify: (input: { address: string; signature: string; message: Uint8Array }) => Promise<boolean>
}

/**
 * `null` — підпис прийнято. Інакше — категорія відмови.
 *
 * Порядок перевірок не випадковий: спершу дешеві й безумовні (домен, свіжість,
 * повтор), і лише потім криптографія. Перевіряти підпис раніше означало б
 * робити роботу на кожен сміттєвий запит.
 *
 * Криптографія стоїть **після** `claim`, і це навмисне: інакше nonce
 * «витрачався» б лише на валідних підписах, а завалити лог чужими nonce змогла
 * б будь-яка вигадана пара.
 */
export async function verifySignIn(input: VerifySignInInput): Promise<SignInRejection | null> {
  const { message } = input
  if (message.domain !== input.domain) return 'domain'

  const ageSeconds = (input.now.getTime() - Date.parse(message.issuedAt)) / 1000
  // Від'ємний вік — підпис «з майбутнього». Годинники розходяться, тож
  // симетричне вікно чесніше за нуль: інакше клієнт із годинником на секунду
  // вперед не увійшов би ніколи.
  if (Math.abs(ageSeconds) > SIGN_IN_MAX_AGE_SECONDS) return 'stale'

  if (!input.nonces.claim(message.nonce, input.now.getTime())) return 'replay'

  const bytes = new TextEncoder().encode(signInMessageText(message))
  const ok = await input.verify({
    address: message.address,
    signature: input.signature,
    message: bytes,
  })
  return ok ? null : 'signature'
}
