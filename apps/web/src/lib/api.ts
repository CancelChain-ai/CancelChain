import type { Address, ErrorCode, PlanView } from '@cancelchain/shared'
import {
  apiErrorSchema,
  getAllowanceResponseSchema,
  getPlanViewResponseSchema,
  latestBlockhashResponseSchema,
  listAllowancesResponseSchema,
  listEventsResponseSchema,
  listSignaturesResponseSchema,
  okResponseSchema,
  type PushKeyResponse,
  type PushSubscribeBody,
  type PushUnsubscribeBody,
  pushKeyResponseSchema,
} from '@cancelchain/shared'
import type { z } from 'zod'

/**
 * Клієнт `/v1`. Ті самі Zod-схеми зі `shared`, якими сервер валідує відповідь,
 * розбирають її тут — розійтися двом сторонам нема де.
 *
 * Невдача не буває просто `Error`. Три різні речі ламаються по-різному, і
 * інтерфейс мусить сказати, яка саме: сервер відмовив, сервера не чути, або
 * сервер відповів не тим, що обіцяє контракт. Один клас на всі три означав би
 * повідомлення «щось не так» — рівно те, чого продукт не робить із розбіжністю
 * стану (`FR-024`).
 */

export type ListAllowancesResponse = z.infer<typeof listAllowancesResponseSchema>
export type GetAllowanceResponse = z.infer<typeof getAllowanceResponseSchema>
export type LatestBlockhashResponse = z.infer<typeof latestBlockhashResponseSchema>
export type ListSignaturesResponse = z.infer<typeof listSignaturesResponseSchema>
export type ListEventsResponse = z.infer<typeof listEventsResponseSchema>

/** Сервер відповів помилкою у форматі `shared`: код і повідомлення відомі. */
export class ApiRequestError extends Error {
  readonly status: number
  /** `null` — статус помилковий, а тіло не у форматі `apiErrorSchema`. */
  readonly code: ErrorCode | null
  /** `details.reason`, when the server named one (`push_disabled`, `node_behind`…). */
  readonly reason: string | null

  constructor(
    status: number,
    code: ErrorCode | null,
    message: string,
    reason: string | null = null,
  ) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
    this.reason = reason
  }
}

/** До сервера не дійшли: мережа, CORS, вимкнений процес. */
export class ApiUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(`could not reach ${url}`)
    this.name = 'ApiUnreachableError'
    this.cause = cause
  }
}

/**
 * Сервер відповів `200`, але тіло не збіглося зі схемою. Окремий клас, бо це не
 * збій мережі й не відмова: це різні версії контракту на двох боках, і показати
 * тут «спробуйте пізніше» означало б порадити чекати того, що не станеться.
 */
export class ApiContractError extends Error {
  constructor(path: string, cause: unknown) {
    super(`${path} answered with a body that does not match the contract`)
    this.name = 'ApiContractError'
    this.cause = cause
  }
}

export interface ApiClient {
  /**
   * `minSlot` — the oldest slot the network may answer from (`T042a`): after
   * `allowance.updated`, a read from before that change would undo it on screen.
   */
  listAllowances(
    owner: Address,
    signal?: AbortSignal,
    minSlot?: number,
  ): Promise<ListAllowancesResponse>
  /**
   * Один дозвіл за адресою. Гаманця тут не питають і не передають: дозволи
   * публічні в мережі, а `pda` вже й є тим, що ідентифікує запис.
   *
   * `NOT_FOUND` лишається `ApiRequestError` і **не** перетворюється на `null`
   * тут: «за цією адресою нічого немає» — це відповідь, яку розрізняє джерело
   * (`source.ts`), а клієнт лишається однією тонкою межею з HTTP.
   */
  getAllowance(pda: string, signal?: AbortSignal, minSlot?: number): Promise<GetAllowanceResponse>
  /**
   * Час життя транзакції відкликання. Береться в сервера, а не в браузера:
   * URL вузла з ключем провайдера в бандл не потрапляє (`routes/blockhash.ts`).
   */
  getBlockhash(signal?: AbortSignal): Promise<LatestBlockhashResponse>
  /**
   * Транзакції, що торкнулися адреси дозволу (`T030`). Окремим запитом, а не
   * полем картки: картка не має чекати на історію, а історія має право не
   * доїхати, не забравши з собою п'ять полів `FR-002`.
   */
  listSignatures(pda: string, limit?: number, signal?: AbortSignal): Promise<ListSignaturesResponse>
  /**
   * The indexer's feed of one permission (`T041`), one page at a time. `cursor`
   * is the previous page's `nextCursor`; without it, the newest page.
   */
  listEvents(pda: string, cursor: string | null, signal?: AbortSignal): Promise<ListEventsResponse>
  /**
   * The plan behind the subscribe screen (`T036`). With a `subscriber`, the
   * answer also carries that wallet's side: its authority, its token account,
   * and whether it is already subscribed.
   */
  getPlan(pda: string, subscriber: string | null, signal?: AbortSignal): Promise<PlanView>
}

/**
 * Web Push (`T043`) — apart from `ApiClient`, which is the source of what the
 * screens show; push is a setting of this browser, not a read.
 */
export interface PushApi {
  /** Whether this installation sends push at all, and the key to subscribe with (`T043`). */
  getPushKey(signal?: AbortSignal): Promise<PushKeyResponse>
  /** This browser follows `owner`. The server sends a welcome push before it answers. */
  subscribePush(body: PushSubscribeBody): Promise<void>
  /** This browser stops following `owner` — or every wallet, without one. */
  unsubscribePush(body: PushUnsubscribeBody): Promise<void>
}

/** Мінімум від `fetch`, потрібний клієнтові. Вужче — щоб тест не підробляв усе. */
export type FetchLike = (
  input: string,
  init?: {
    signal?: AbortSignal | undefined
    headers?: Record<string, string>
    method?: 'GET' | 'POST' | 'DELETE'
    body?: string
  },
) => Promise<Response>

/**
 * Порожній `baseUrl` — це той самий origin, що й сторінка, і саме він
 * замовчуваний: у продакшені `/v1` віддає той самий хост (`vercel.json`,
 * `T046`), а в розробці — прокси Vite. Замовчувати тут `http://localhost:8080`
 * означало б, що зібраний застосунок на чужій машині мовчки стукає в нікуди.
 */
export function createApiClient(baseUrl: string, fetchImpl: FetchLike): ApiClient & PushApi {
  const base = baseUrl.replace(/\/+$/, '')

  async function get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    return request('GET', path, schema, signal)
  }

  async function request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    payload?: unknown,
  ): Promise<T> {
    const url = `${base}${path}`
    let response: Response
    try {
      response = await fetchImpl(url, {
        signal,
        headers:
          payload === undefined
            ? { accept: 'application/json' }
            : { accept: 'application/json', 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { method }),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      })
    } catch (error) {
      // Скасований запит — не збій: його скасував сам застосунок.
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ApiUnreachableError(url, error)
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      const parsed = apiErrorSchema.safeParse(body)
      const reason = parsed.success ? parsed.data.error.details?.reason : undefined
      throw parsed.success
        ? new ApiRequestError(
            response.status,
            parsed.data.error.code,
            parsed.data.error.message,
            typeof reason === 'string' ? reason : null,
          )
        : new ApiRequestError(response.status, null, `${url} answered ${response.status}`)
    }

    const body: unknown = await response.json().catch((error: unknown) => {
      throw new ApiContractError(path, error)
    })
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw new ApiContractError(path, parsed.error)
    return parsed.data
  }

  return {
    listAllowances: (owner, signal, minSlot) =>
      get(
        `/v1/allowances?owner=${encodeURIComponent(owner)}${
          minSlot === undefined ? '' : `&minSlot=${minSlot}`
        }`,
        listAllowancesResponseSchema,
        signal,
      ),
    getAllowance: (pda, signal, minSlot) =>
      get(
        `/v1/allowances/${encodeURIComponent(pda)}${
          minSlot === undefined ? '' : `?minSlot=${minSlot}`
        }`,
        getAllowanceResponseSchema,
        signal,
      ),
    getBlockhash: (signal) => get('/v1/blockhash', latestBlockhashResponseSchema, signal),
    listSignatures: (pda, limit, signal) =>
      get(
        `/v1/allowances/${encodeURIComponent(pda)}/signatures${
          limit === undefined ? '' : `?limit=${limit}`
        }`,
        listSignaturesResponseSchema,
        signal,
      ),
    listEvents: (pda, cursor, signal) =>
      get(
        `/v1/allowances/${encodeURIComponent(pda)}/events${
          cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
        }`,
        listEventsResponseSchema,
        signal,
      ),
    getPlan: (pda, subscriber, signal) =>
      get(
        `/v1/plans/${encodeURIComponent(pda)}${
          subscriber === null ? '' : `?subscriber=${encodeURIComponent(subscriber)}`
        }`,
        getPlanViewResponseSchema,
        signal,
      ),
    getPushKey: (signal) => get('/v1/push/key', pushKeyResponseSchema, signal),
    subscribePush: async (body) => {
      await request('POST', '/v1/push/subscribe', okResponseSchema, undefined, body)
    },
    unsubscribePush: async (body) => {
      await request('DELETE', '/v1/push/subscribe', okResponseSchema, undefined, body)
    },
  }
}

/**
 * The stream of one wallet's changes (`T042`). Built here, next to the paths
 * the reads use, so the stream and the reads cannot point at two servers.
 */
export function streamUrl(baseUrl: string, owner: Address): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/stream?owner=${encodeURIComponent(owner)}`
}

/**
 * Невдача → рядок для екрана. Кажемо, що саме сталося: «не змогли завантажити»
 * без причини — це те саме мовчазне порожнє місце, яке `FR-022` забороняє
 * підсовувати замість списку.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof ApiUnreachableError) {
    return 'The wallet is fine — we could not reach CancelChain. Nothing here means we failed to load, not that nothing is running.'
  }
  if (error instanceof ApiContractError) {
    return 'CancelChain answered in a shape this page does not understand. This page is out of date with the server.'
  }
  if (error instanceof ApiRequestError) {
    if (error.code === 'RATE_LIMITED')
      return 'Too many requests to CancelChain. Try again in a minute.'
    if (error.code === 'INVALID_INPUT') return `CancelChain rejected the request: ${error.message}`
    return `CancelChain could not read your permissions: ${error.message}`
  }
  return error instanceof Error ? error.message : 'Something failed before the list could load.'
}
