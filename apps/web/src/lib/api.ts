import type { Address, ErrorCode } from '@cancelchain/shared'
import {
  apiErrorSchema,
  getAllowanceResponseSchema,
  latestBlockhashResponseSchema,
  listAllowancesResponseSchema,
  listSignaturesResponseSchema,
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

/** Сервер відповів помилкою у форматі `shared`: код і повідомлення відомі. */
export class ApiRequestError extends Error {
  readonly status: number
  /** `null` — статус помилковий, а тіло не у форматі `apiErrorSchema`. */
  readonly code: ErrorCode | null

  constructor(status: number, code: ErrorCode | null, message: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
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
  listAllowances(owner: Address, signal?: AbortSignal): Promise<ListAllowancesResponse>
  /**
   * Один дозвіл за адресою. Гаманця тут не питають і не передають: дозволи
   * публічні в мережі, а `pda` вже й є тим, що ідентифікує запис.
   *
   * `NOT_FOUND` лишається `ApiRequestError` і **не** перетворюється на `null`
   * тут: «за цією адресою нічого немає» — це відповідь, яку розрізняє джерело
   * (`source.ts`), а клієнт лишається однією тонкою межею з HTTP.
   */
  getAllowance(pda: string, signal?: AbortSignal): Promise<GetAllowanceResponse>
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
}

/** Мінімум від `fetch`, потрібний клієнтові. Вужче — щоб тест не підробляв усе. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal | undefined; headers?: Record<string, string> },
) => Promise<Response>

/**
 * Порожній `baseUrl` — це той самий origin, що й сторінка, і саме він
 * замовчуваний: у продакшені `/v1` віддає той самий хост (`vercel.json`,
 * `T046`), а в розробці — прокси Vite. Замовчувати тут `http://localhost:8080`
 * означало б, що зібраний застосунок на чужій машині мовчки стукає в нікуди.
 */
export function createApiClient(baseUrl: string, fetchImpl: FetchLike): ApiClient {
  const base = baseUrl.replace(/\/+$/, '')

  async function get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const url = `${base}${path}`
    let response: Response
    try {
      response = await fetchImpl(url, {
        signal,
        headers: { accept: 'application/json' },
      })
    } catch (error) {
      // Скасований запит — не збій: його скасував сам застосунок.
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ApiUnreachableError(url, error)
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      const parsed = apiErrorSchema.safeParse(body)
      throw parsed.success
        ? new ApiRequestError(response.status, parsed.data.error.code, parsed.data.error.message)
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
    listAllowances: (owner, signal) =>
      get(
        `/v1/allowances?owner=${encodeURIComponent(owner)}`,
        listAllowancesResponseSchema,
        signal,
      ),
    getAllowance: (pda, signal) =>
      get(`/v1/allowances/${encodeURIComponent(pda)}`, getAllowanceResponseSchema, signal),
    getBlockhash: (signal) => get('/v1/blockhash', latestBlockhashResponseSchema, signal),
    listSignatures: (pda, limit, signal) =>
      get(
        `/v1/allowances/${encodeURIComponent(pda)}/signatures${
          limit === undefined ? '' : `?limit=${limit}`
        }`,
        listSignaturesResponseSchema,
        signal,
      ),
  }
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
