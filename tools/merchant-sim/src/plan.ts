import {
  findPlan,
  PROGRAM_ADDRESS,
  timestampFromChain,
  timestampToChain,
  toAddress,
  toBlockhash,
} from '@cancelchain/chain'
import { U64_MAX } from '@cancelchain/shared'
import type {
  Address,
  Base64EncodedWireTransaction,
  Commitment,
  Instruction,
  Signature,
  Transaction,
  TransactionMessageWithBlockhashLifetime,
  TransactionMessageWithFeePayer,
  TransactionSigner,
} from '@solana/kit'
import {
  appendTransactionMessageInstruction,
  type compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit'
import {
  AccountDiscriminator,
  getCreatePlanOverlayInstructionAsync,
  getPlanDecoder,
  MAX_PLAN_DESTINATIONS,
  MAX_PLAN_PULLERS,
  METADATA_URI_LEN,
  PLAN_SIZE,
  PlanStatus,
  ZERO_ADDRESS,
} from '@solana/subscriptions'
import {
  CHARGE_TRANSACTION_VERSION,
  type ChargeLifetime,
  type ChargeRpc,
  programErrorCodeOf,
  runtimeErrorLabelOf,
} from './charge.js'

/**
 * Створення плану підписки — ончейн-половина `FR-014`.
 *
 * План — акаунт **мерчанта** під `["plan", owner, planId]`: сума за період,
 * період у **годинах** (не секундах — головна пастка проєкту, див.
 * `packages/shared/period.ts`), мін, дата кінця, до чотирьох гаманців-отримувачів
 * і до чотирьох гаманців, яким дозволено тягнути. Назви плану в мережі **немає**:
 * вона офчейн і кладеться окремо (`T035`, `POST /v1/merchants/plans`), тому тут
 * її немає навіть як необов'язкового поля — поле, яке нікуди не їде, брехало б.
 *
 * Звірено по devnet 2026-09-21 на живих планах програми (їх 835):
 *
 * | Поле | Що там лежить |
 * |---|---|
 * | `destinations` | **гаманці**, не токен-акаунти; програма відповідає `UnauthorizedDestination`, коли власник `receiverAta` не з переліку |
 * | `pullers` | гаманці, яким дозволено `transferSubscription` |
 * | `endTs` | `0` — безстроково; інакше — секунди, і лише в майбутньому (`InvalidEndTs`) |
 * | `terms.createdAt` | ставить **програма**; SDK кладе `0`, і це не наше поле |
 * | `metadataUri` | ≤128 байт UTF-8, порожній рядок — норма |
 *
 * Перевіряються, як і в списанні, лише **власні входи**: сума, період, дати,
 * адреси, довжини переліків. Чи існує вже план із таким `planId`, чи є в
 * мерчанта SOL на ренту — вирішує мережа, і її відповідь віддається як є.
 */

/** Умови плану так, як їх називає мерчант. Усе, що піде в мережу, — тут. */
export type PlanTerms = {
  /**
   * u64, який мерчант обирає сам. Значення за замовчуванням немає: збіг із
   * наявним планом дає `PlanAlreadyExists`, і мовчазний нуль зробив би другий
   * план невідтворюваною помилкою — та сама логіка, що й у `nonce` видачі.
   */
  planId: bigint
  /** Сума за період, у базових одиницях міну. */
  amount: bigint
  /** Період у **годинах** — одиниця самої програми (`PlanTerms.periodHours`). */
  periodHours: number
  /** `null` — безстроково. Інакше ISO 8601 у майбутньому. */
  endsAt: string | null
  /** Гаманці, на чиї токен-акаунти дозволено зараховувати. 1…4. */
  destinations: readonly string[]
  /** Гаманці, яким дозволено тягнути з підписок на цей план. 1…4. */
  pullers: readonly string[]
  /** ≤128 байт UTF-8. Порожній рядок — «без метаданих», і це законно. */
  metadataUri: string
}

export class PlanAmountError extends Error {
  constructor(readonly amount: bigint) {
    super(
      `the plan amount must be a positive u64, got ${amount}. Zero is not "free": the program ` +
        'rejects it, and a negative or oversized value would be encoded as something else',
    )
    this.name = 'PlanAmountError'
  }
}

export class PlanPeriodError extends Error {
  constructor(readonly periodHours: number) {
    super(
      `the period must be a positive whole number of hours, got ${periodHours}. The program ` +
        'stores hours, not seconds: 720 is a month, 720 seconds would be twelve minutes',
    )
    this.name = 'PlanPeriodError'
  }
}

export class PlanEndError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanEndError'
  }
}

export class PlanIdError extends Error {
  constructor(readonly planId: bigint) {
    super(`planId does not fit in u64: ${planId}`)
    this.name = 'PlanIdError'
  }
}

export class PlanListError extends Error {
  constructor(
    readonly field: 'destinations' | 'pullers',
    message: string,
  ) {
    super(message)
    this.name = 'PlanListError'
  }
}

export class PlanMetadataUriError extends Error {
  constructor(readonly bytes: number) {
    super(
      `metadataUri is ${bytes} bytes, the program stores at most ${METADATA_URI_LEN}. It would ` +
        'not be truncated politely — the instruction is refused',
    )
    this.name = 'PlanMetadataUriError'
  }
}

const utf8 = new TextEncoder()

/**
 * Перелік гаманців для плану: непорожній, у межах SDK, без повторів і без
 * нульової адреси.
 *
 * Нульова адреса перевіряється окремо, бо вона **не помилка кодування**: саме
 * нею SDK добиває перелік до чотирьох, і нульова адреса, названа руками,
 * зникла б у цьому доповненні мовчки — тобто мерчант назвав би отримувача,
 * а план його не містив би.
 */
function assertWalletList(
  field: 'destinations' | 'pullers',
  wallets: readonly string[],
  max: number,
): Address[] {
  if (wallets.length === 0) {
    throw new PlanListError(
      field,
      field === 'destinations'
        ? 'a plan needs at least one destination wallet: the program answers ' +
            'InvalidNumDestinations to an empty list, after the fee'
        : 'a plan needs at least one puller: nobody could ever charge a subscription to it, ' +
            'and merchant-sim would not be able to play the merchant',
    )
  }
  if (wallets.length > max) {
    throw new PlanListError(field, `${field} holds at most ${max} wallets, got ${wallets.length}`)
  }
  const addresses = wallets.map((wallet) => toAddress(wallet))
  if (addresses.includes(ZERO_ADDRESS)) {
    throw new PlanListError(
      field,
      `${field} contains the zero address, which is how the program marks an empty slot; ` +
        'it would be indistinguishable from "nobody"',
    )
  }
  if (new Set(addresses).size !== addresses.length) {
    throw new PlanListError(field, `${field} lists the same wallet twice`)
  }
  return addresses
}

/** Перевірка власних входів — усього, що не є рішенням мережі. */
export function assertPlanTerms(terms: PlanTerms, now: Date = new Date()): void {
  if (terms.planId < 0n || terms.planId > U64_MAX) throw new PlanIdError(terms.planId)
  if (terms.amount <= 0n || terms.amount > U64_MAX) throw new PlanAmountError(terms.amount)
  if (!Number.isSafeInteger(terms.periodHours) || terms.periodHours <= 0) {
    throw new PlanPeriodError(terms.periodHours)
  }
  const end = timestampToChain(terms.endsAt)
  if (end !== 0n && end <= BigInt(Math.floor(now.getTime() / 1000))) {
    throw new PlanEndError(
      `the end date ${terms.endsAt} is already in the past; the program refuses it ` +
        '(InvalidEndTs), and a plan that ends on arrival is not what the merchant meant',
    )
  }
  assertWalletList('destinations', terms.destinations, MAX_PLAN_DESTINATIONS)
  assertWalletList('pullers', terms.pullers, MAX_PLAN_PULLERS)
  const bytes = utf8.encode(terms.metadataUri).length
  if (bytes > METADATA_URI_LEN) throw new PlanMetadataUriError(bytes)
}

export type CreatePlanInput = {
  terms: PlanTerms
  /** Мерчант: власник плану, він же підписує. Єдиний ключ у продукті. */
  merchant: TransactionSigner
  /** Розрахунковий актив плану. */
  tokenMint: string
  /**
   * Токен-програма міну — властивість міну, не наша; читається з мережі
   * (`resolveTokenProgram` із `charge.ts`). Вгадування дало б відмову
   * `InvalidTokenProgram` замість плану.
   */
  tokenProgram: string
  /**
   * Хто платить ренту за акаунт плану. Не задано — сам мерчант. Ренту при
   * видаленні плану програма повертає **власнику**, не платнику, — тож чужий
   * спонсор тут не підставляється мовчки.
   */
  payer?: TransactionSigner
  /** Момент, відносно якого перевіряється дата кінця. За замовчуванням — зараз. */
  now?: Date
  programAddress?: Address
}

/**
 * Адреса плану — відома **до** підпису. Показати її й дочекатися саме цього
 * акаунта надійніше, ніж довіряти підпису.
 */
export async function findPlanAddress(seeds: { owner: string; planId: bigint }): Promise<Address> {
  const { address } = await findPlan({ owner: toAddress(seeds.owner), planId: seeds.planId })
  return address
}

/**
 * Інструкція створення плану.
 *
 * `rpc` у сигнатурі немає навмисно, як і в списанні: усе, що потребує мережі
 * (токен-програма, існування плану, баланс), або приходить готовим, або
 * вирішується самою програмою.
 */
export async function buildCreatePlanInstruction(input: CreatePlanInput): Promise<Instruction> {
  const { terms } = input
  assertPlanTerms(terms, input.now ?? new Date())
  return getCreatePlanOverlayInstructionAsync({
    amount: terms.amount,
    destinations: terms.destinations.map((wallet) => toAddress(wallet)),
    endTs: timestampToChain(terms.endsAt),
    metadataUri: terms.metadataUri,
    mint: toAddress(input.tokenMint),
    owner: input.merchant,
    periodHours: BigInt(terms.periodHours),
    planId: terms.planId,
    programAddress: input.programAddress ?? PROGRAM_ADDRESS,
    pullers: terms.pullers.map((wallet) => toAddress(wallet)),
    tokenProgram: toAddress(input.tokenProgram),
    ...(input.payer === undefined ? {} : { payer: input.payer }),
  })
}

export type CreatePlanTransactionInput = CreatePlanInput & { lifetime: ChargeLifetime }

export type CreatePlanTransactionMessage = Parameters<typeof compileTransaction>[0] &
  TransactionMessageWithFeePayer &
  TransactionMessageWithBlockhashLifetime

export type CreatePlanTransaction = {
  message: CreatePlanTransactionMessage
  transaction: Transaction
  /** Підпис відомий **до** надсилання — саме за ним питається мережа. */
  signature: Signature
  wireTransactionBase64: Base64EncodedWireTransaction
}

/**
 * Зібрана й підписана транзакція: одна інструкція, комісію платить той, хто
 * платить ренту, — за замовчуванням мерчант.
 */
export async function buildCreatePlanTransaction(
  input: CreatePlanTransactionInput,
): Promise<CreatePlanTransaction> {
  const instruction = await buildCreatePlanInstruction(input)
  const message = pipe(
    createTransactionMessage({ version: CHARGE_TRANSACTION_VERSION }),
    (draft) => setTransactionMessageFeePayerSigner(input.payer ?? input.merchant, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(input.lifetime, draft),
    (draft) => appendTransactionMessageInstruction(instruction, draft),
  )
  const transaction = await signTransactionMessageWithSigners(message)
  return {
    message,
    transaction,
    signature: getSignatureFromTransaction(transaction),
    wireTransactionBase64: getBase64EncodedWireTransaction(transaction),
  }
}

/**
 * Чим скінчилося створення.
 *
 * Форма та сама, що й у вердикту списання, з однією відмінністю: `not-sent`
 * тут трапляється **часто й навмисно** — див. `skipPreflight` нижче.
 */
export type CreatePlanVerdict =
  | { outcome: 'created'; pda: Address; signature: Signature; slot: bigint }
  | {
      outcome: 'rejected'
      pda: Address
      signature: Signature
      slot: bigint
      error: unknown
      programErrorCode: number | null
    }
  | { outcome: 'unknown'; pda: Address; signature: Signature; detail: string }
  /** Транзакція нікуди не поїхала — або ще до збирання, або вузол відмовив. */
  | { outcome: 'not-sent'; pda: Address | null; signature: Signature | null; detail: string }

export type CreatePlanOptions = {
  commitment?: Commitment
  /**
   * За замовчуванням `false` — **навпаки до списання**, і з тієї ж причини.
   * Приречена спроба списання мусить сісти в ланцюжок, бо саме її відмова і є
   * доказом (`SC-001`). Приречене створення плану не доводить нічого: план —
   * наш власний акаунт, і «програма відмовила» тут означає лише, що ми
   * помилилися у входах. Передполіт ловить це до комісії.
   */
  skipPreflight?: boolean
  pollAttempts?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_POLL_ATTEMPTS = 20
const DEFAULT_POLL_INTERVAL_MS = 1_500

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Помилка рядком — разом із ланцюжком `cause`.
 *
 * Відмова на передпольоті приходить від kit як `SolanaError: Transaction
 * simulation failed`, а код програми лежить у `cause` (`Custom program error:
 * #518`). Без ланцюжка CLI казав би лише «симуляція впала» — тобто ховав би
 * єдину корисну частину відповіді. Переклад коду в назву — не тут (`T040`).
 */
function detailOf(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(' → ')
}

/**
 * Створити план: зібрати → підписати → надіслати → **спитати мережу**.
 *
 * Помилка надсилання з увімкненим передпольотом — це остаточна відповідь:
 * вузол симулював транзакцію в себе й далі її не передавав, тож підпису в
 * мережі не існує й питати про нього нема чого. Без передпольоту (явно
 * `skipPreflight: true`) діє та сама обережність, що й у списанні: спершу
 * питається мережа, і лише її мовчання робить помилку надсилання вердиктом.
 */
export async function createPlan(
  rpc: ChargeRpc,
  input: CreatePlanInput,
  options: CreatePlanOptions = {},
): Promise<CreatePlanVerdict> {
  const commitment = options.commitment ?? 'confirmed'
  const skipPreflight = options.skipPreflight ?? false
  const sleep = options.sleep ?? realSleep
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  let pda: Address
  let plan: CreatePlanTransaction
  try {
    pda = await findPlanAddress({ owner: input.merchant.address, planId: input.terms.planId })
    const { value } = await rpc.getLatestBlockhash({ commitment }).send()
    plan = await buildCreatePlanTransaction({
      ...input,
      lifetime: {
        blockhash: toBlockhash(value.blockhash),
        lastValidBlockHeight: value.lastValidBlockHeight,
      },
    })
  } catch (error) {
    return { outcome: 'not-sent', pda: null, signature: null, detail: detailOf(error) }
  }

  let sendError: unknown = null
  try {
    await rpc
      .sendTransaction(plan.wireTransactionBase64, {
        encoding: 'base64',
        preflightCommitment: commitment,
        skipPreflight,
      })
      .send()
  } catch (error) {
    sendError = error
  }
  if (sendError !== null && !skipPreflight) {
    return {
      outcome: 'not-sent',
      pda,
      signature: plan.signature,
      detail: `the node refused it in preflight, nothing reached the network — ${detailOf(sendError)}`,
    }
  }

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    if (attempt > 0) await sleep(pollIntervalMs)
    let status: { err: unknown; slot: bigint } | null
    try {
      const { value } = await rpc
        .getSignatureStatuses([plan.signature], { searchTransactionHistory: true })
        .send()
      status = value[0] ?? null
    } catch {
      continue
    }
    if (status === null) continue
    if (status.err === null || status.err === undefined) {
      return { outcome: 'created', pda, signature: plan.signature, slot: BigInt(status.slot) }
    }
    return {
      outcome: 'rejected',
      pda,
      signature: plan.signature,
      slot: BigInt(status.slot),
      error: status.err,
      programErrorCode: programErrorCodeOf(status.err),
    }
  }

  if (sendError !== null) {
    return {
      outcome: 'not-sent',
      pda,
      signature: plan.signature,
      detail: `the node refused the transaction and the network never saw it — ${detailOf(sendError)}`,
    }
  }
  return {
    outcome: 'unknown',
    pda,
    signature: plan.signature,
    detail:
      `sent, but the network reported no status for it after ${pollAttempts} attempts. ` +
      'This is neither a plan nor a rejection: check the signature in an explorer',
  }
}

/**
 * Рівно та частина RPC, якою читається план. Вужчий тип, ніж `Rpc<SolanaRpcApi>`,
 * з тієї самої причини, що й `ChargeRpc`; справжній клієнт відповідає йому
 * структурно — це перевіряє `plan.test.ts`.
 */
export type PlanReaderRpc = {
  getAccountInfo(
    address: Address,
    config: { encoding: 'base64'; commitment?: Commitment },
  ): {
    send(): Promise<{
      value: { owner: Address; data: readonly [string, string] } | null
    }>
  }
}

/**
 * План так, як його зберігає мережа, — для показу після створення й для
 * звірки з тим, що просили.
 *
 * `destinations` і `pullers` тут **без** нульових адрес: у мережі перелік
 * завжди на чотири місця, і порожні місця — це не «гаманець
 * `1111…1111`», а відсутність гаманця.
 */
export type PlanSnapshot = {
  pda: Address
  owner: Address
  status: 'active' | 'sunset'
  planId: bigint
  mint: Address
  amount: bigint
  periodHours: number
  /** Ставить програма в момент створення. */
  createdAt: string | null
  endsAt: string | null
  destinations: Address[]
  pullers: Address[]
  metadataUri: string
}

export class PlanNotFoundError extends Error {
  constructor(readonly pda: Address) {
    super(`there is no account at ${pda}: the plan does not exist, or it has been deleted`)
    this.name = 'PlanNotFoundError'
  }
}

export class NotAPlanError extends Error {
  constructor(
    readonly pda: Address,
    detail: string,
  ) {
    super(`the account at ${pda} is not a plan of the program: ${detail}`)
    this.name = 'NotAPlanError'
  }
}

function planStatus(raw: number): PlanSnapshot['status'] {
  return raw === PlanStatus.Sunset ? 'sunset' : 'active'
}

function periodHoursFromChain(hours: bigint): number {
  if (hours <= 0n || hours > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`period of ${hours} hours does not fit in a JS number`)
  }
  return Number(hours)
}

/**
 * План із мережі. Перевіряються всі три ознаки — власник, дискримінатор,
 * розмір: декодер чужих байтів потрібної довжини повертає не помилку, а
 * правдоподібні числа (та сама обережність, що й у `packages/chain/read.ts`).
 */
export async function readPlan(
  rpc: PlanReaderRpc,
  pda: Address,
  options: { commitment?: Commitment; programAddress?: Address } = {},
): Promise<PlanSnapshot> {
  const programAddress = options.programAddress ?? PROGRAM_ADDRESS
  const { value } = await rpc
    .getAccountInfo(pda, {
      encoding: 'base64',
      ...(options.commitment === undefined ? {} : { commitment: options.commitment }),
    })
    .send()
  if (value === null) throw new PlanNotFoundError(pda)
  if (value.owner !== programAddress) {
    throw new NotAPlanError(pda, `it belongs to ${value.owner}, not to the program`)
  }
  const bytes = getBase64Encoder().encode(value.data[0])
  if (bytes.length !== PLAN_SIZE) {
    throw new NotAPlanError(pda, `it holds ${bytes.length} bytes, a plan holds ${PLAN_SIZE}`)
  }
  if (bytes[0] !== AccountDiscriminator.Plan) {
    throw new NotAPlanError(
      pda,
      `its discriminator is ${bytes[0]}, a plan's is ${AccountDiscriminator.Plan}`,
    )
  }
  const decoded = getPlanDecoder().decode(bytes)
  const present = (wallets: readonly Address[]) =>
    wallets.filter((wallet) => wallet !== ZERO_ADDRESS)
  return {
    pda,
    owner: decoded.owner,
    status: planStatus(decoded.status),
    planId: decoded.data.planId,
    mint: decoded.data.mint,
    amount: decoded.data.terms.amount,
    periodHours: periodHoursFromChain(decoded.data.terms.periodHours),
    createdAt: timestampFromChain(decoded.data.terms.createdAt),
    endsAt: timestampFromChain(decoded.data.endTs),
    destinations: present(decoded.data.destinations),
    pullers: present(decoded.data.pullers),
    metadataUri: decoded.data.metadataUri,
  }
}

/**
 * Помилка мережі рядком. `JSON.stringify` кидає на `BigInt`, а мережа саме
 * його й повертає — той самий заміщувач, що й у `charge.ts`.
 */
function stringifyError(error: unknown): string {
  return JSON.stringify(error, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

/** Рядок вердикту для CLI. */
export function describeCreatePlanVerdict(verdict: CreatePlanVerdict): string {
  switch (verdict.outcome) {
    case 'created':
      return `CREATED       slot ${verdict.slot}\nsignature:    ${verdict.signature}`
    case 'rejected': {
      const code =
        verdict.programErrorCode === null
          ? `${runtimeErrorLabelOf(verdict.error) ?? 'unrecognised'} — the runtime refused it, not the program`
          : `program error ${verdict.programErrorCode}`
      return [
        `REJECTED      slot ${verdict.slot}`,
        `signature:    ${verdict.signature}`,
        `reason:       ${code}`,
        `raw error:    ${stringifyError(verdict.error)}`,
      ].join('\n')
    }
    case 'unknown':
      return `UNKNOWN       ${verdict.detail}\nsignature:    ${verdict.signature}`
    default:
      return `NOT SENT      ${verdict.detail}${
        verdict.signature === null ? '' : `\nsignature:    ${verdict.signature}`
      }`
  }
}

/** Рядки знімка плану для CLI — те, що каже мережа, а не те, що просили. */
export function describePlan(plan: PlanSnapshot): string {
  return [
    `plan:         ${plan.pda}`,
    `owner:        ${plan.owner}`,
    `status:       ${plan.status}`,
    `plan id:      ${plan.planId}`,
    `mint:         ${plan.mint}`,
    `amount:       ${plan.amount} base units per period`,
    `period:       ${plan.periodHours} h`,
    `created:      ${plan.createdAt ?? 'not stamped'}`,
    `ends:         ${plan.endsAt ?? 'never'}`,
    `destinations: ${plan.destinations.join(', ')}`,
    `pullers:      ${plan.pullers.join(', ')}`,
    `metadata:     ${plan.metadataUri === '' ? '(none)' : plan.metadataUri}`,
  ].join('\n')
}
