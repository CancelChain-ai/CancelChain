import type { RevokeLifetime } from '@cancelchain/chain'
import { toBlockhash } from '@cancelchain/chain'
import type { Address, PlanView, UnreadableAllowanceItem } from '@cancelchain/shared'
import {
  type ApiClient,
  ApiRequestError,
  createApiClient,
  type GetAllowanceResponse,
  type ListAllowancesResponse,
} from './api.js'
import { PERMISSIONS, type Permission } from './mockData.js'
import {
  loadDemoSnapshot,
  replayFetch,
  replayStage,
  type SnapshotLoader,
  type StageStore,
} from './replay.js'
import { type ListStore, storedLists } from './storedList.js'
import {
  type AddressHistoryView,
  type AllowanceDetailView,
  type AllowanceView,
  detailFromAllowance,
  detailFromPermission,
  type EventPageView,
  eventPageFromResponse,
  historyFromSignatures,
  viewFromAllowance,
  viewFromPermission,
} from './view.js'

/**
 * Звідки екрани беруть дозволи — **єдине** місце, де це вирішується (`T031`).
 *
 * Обидва джерела віддають ту саму `AllowanceList`, тож перемикання «мок → api»
 * не чіпає жодного екрана. Ціна цього — приведення мока до моделі показу
 * (`view.ts`), а не навпаки: справжні дані до форми мока не зводяться, бо мок
 * не має ані PDA, ані чужих мінів, ані нечитаних акаунтів.
 */

export const SOURCE_KINDS = ['mock', 'api', 'snapshot'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/**
 * Where what the screens show comes from — and so what they must say about it:
 * read from the network now, invented (the M0 mock), or recorded from the
 * network earlier (`T058`). A recording is real data and not live, and neither
 * of the other two words is true of it.
 */
export type Provenance = 'network' | 'invented' | 'recorded'

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

/**
 * Те, без чого не побудувати транзакцію відкликання (`T026`).
 *
 * Окремо від читання списку, бо це інша обіцянка: тут не «показати», а
 * «звірити перед дією». `readNow` віддає **сиру** відповідь, а не модель
 * показу, і саме тому: білдеру потрібні `kind`, `owner` і `planPda`, а
 * `counterpartyAddress` у моделі показу для підписки й для решти означає різне.
 */
export interface AllowanceActions {
  /**
   * Стан дозволу просто зараз (`FR-024`). `null` — акаунта немає ніде: дозвіл
   * уже закрито, і підписувати нічого. Це відповідь, а не невдача.
   */
  readNow(pda: string, signal?: AbortSignal): Promise<GetAllowanceResponse | null>
  /** Час життя транзакції з мережі. */
  latestLifetime(signal?: AbortSignal): Promise<RevokeLifetime>
}

export interface AllowanceSource {
  readonly kind: SourceKind
  /**
   * Дії, що доходять до мережі. `null` — за джерелом мережі немає (мок), і
   * кнопка скасування там лишається демонстраційною: вона міняє число на
   * екрані й нічого не підписує.
   */
  readonly actions: AllowanceActions | null
  /**
   * Чи потрібен підключений гаманець. Мок обходиться без нього — і саме тому
   * інтерфейс мусить це питати, а не вважати відсутність гаманця порожнім
   * списком.
   */
  readonly requiresWallet: boolean
  /**
   * Where the data comes from. It decides what the app says about itself, and
   * whether the stream and notifications run: they need the network now, not a
   * recording of it.
   */
  readonly provenance: Provenance
  /** `minSlot` — see `ApiClient.listAllowances`; a source without a network ignores it. */
  listAllowances(
    owner: Address | null,
    signal?: AbortSignal,
    minSlot?: number,
  ): Promise<AllowanceList>
  /**
   * The list this browser last read for the wallet (`SC-008`), or `null`. Shown
   * only until the network answers, and marked as a copy while it is.
   */
  storedList(owner: Address): AllowanceList | null
  /**
   * Один дозвіл для екрана картки (`T024`).
   *
   * `null` — за цією адресою дозволу немає **ніде**: ані в мережі, ані у
   * сховищі. Це відповідь, а не невдача, і тому вона тут окремим значенням, а
   * не помилкою: скасований дозвіл — це закритий акаунт, і екран мусить
   * сказати саме це, а не «не вдалося завантажити».
   */
  getAllowance(
    id: string,
    signal?: AbortSignal,
    minSlot?: number,
  ): Promise<AllowanceDetailView | null>
  /**
   * Транзакції, що торкнулися адреси дозволу (`T030`).
   *
   * `null` — за цим джерелом мережі немає: у мока стрічка вже лежить у самій
   * картці, вигадана разом з усім іншим. Окремий запит, а не поле картки,
   * навмисно: п'ять полів `FR-002` не мають чекати на історію й не мають
   * зникати разом з нею, коли вона не доїде.
   */
  getHistory(id: string, signal?: AbortSignal): Promise<AddressHistoryView | null>
  /**
   * The indexer's feed of the permission (`T041a`), one page per call. `null` —
   * no network behind the source, as with `getHistory`. A permission the
   * indexer has never seen is a page with `tracked: false`, not a failure.
   */
  getEvents(id: string, cursor: string | null, signal?: AbortSignal): Promise<EventPageView | null>
  /**
   * The plan behind the subscribe screen (`T036`). `null` for the source itself —
   * the mock has no network, and its subscribe screen stays the M0 prototype.
   * The read answers `null` when there is no plan at that address.
   */
  readonly plans: {
    get(pda: string, subscriber: string | null, signal?: AbortSignal): Promise<PlanView | null>
  } | null
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
    actions: null,
    requiresWallet: false,
    provenance: 'invented',
    listAllowances: () =>
      Promise.resolve({
        items: mockData.read().map(viewFromPermission),
        syncedAt: new Date().toISOString(),
        stale: false,
        // Вигаданих даних, яких не вдалося прочитати, не буває.
        unreadable: [],
      }),
    // Invented data has nothing worth keeping between visits.
    storedList: () => null,
    getAllowance: (id) => {
      const permission = mockData.find(id)
      return Promise.resolve(permission === undefined ? null : detailFromPermission(permission))
    },
    // Мережі за моком немає, тож і історії адреси немає: вигадана стрічка
    // приїжджає в самій картці (`detail.activity`).
    getHistory: () => Promise.resolve(null),
    getEvents: () => Promise.resolve(null),
    plans: null,
  }
}

/*
 * Момент відліку — коли мережу **прочитали**, а не коли малюємо. Від нього
 * залежить `periodElapsed`, і брати тут `new Date()` означало б, що список,
 * який пролежав на екрані хвилину, судить прочитане іншим годинником.
 */
function listFromResponse(response: ListAllowancesResponse): AllowanceList {
  const readAt = new Date(response.syncedAt)
  return {
    items: response.items.map((item) => viewFromAllowance(item, readAt)),
    syncedAt: response.syncedAt,
    stale: response.stale,
    unreadable: response.unreadable,
  }
}

export function createApiSource(
  client: ApiClient,
  store: ListStore = storedLists,
): AllowanceSource {
  return {
    kind: 'api',
    actions: {
      async readNow(pda, signal) {
        try {
          return await client.getAllowance(pda, signal)
        } catch (error) {
          // Та сама межа, що й у `getAllowance`: «за цією адресою нічого немає»
          // — це відповідь. Тут вона означає «скасовувати вже нічого».
          if (error instanceof ApiRequestError && error.code === 'NOT_FOUND') return null
          throw error
        }
      },
      async latestLifetime(signal) {
        const { blockhash, lastValidBlockHeight } = await client.getBlockhash(signal)
        return {
          // Перевірка, а не приведення типу: зіпсований хеш падає тут, а не в
          // гаманці, тобто до того, як людина побачить вікно підпису.
          blockhash: toBlockhash(blockhash),
          lastValidBlockHeight: BigInt(lastValidBlockHeight),
        }
      },
    },
    requiresWallet: true,
    provenance: 'network',
    async listAllowances(owner, signal, minSlot) {
      if (owner === null) throw new WalletRequiredError()
      const response = await client.listAllowances(owner, signal, minSlot)
      store.save(owner, response)
      return listFromResponse(response)
    },
    storedList(owner) {
      const response = store.read(owner)
      return response === null ? null : listFromResponse(response)
    },
    async getAllowance(id, signal, minSlot) {
      try {
        const card = await client.getAllowance(id, signal, minSlot)
        // Той самий годинник, що й у списку: `periodElapsed` судить прочитане
        // моментом читання, а не моментом малювання.
        return detailFromAllowance(card, new Date(card.syncedAt))
      } catch (error) {
        /*
         * `NOT_FOUND` — це відповідь «за цією адресою дозволу немає ніде», а не
         * збій. Вона стає `null` рівно тут, і саме тому екран може сказати
         * «дозволу немає» замість «не вдалося завантажити» — різниця між цими
         * двома реченнями і є тим, заради чого продукт існує (`FR-022`).
         */
        if (error instanceof ApiRequestError && error.code === 'NOT_FOUND') return null
        throw error
      }
    },
    async getHistory(id, signal) {
      return historyFromSignatures(await client.listSignatures(id, undefined, signal))
    },
    async getEvents(id, cursor, signal) {
      return eventPageFromResponse(await client.listEvents(id, cursor, signal))
    },
    plans: {
      async get(pda, subscriber, signal) {
        try {
          return await client.getPlan(pda, subscriber, signal)
        } catch (error) {
          // The same boundary as the card: "no plan at this address" is an answer.
          if (error instanceof ApiRequestError && error.code === 'NOT_FOUND') return null
          throw error
        }
      },
    },
  }
}

/** Nothing of a replay is kept between visits: the recording itself is the copy. */
const NO_STORE: ListStore = { save: () => {}, read: () => null, clear: () => {} }

/**
 * The recorded demo (`T058`). The live source over a client whose `fetch`
 * answers from the recording — so every answer passes the same schemas and the
 * same model as a live one — minus everything that would act on the network:
 * no actions, no plans, no stored copy. The wallet is the recording's, not the
 * connected one.
 */
export function createSnapshotSource(
  load: SnapshotLoader = loadDemoSnapshot,
  stage: StageStore = replayStage,
): AllowanceSource {
  const recorded = createApiSource(createApiClient('', replayFetch(load, stage)), NO_STORE)
  return {
    ...recorded,
    kind: 'snapshot',
    actions: null,
    requiresWallet: false,
    provenance: 'recorded',
    async listAllowances(_owner, signal) {
      return recorded.listAllowances((await load()).owner, signal)
    },
    storedList: () => null,
    plans: null,
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

/** The build mode of the recorded demo (`T058`). */
export const REPLAY_MODE = 'replay'

/**
 * Джерело з оточення збірки. Незадане — `api`.
 *
 * A build in the `replay` mode (`vite build --mode replay`, `T058`) is always
 * `snapshot`: the mode is asked for the recording, and a variable left in
 * `.env` cannot quietly override it.
 *
 * Замовчування саме таке, а не `mock`, і це рішення про честь, а не про
 * зручність: мок показує вигадані числа під виглядом дозволів гаманця, і
 * випадково зібраний із ним застосунок бреше рівно про те, заради чого існує.
 * Мок треба попросити. **Невідома** назва не підмінюється мовчки ні в який бік.
 */
export function sourceKindFromEnv(env: Record<string, string | undefined>): SourceKind {
  if (env.MODE === REPLAY_MODE) return 'snapshot'
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
  const kind = sourceKindFromEnv(env)
  if (kind === 'mock') return createMockSource()
  if (kind === 'snapshot') return createSnapshotSource()
  return createApiSource(createApiClient(apiBaseUrlFromEnv(env), fetchImpl))
}

/**
 * Джерело застосунку. Один екземпляр на завантаження сторінки: `queryKey`
 * включає `source.kind`, тож перемикання за оточенням не змішує два кеші.
 */
export const source = createSource(import.meta.env)
