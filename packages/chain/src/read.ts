import type { Allowance } from '@cancelchain/shared'
import type {
  AccountInfoBase,
  AccountInfoWithBase64EncodedData,
  Address,
  Commitment,
  Slot,
} from '@solana/kit'
import {
  AccountDiscriminator,
  DELEGATOR_OFFSET,
  getPlanDecoder,
  PLAN_SIZE,
  type Plan,
  type RawProgramAccount,
  toEncodedAccount,
} from '@solana/subscriptions'
import {
  type DecodedDelegation,
  decodeDelegation,
  MissingPlanError,
  type PlanRef,
  toAllowance,
  UndecodableAccountError,
  type UndecodableReason,
  UnsupportedVersionError,
} from './decode.js'
import { findSubscription } from './pda.js'

/**
 * Читання **всіх** дозволів гаманця — `FR-001`, `FR-006`.
 *
 * «Усіх» тут буквальне: єдиний фільтр запиту — адреса власника в заголовку
 * акаунта (`getProgramAccounts` + `memcmp` на `DELEGATOR_OFFSET`). Ані реєстру
 * відомих застосунків, ані білого списку мерчантів, ані фільтра за міном у
 * цьому шляху немає — інакше дозвіл, виданий через чужий інтерфейс, не
 * потрапив би в список, і користувач не дізнався б про нього саме там, де
 * шукає. `header.payer` (застосунок або спонсор, що оплатив ренту) не читається
 * взагалі: хто заплатив за акаунт, до прав на гроші стосунку не має.
 */

/** Стеля `getMultipleAccounts` — 100 адрес за запит, це обмеження самого RPC. */
const MAX_ACCOUNTS_PER_REQUEST = 100

type ProgramAccountsFilter =
  | { dataSize: bigint }
  | { memcmp: { bytes: Address; encoding: 'base58'; offset: bigint } }

type ProgramAccountsConfig = {
  encoding: 'base64'
  withContext: true
  commitment?: Commitment
  filters?: readonly ProgramAccountsFilter[]
}

type Base64AccountInfo = AccountInfoBase & AccountInfoWithBase64EncodedData

/**
 * Рівно та частина RPC, якою користується читання.
 *
 * Вужчий тип, ніж `Rpc<SolanaRpcApi>`, узятий не заради краси: обидва методи в
 * kit перевантажені за кодуванням, і підробити їх у тесті означало б підробити
 * всі перевантаження. Справжній клієнт із `createChainClient` цьому типу
 * відповідає структурно — це перевіряє `read.test.ts`.
 */
export type ProgramAccountsRpc = {
  getProgramAccounts(
    program: Address,
    config: ProgramAccountsConfig,
  ): {
    send(): Promise<{ context: { slot: Slot }; value: readonly RawProgramAccount[] }>
  }
  getMultipleAccounts(
    addresses: readonly Address[],
    config: { encoding: 'base64'; commitment?: Commitment },
  ): {
    send(): Promise<{ context: { slot: Slot }; value: readonly (Base64AccountInfo | null)[] }>
  }
}

/** Мінімум від `ChainClient`, потрібний для читання. Сам клієнт йому відповідає. */
export type AllowanceReader = {
  rpc: ProgramAccountsRpc
  programAddress: Address
  /**
   * Розрахунковий актив (`FR-020`). Береться з конфігурації, а не з константи:
   * mainnet-USDC і devnet-USDC — різні міни, і зашитий рядок означав би, що на
   * devnet підтримуваним не буде **жоден** дозвіл.
   */
  usdcMint: Address
}

/** Чому акаунт не став карткою. Ніколи не мовчазне зникнення з переліку. */
export type UnreadableReason =
  | UndecodableReason
  /** Версія акаунта не та, під яку зібрано цей код: поля не читаються. */
  | 'version'
  /** Підписка є, а її плану знайти не вдалося — без плану невідомий актив. */
  | 'plan'
  /** Акаунт прочитано, але значення поля не лягає в модель (нульовий період тощо). */
  | 'fields'

export type UnreadableAllowance = {
  address: Address
  reason: UnreadableReason
  /** Текст названої причини — той самий, що пішов би в лог. */
  detail: string
}

/**
 * Дозвіл із позначкою активу — `FR-020`.
 *
 * Розрахунковий актив у продукту один, але гаманець може мати дозвіл у будь-якому
 * іншому: його видав чужий застосунок, і `FR-006` вимагає показати його разом з
 * усіма. Тому такий дозвіл не фільтрується й не ховається в `unreadable` —
 * він у списку з `assetSupported: false`.
 *
 * Наслідок для інтерфейсу (`T023`, `T024`): над таким дозволом не пропонується
 * жодної дії, **крім скасування**. Скасування лишається завжди — саме воно і є
 * причиною показувати чужий актив: інакше єдиний спосіб закрити такий дозвіл
 * зник би разом із карткою.
 */
export type ReadAllowance = Allowance & {
  assetSupported: boolean
}

export type AllowanceReadResult = {
  /** Слот, на якому прочитано **дозволи**. Плани читаються окремим запитом, пізніше. */
  slot: number
  syncedAt: string
  allowances: ReadAllowance[]
  /**
   * Акаунти власника, які під карткою показати не вийшло. Порожній масив — це
   * твердження «показано все»; непорожній зобов'язує інтерфейс сказати, скільки
   * дозволів він не показав і чому (`FR-006` не дозволяє тихо коротшати список).
   */
  unreadable: UnreadableAllowance[]
}

export type ReadAllowancesOptions = {
  owner: Address
  /** Момент, відносно якого рахується вичерпаність. За замовчуванням — зараз. */
  now?: Date
  commitment?: Commitment
  /**
   * Запасний прохід по **всіх** планах програми, коли підписку не вдалося
   * пов'язати з планом за прямим посиланням. Дорогий (на devnet це сотні
   * акаунтів по 491 байту й стільки ж деривацій), тому його є чим вимкнути;
   * за прямого посилання він не запускається жодного разу.
   */
  fullPlanScan?: boolean
}

type PlanAccount = { address: Address; plan: Plan }

/**
 * Слот у число. `slotSchema` тримає слот числом (`packages/shared`), і межу
 * безпечного цілого сучасні слоти не проходять і близько — але мовчки різати
 * `bigint` тут не можна: це мітка свіжості, за якою `FR-024` вирішує, чи
 * розійшовся кеш із мережею.
 */
function slotToNumber(slot: Slot): number {
  if (slot < 0n || slot > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`slot does not fit in a JS number: ${slot}`)
  }
  return Number(slot)
}

function memcmpFilter(bytes: Address, offset: number): ProgramAccountsFilter {
  return { memcmp: { bytes, encoding: 'base58', offset: BigInt(offset) } }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

/**
 * Акаунт → план, якщо це справді план.
 *
 * Перевіряється все три: власник акаунта (адреса з `getMultipleAccounts`
 * приходить не з програми й може належати кому завгодно), дискримінатор і
 * розмір. Жодна з трьох перевірок не зайва: декодер чужих байтів потрібної
 * довжини поверне не помилку, а правдоподібні числа.
 */
function toPlanAccount(raw: RawProgramAccount, programAddress: Address): PlanAccount | null {
  if (raw.account.owner !== programAddress) return null
  const encoded = toEncodedAccount(raw, programAddress)
  if (encoded.data[0] !== AccountDiscriminator.Plan) return null
  if (encoded.data.length !== PLAN_SIZE) return null
  return { address: raw.pubkey, plan: getPlanDecoder().decode(encoded.data) }
}

/** Плани за відомими адресами — один запит на кожні 100 адрес. */
async function readPlansByAddress(
  reader: AllowanceReader,
  addresses: readonly Address[],
  commitment: Commitment | undefined,
): Promise<PlanAccount[]> {
  const plans: PlanAccount[] = []
  for (const batch of chunk(addresses, MAX_ACCOUNTS_PER_REQUEST)) {
    const { value } = await reader.rpc
      .getMultipleAccounts(batch, {
        encoding: 'base64',
        ...(commitment === undefined ? {} : { commitment }),
      })
      .send()
    value.forEach((account, index) => {
      const pubkey = batch[index]
      if (account === null || pubkey === undefined) return
      const plan = toPlanAccount({ pubkey, account }, reader.programAddress)
      if (plan !== null) plans.push(plan)
    })
  }
  return plans
}

/**
 * Усі плани програми. Свій запит, а не `fetchPlansForOwner` із SDK: та функція
 * кидає на першому ж акаунті, який не декодується, і одна зіпсована метадата
 * мерчанта поховала б увесь список підписок.
 */
async function scanAllPlans(reader: AllowanceReader): Promise<PlanAccount[]> {
  const { value } = await reader.rpc
    .getProgramAccounts(reader.programAddress, {
      encoding: 'base64',
      withContext: true,
      filters: [{ dataSize: BigInt(PLAN_SIZE) }],
    })
    .send()
  const plans: PlanAccount[] = []
  for (const raw of value) {
    const plan = toPlanAccount(raw, reader.programAddress)
    if (plan !== null) plans.push(plan)
  }
  return plans
}

type SubscriptionAccount = {
  address: Address
  subscriber: Address
  /** Для підписки в цьому полі лежить адреса плану — див. `resolvePlanRefs`. */
  delegatee: Address
}

/**
 * Плани для підписок — другий запит, без якого списку не буде.
 *
 * Акаунт підписки не містить **ані міну, ані поля з адресою плану**: є лише
 * знімок умов (`PlanTerms` — сума, години, дата створення), у якому активу
 * немає. Мін приносить план.
 *
 * Куди йти по план, каже `header.delegatee`. Для `fixed` і `recurring` там
 * гаманець мерчанта, а для підписки — **адреса плану**: у структурі це те саме
 * поле `Header`, і типи цієї різниці не показують. Перевірено на devnet:
 * акаунт делегата належить самій програмі, має дискримінатор `Plan`, а його
 * власник — зовсім інша адреса (`probe`: `plan.owner ≠ delegatee`).
 *
 * Але припущення тут не є частиною коректності. PDA підписки виводиться з
 * `["subscription", planPda, subscriber]`, тож план приймається лише тоді, коли
 * деривація дає адресу самого акаунта. Помилкове посилання не дасть чужого міну
 * — воно дасть названу відмову `plan`. Умови (`terms`) для звірки не годяться:
 * `updatePlan` міняє їх уже після оформлення, і збіг був би не сильнішим за
 * випадковий.
 *
 * Якщо посилання все-таки не спрацювало, вмикається прохід по всіх планах
 * програми — з тією самою деривацією як доказом.
 */
async function resolvePlanRefs(
  reader: AllowanceReader,
  subscriptions: readonly SubscriptionAccount[],
  options: { fullPlanScan: boolean; commitment: Commitment | undefined },
): Promise<Map<Address, PlanRef>> {
  const refs = new Map<Address, PlanRef>()
  if (subscriptions.length === 0) return refs

  const subscribers = [...new Set(subscriptions.map((entry) => entry.subscriber))]
  const candidates = [...new Set(subscriptions.map((entry) => entry.delegatee))]

  await indexPlans(
    refs,
    await readPlansByAddress(reader, candidates, options.commitment),
    subscribers,
  )

  const missing = subscriptions.some((entry) => !refs.has(entry.address))
  if (missing && options.fullPlanScan) {
    await indexPlans(refs, await scanAllPlans(reader), subscribers)
  }
  return refs
}

/** Кандидат-план × передплатник → адреса, яку така пара мала б мати. */
async function indexPlans(
  refs: Map<Address, PlanRef>,
  plans: readonly PlanAccount[],
  subscribers: readonly Address[],
): Promise<void> {
  for (const { address, plan } of plans) {
    for (const subscriber of subscribers) {
      const derived = await findSubscription({ planPda: address, subscriber })
      refs.set(derived.address, { pda: address, mint: plan.data.mint })
    }
  }
}

function unreadableFrom(
  address: Address,
  reason: UnreadableReason,
  error: unknown,
): UnreadableAllowance {
  return { address, reason, detail: error instanceof Error ? error.message : String(error) }
}

/** Помилка приведення до `Allowance` → названа причина, а не зникнення з переліку. */
function reasonFor(error: unknown): UnreadableReason {
  if (error instanceof UnsupportedVersionError) return 'version'
  if (error instanceof MissingPlanError) return 'plan'
  if (error instanceof UndecodableAccountError) return error.reason
  return 'fields'
}

/** Порядок мережі не визначений — сортуємо за адресою, щоб список не стрибав. */
function byAddress(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Усі дозволи гаманця з мережі, приведені до `Allowance`.
 *
 * Один запит на самі дозволи (звідси й слот, спільний для всього списку) плюс
 * `getMultipleAccounts` по планах, коли серед дозволів є підписки. Жоден акаунт
 * не зникає мовчки: усе, що не стало карткою, лежить у `unreadable` з названою
 * причиною, а дозвіл у чужому активі лишається в списку з `assetSupported: false`
 * (`FR-020`).
 */
export async function readAllowances(
  reader: AllowanceReader,
  options: ReadAllowancesOptions,
): Promise<AllowanceReadResult> {
  const { context, value } = await reader.rpc
    .getProgramAccounts(reader.programAddress, {
      encoding: 'base64',
      withContext: true,
      ...(options.commitment === undefined ? {} : { commitment: options.commitment }),
      filters: [memcmpFilter(options.owner, DELEGATOR_OFFSET)],
    })
    .send()

  const slot = slotToNumber(context.slot)
  const syncedAt = (options.now ?? new Date()).toISOString()

  const decoded: DecodedDelegation[] = value.map((raw) =>
    decodeDelegation(raw.pubkey, toEncodedAccount(raw, reader.programAddress).data),
  )

  const subscriptions: SubscriptionAccount[] = decoded
    .filter((entry) => entry.kind === 'subscription')
    .map((entry) => ({
      address: entry.address,
      subscriber: entry.data.header.delegator,
      delegatee: entry.data.header.delegatee,
    }))

  const planRefs = await resolvePlanRefs(reader, subscriptions, {
    fullPlanScan: options.fullPlanScan ?? true,
    commitment: options.commitment,
  })

  const allowances: ReadAllowance[] = []
  const unreadable: UnreadableAllowance[] = []
  for (const entry of decoded) {
    if (entry.kind === 'unknown') {
      const error = new UndecodableAccountError(entry.address, entry.reason)
      unreadable.push(unreadableFrom(entry.address, entry.reason, error))
      continue
    }
    const plan = entry.kind === 'subscription' ? planRefs.get(entry.address) : undefined
    try {
      const allowance = toAllowance(entry, {
        slot,
        syncedAt,
        ...(plan === undefined ? {} : { plan }),
        ...(options.now === undefined ? {} : { now: options.now }),
      })
      allowances.push({ ...allowance, assetSupported: allowance.mint === reader.usdcMint })
    } catch (error) {
      unreadable.push(unreadableFrom(entry.address, reasonFor(error), error))
    }
  }

  return {
    slot,
    syncedAt,
    allowances: allowances.sort((a, b) => byAddress(a.pda, b.pda)),
    unreadable: unreadable.sort((a, b) => byAddress(a.address, b.address)),
  }
}
