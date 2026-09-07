import type { Address, UnreadableAllowanceItem } from '@cancelchain/shared'
import { type ApiClient, createApiClient } from './api.js'
import { PERMISSIONS, type Permission } from './mockData.js'
import { type AllowanceView, viewFromAllowance, viewFromPermission } from './view.js'

/**
 * Звідки екрани беруть дозволи — **єдине** місце, де це вирішується (`T031`).
 *
 * Обидва джерела віддають ту саму `AllowanceList`, тож перемикання «мок → api»
 * не чіпає жодного екрана. Ціна цього — приведення мока до моделі показу
 * (`view.ts`), а не навпаки: справжні дані до форми мока не зводяться, бо мок
 * не має ані PDA, ані чужих мінів, ані нечитаних акаунтів.
 */

export const SOURCE_KINDS = ['mock', 'api'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export interface AllowanceList {
  items: AllowanceView[]
  /** Коли цей список прочитано. */
  syncedAt: string
  /** Кеш старший за поріг свіжості (`FR-024`). Показується, а не мовчить. */
  stale: boolean
  /**
   * Акаунти гаманця, яких у списку немає, з названою причиною. Порожній масив —
   * це твердження «показано все»: `FR-006` не дозволяє списку тихо коротшати,
   * тож інтерфейс зобов'язаний сказати, скільки дозволів він не показав.
   */
  unreadable: UnreadableAllowanceItem[]
}

export interface AllowanceSource {
  readonly kind: SourceKind
  /**
   * Чи потрібен підключений гаманець. Мок обходиться без нього — і саме тому
   * інтерфейс мусить це питати, а не вважати відсутність гаманця порожнім
   * списком.
   */
  readonly requiresWallet: boolean
  /** Чи є за цим джерелом мережа. Від цього залежить, що застосунок каже про себе. */
  readonly onNetwork: boolean
  listAllowances(owner: Address | null, signal?: AbortSignal): Promise<AllowanceList>
}

export class WalletRequiredError extends Error {
  constructor() {
    super('an allowance list is a list of one wallet: connect a wallet first')
    this.name = 'WalletRequiredError'
  }
}

/**
 * Мок M0 у пам'яті модуля.
 *
 * Демо змінює свій стан кліками (скасував — картка згасла), тож список не може
 * читати незмінну константу: інакше скасування на екрані картки не було б видно
 * у списку, і прототип суперечив би сам собі. `PERMISSIONS` лишається цілим —
 * замінюються елементи копії, а не поля оригіналу.
 */
const mockPermissions: Permission[] = [...PERMISSIONS]

export const mockData = {
  read: (): readonly Permission[] => mockPermissions,
  find: (id: string): Permission | undefined => mockPermissions.find((p) => p.id === id),
  /** Додати на початок, якщо такого ще немає (демо оформлення підписки). */
  prepend(permission: Permission): void {
    if (mockPermissions.some((p) => p.id === permission.id)) return
    mockPermissions.unshift(permission)
  },
  update(id: string, change: (permission: Permission) => Permission): void {
    const index = mockPermissions.findIndex((p) => p.id === id)
    const current = mockPermissions[index]
    if (current === undefined) return
    mockPermissions[index] = change(current)
  },
}

export function createMockSource(): AllowanceSource {
  return {
    kind: 'mock',
    requiresWallet: false,
    onNetwork: false,
    listAllowances: () =>
      Promise.resolve({
        items: mockData.read().map(viewFromPermission),
        syncedAt: new Date().toISOString(),
        stale: false,
        // Вигаданих даних, яких не вдалося прочитати, не буває.
        unreadable: [],
      }),
  }
}

export function createApiSource(client: ApiClient): AllowanceSource {
  return {
    kind: 'api',
    requiresWallet: true,
    onNetwork: true,
    async listAllowances(owner, signal) {
      if (owner === null) throw new WalletRequiredError()
      const response = await client.listAllowances(owner, signal)
      /*
       * Момент відліку — коли мережу **прочитали**, а не коли малюємо. Від нього
       * залежить `periodElapsed`, і брати тут `new Date()` означало б, що список,
       * який пролежав на екрані хвилину, судить прочитане іншим годинником.
       */
      const readAt = new Date(response.syncedAt)
      return {
        items: response.items.map((item) => viewFromAllowance(item, readAt)),
        syncedAt: response.syncedAt,
        stale: response.stale,
        unreadable: response.unreadable,
      }
    },
  }
}

export class UnknownSourceError extends Error {
  constructor(value: string) {
    super(
      `unknown VITE_DATA_SOURCE: ${value}. Expected one of ${SOURCE_KINDS.join(', ')}. ` +
        'Nothing is guessed here: falling back would show invented numbers as if they were ' +
        "this wallet's real permissions.",
    )
    this.name = 'UnknownSourceError'
  }
}

/**
 * Джерело з оточення збірки. Незадане — `api`.
 *
 * Замовчування саме таке, а не `mock`, і це рішення про честь, а не про
 * зручність: мок показує вигадані числа під виглядом дозволів гаманця, і
 * випадково зібраний із ним застосунок бреше рівно про те, заради чого існує.
 * Мок треба попросити. **Невідома** назва не підмінюється мовчки ні в який бік.
 */
export function sourceKindFromEnv(env: Record<string, string | undefined>): SourceKind {
  const value = env.VITE_DATA_SOURCE
  if (value === undefined || value === '') return 'api'
  if (!(SOURCE_KINDS as readonly string[]).includes(value)) throw new UnknownSourceError(value)
  return value as SourceKind
}

/**
 * Базовий URL API. Порожній рядок — той самий origin, що й сторінка: у
 * розробці `/v1` проксює Vite, у продакшені — хост фронтенду (`T046`).
 */
export function apiBaseUrlFromEnv(env: Record<string, string | undefined>): string {
  return env.VITE_API_URL ?? ''
}

export function createSource(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): AllowanceSource {
  if (sourceKindFromEnv(env) === 'mock') return createMockSource()
  return createApiSource(createApiClient(apiBaseUrlFromEnv(env), fetchImpl))
}

/**
 * Джерело застосунку. Один екземпляр на завантаження сторінки: `queryKey`
 * включає `source.kind`, тож перемикання за оточенням не змішує два кеші.
 */
export const source = createSource(import.meta.env)
