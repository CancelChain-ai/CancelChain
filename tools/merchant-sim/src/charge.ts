import { PROGRAM_ADDRESS, toAddress, toBlockhash } from '@cancelchain/chain'
import { ALLOWANCE_KINDS, type Allowance, U64_MAX } from '@cancelchain/shared'
import type {
  Address,
  Base64EncodedWireTransaction,
  Blockhash,
  Commitment,
  Instruction,
  Signature,
  Slot,
  Transaction,
  TransactionMessageWithBlockhashLifetime,
  TransactionMessageWithFeePayer,
  TransactionSigner,
  TransactionVersion,
} from '@solana/kit'
import {
  appendTransactionMessageInstruction,
  type compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit'
import {
  getTransferFixedOverlayInstructionAsync,
  getTransferRecurringOverlayInstructionAsync,
  getTransferSubscriptionOverlayInstructionAsync,
} from '@solana/subscriptions'
import { findAssociatedTokenPda } from '@solana-program/token'

/**
 * Спроба списання за дозволом — `FR-004`, `FR-016`, `FR-023`.
 *
 * ⚠️ **Тут навмисно немає жодної перевірки живого стану дозволу.** Ані «акаунт
 * ще на місці», ані «стеля не вибрана», ані «період настав». Спокуса така
 * перевірка є: вона зекономила б комісію на завідомо приреченій транзакції. Але
 * `FR-004` вимагає, щоб спроба після відкликання відхилялася **на рівні
 * протоколу, а не на рівні застосунку**, а `SC-001` міряє нуль успішних списань
 * на ≥200 спроб. Якби `merchant-sim` сам відмовлявся надсилати, обидва
 * вимірювання перевіряли б наш `if`, а не чужу програму, — і будь-яка дірка в
 * програмі лишилася б непоміченою рівно тому, що ми до неї не достукалися.
 *
 * Тому єдиний суддя тут — мережа. Перевіряються лише **власні входи** (сума,
 * узгодженість акаунтів, наш ключ), тобто те, що зробило б транзакцію не
 * «відхиленою», а «зібраною не тим боком».
 *
 * Що саме викликається — залежить від типу дозволу, і всі три інструкції різні
 * (на відміну від відкликання, де одна на всіх, див. `packages/chain/revoke.ts`):
 *
 * | Тип | Інструкція | Хто підписує | Що ще читає програма |
 * |---|---|---|---|
 * | `fixed` | `transferFixed` (4) | `delegatee` — гаманець мерчанта | — |
 * | `recurring` | `transferRecurring` (5) | `delegatee` — гаманець мерчанта | — |
 * | `subscription` | `transferSubscription` (10) | `caller` | план: перелік `pullers` і `destinations` |
 */

/** Версія транзакції — та сама, що й у відкликанні, і з тієї самої причини. */
export const CHARGE_TRANSACTION_VERSION = 0 satisfies TransactionVersion

/**
 * Мінімум із дозволу, потрібний для списання. `Pick`, а не власний тип: поле,
 * яке зникне з `Allowance`, має зламати збірку тут, а не приїхати `undefined`
 * у деривацію ATA.
 */
export type ChargeTarget = Pick<
  Allowance,
  'delegate' | 'kind' | 'mint' | 'owner' | 'pda' | 'planPda'
>

/**
 * Знімок дозволу, за яким можна повторити спробу **після** відкликання.
 *
 * Потрібен саме як знімок: скасований дозвіл — це зниклий акаунт, тож після
 * скасування прочитати з мережі вже нічого, а спробу списати треба зробити
 * тими самими акаунтами, якими вона щойно проходила. Інакше «після
 * скасування» перевіряло б іншу транзакцію, ніж «до».
 */
export function chargeTargetFromAllowance(allowance: Allowance): ChargeTarget {
  return {
    delegate: allowance.delegate,
    kind: allowance.kind,
    mint: allowance.mint,
    owner: allowance.owner,
    pda: allowance.pda,
    planPda: allowance.planPda,
  }
}

export class ChargeAmountError extends Error {
  constructor(readonly amount: bigint) {
    super(
      `charge amount must be a positive u64, got ${amount}. Zero is not "nothing happens": the ` +
        'program rejects it, and a negative or oversized value would be encoded as something else',
    )
    this.name = 'ChargeAmountError'
  }
}

export class ChargeDelegateMismatchError extends Error {
  constructor(
    readonly pda: Address,
    readonly delegate: Address,
    readonly merchant: Address,
  ) {
    super(
      `allowance ${pda} names ${delegate} as its delegatee, but merchant-sim signs as ${merchant}; ` +
        'the program would answer Unauthorized after the fee is spent, and the run would look ' +
        'like a protocol rejection when it is our own key that is wrong',
    )
    this.name = 'ChargeDelegateMismatchError'
  }
}

export class ChargeMissingPlanError extends Error {
  constructor(readonly pda: Address) {
    super(
      `subscription ${pda} cannot be charged without its plan address: the program reads the ` +
        'plan for the puller list and the destinations, and there is nothing to guess it from',
    )
    this.name = 'ChargeMissingPlanError'
  }
}

export class ChargePlanNotApplicableError extends Error {
  constructor(
    readonly pda: Address,
    readonly kind: ChargeTarget['kind'],
    readonly planPda: string,
  ) {
    super(
      `allowance ${pda} is ${kind}, not a plan subscription, yet it carries plan ${planPda}; ` +
        'transferFixed and transferRecurring have no plan account, so it would be silently ' +
        'dropped instead of changing the instruction',
    )
    this.name = 'ChargePlanNotApplicableError'
  }
}

export class ChargePlanAddressMismatchError extends Error {
  constructor(
    readonly pda: Address,
    readonly delegate: Address,
    readonly planPda: Address,
  ) {
    super(
      `subscription ${pda} carries plan ${planPda}, but its delegatee field holds ${delegate}. ` +
        'For a subscription those are the same address (the account keeps the plan in ' +
        '`header.delegatee`), so the two disagreeing means one of them came from somewhere else',
    )
    this.name = 'ChargePlanAddressMismatchError'
  }
}

export type ChargeInput = {
  allowance: ChargeTarget
  /**
   * Мерчант: він і підписує списання, і за замовчуванням отримує кошти. Це
   * єдиний приватний ключ у всьому продукті (`config.ts`).
   */
  merchant: TransactionSigner
  /** Базові одиниці міну (u64), не «долари». Перерахунок — справа інтерфейсу. */
  amount: bigint
  /**
   * Токен-програма міну. Задається ззовні, бо це властивість **міну**, а не
   * наша: класичний SPL Token і Token-2022 — різні адреси, і вгадування тут
   * дало б неправильний ATA й відмову не з тієї причини. Витягається з мережі
   * через `resolveTokenProgram`.
   */
  tokenProgram: string
  /**
   * Куди зараховувати. Не задано — ATA мерчанта в цьому міні.
   *
   * ATA **власника** дозволу сюди не передається взагалі: він завжди
   * деривується з `allowance.owner`. Причина не в зручності — overlay для
   * підписки рахує його сам і чуже значення просто ігнорує, тож параметр
   * створював би поле, яке для двох типів дозволу працює, а для третього
   * мовчки зникає.
   */
  receiverAta?: string
  /** Тільки для тестів на іншій адресі програми. За замовчуванням — наша. */
  programAddress?: Address
}

function assertChargeableAmount(amount: bigint): void {
  if (amount <= 0n || amount > U64_MAX) throw new ChargeAmountError(amount)
}

/** ATA власника гаманця в межах міну. Сіди рахує SDK токен-програми, не ми. */
async function associatedToken(
  owner: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<Address> {
  const [address] = await findAssociatedTokenPda({ mint, owner, tokenProgram })
  return address
}

/**
 * Інструкція списання.
 *
 * Перевіряються тільки входи — див. попередження у шапці файлу. Ані `rpc`, ані
 * будь-якого іншого доступу до мережі ця функція не має **за сигнатурою**: так
 * перевірка живого стану не може з'явитися тут випадково.
 */
export async function buildChargeInstruction(input: ChargeInput): Promise<Instruction> {
  const { allowance } = input
  assertChargeableAmount(input.amount)

  const pda = toAddress(allowance.pda)
  const delegator = toAddress(allowance.owner)
  const delegate = toAddress(allowance.delegate)
  const tokenMint = toAddress(allowance.mint)
  const tokenProgram = toAddress(input.tokenProgram)
  const programAddress = input.programAddress ?? PROGRAM_ADDRESS
  const receiverAta =
    input.receiverAta === undefined
      ? await associatedToken(input.merchant.address, tokenMint, tokenProgram)
      : toAddress(input.receiverAta)

  if (allowance.kind === 'subscription') {
    if (allowance.planPda === null) {
      throw new ChargeMissingPlanError(pda)
    }
    const planPda = toAddress(allowance.planPda)
    /*
     * Знахідка `T019`: у підписки `header.delegatee` містить адресу **плану**,
     * а не гаманець мерчанта. Тому тут звіряються саме ці двоє, а не мерчант із
     * `delegate`: у типах різниці немає, і переплутати їх можна мовчки.
     */
    if (planPda !== delegate) {
      throw new ChargePlanAddressMismatchError(pda, delegate, planPda)
    }
    /*
     * Чи має право саме цей ключ тягнути з підписки, вирішує план (`pullers`),
     * і читає його програма. Ми плану не читаємо й права не вгадуємо.
     */
    return getTransferSubscriptionOverlayInstructionAsync({
      amount: input.amount,
      caller: input.merchant,
      delegator,
      planPda,
      programAddress,
      receiverAta,
      subscriptionPda: pda,
      tokenMint,
      tokenProgram,
    })
  }

  if (allowance.planPda !== null) {
    throw new ChargePlanNotApplicableError(pda, allowance.kind, allowance.planPda)
  }
  if (delegate !== input.merchant.address) {
    throw new ChargeDelegateMismatchError(pda, delegate, input.merchant.address)
  }

  const overlay =
    allowance.kind === 'fixed'
      ? getTransferFixedOverlayInstructionAsync
      : getTransferRecurringOverlayInstructionAsync
  return overlay({
    amount: input.amount,
    delegatee: input.merchant,
    delegationPda: pda,
    delegator,
    delegatorAta: await associatedToken(delegator, tokenMint, tokenProgram),
    programAddress,
    receiverAta,
    tokenMint,
    tokenProgram,
  })
}

/** Транзакція живе до цієї висоти блоку. Та сама форма, що й у відкликанні. */
export type ChargeLifetime = {
  blockhash: Blockhash
  lastValidBlockHeight: bigint
}

export type ChargeTransactionInput = ChargeInput & { lifetime: ChargeLifetime }

export type ChargeTransactionMessage = Parameters<typeof compileTransaction>[0] &
  TransactionMessageWithFeePayer &
  TransactionMessageWithBlockhashLifetime

/**
 * Повідомлення транзакції: рівно одна інструкція, платник комісії — мерчант.
 *
 * Комісію платить саме мерчант, і це не деталь: `FR-016` каже, що списання
 * ініціює мерчант **зі свого боку**, без участі користувача. Транзакція, за яку
 * платить власник дозволу, означала б, що без його гаманця списання не
 * відбувається, — тобто рівно те, чого продукт не стверджує.
 */
export function buildChargeTransactionMessage(
  instruction: Instruction,
  input: Pick<ChargeTransactionInput, 'lifetime' | 'merchant'>,
): ChargeTransactionMessage {
  return pipe(
    createTransactionMessage({ version: CHARGE_TRANSACTION_VERSION }),
    (message) => setTransactionMessageFeePayerSigner(input.merchant, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(input.lifetime, message),
    (message) => appendTransactionMessageInstruction(instruction, message),
  )
}

export type ChargeTransaction = {
  message: ChargeTransactionMessage
  /** Підписана мерчантом транзакція. */
  transaction: Transaction
  /** Підпис відомий **до** надсилання — саме за ним потім питається мережа. */
  signature: Signature
  wireTransactionBase64: Base64EncodedWireTransaction
}

/**
 * Зібрана й підписана транзакція списання.
 *
 * Підпис ставиться тут, а не в браузері, і це єдине місце в продукті, де так
 * буває: `merchant-sim` — тестовий мерчант, і ключ у нього devnet-ний
 * (`keypair.ts`, `config.ts`). Гаманця користувача тут немає й не потрібно —
 * у цьому й суть `FR-016`.
 */
export async function buildChargeTransaction(
  input: ChargeTransactionInput,
): Promise<ChargeTransaction> {
  const instruction = await buildChargeInstruction(input)
  const message = buildChargeTransactionMessage(instruction, input)
  const transaction = await signTransactionMessageWithSigners(message)
  return {
    message,
    transaction,
    signature: getSignatureFromTransaction(transaction),
    wireTransactionBase64: getBase64EncodedWireTransaction(transaction),
  }
}

/**
 * Код помилки програми з відповіді мережі.
 *
 * Розбирається структурно, а не за типом `TransactionError`: у ньому десятки
 * варіантів, а нас цікавить рівно один — `InstructionError: [i, { Custom: n }]`.
 * `null` означає «відмова не від програми» (браковані підписи, вичерпані
 * одиниці обчислення) — і це не те саме, що «невідома причина»: перекладом
 * кодів у названі категорії займається `T040`, і вигадувати категорію тут
 * означало б завести другий, розбіжний перелік.
 */
export function programErrorCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('InstructionError' in error)) return null
  const pair = (error as { InstructionError: unknown }).InstructionError
  if (!Array.isArray(pair) || pair.length !== 2) return null
  const detail: unknown = pair[1]
  if (typeof detail !== 'object' || detail === null || !('Custom' in detail)) return null
  const code: unknown = (detail as { Custom: unknown }).Custom
  return typeof code === 'number' ? code : null
}

type SignatureStatus = {
  err: unknown
  slot: Slot
}

/**
 * Рівно та частина RPC, якою користується спроба списання. Вужчий тип, ніж
 * `Rpc<SolanaRpcApi>`, з тієї самої причини, що й у `packages/chain/read.ts`:
 * методи kit перевантажені за кодуванням, і підробити їх у тесті означало б
 * підробити всі перевантаження. Справжній клієнт відповідає цьому типу
 * структурно — це перевіряє `charge.test.ts`.
 */
export type ChargeRpc = {
  getLatestBlockhash(config?: { commitment?: Commitment }): {
    send(): Promise<{
      value: { blockhash: Blockhash; lastValidBlockHeight: bigint }
    }>
  }
  sendTransaction(
    wireTransaction: Base64EncodedWireTransaction,
    config: {
      encoding: 'base64'
      skipPreflight?: boolean
      preflightCommitment?: Commitment
    },
  ): { send(): Promise<Signature> }
  getSignatureStatuses(
    signatures: readonly Signature[],
    config?: { searchTransactionHistory?: boolean },
  ): {
    send(): Promise<{ value: readonly (SignatureStatus | null)[] }>
  }
}

export type MintOwnerRpc = {
  getAccountInfo(
    address: Address,
    config: { encoding: 'base64'; commitment?: Commitment },
  ): { send(): Promise<{ value: { owner: Address } | null }> }
}

export class ChargeMintNotFoundError extends Error {
  constructor(readonly mint: Address) {
    super(
      `mint ${mint} does not exist on this cluster. The token program cannot be resolved from a ` +
        'missing account, and guessing it would derive the wrong token accounts',
    )
    this.name = 'ChargeMintNotFoundError'
  }
}

/**
 * Токен-програма міну — власник самого акаунта міну.
 *
 * Читається з мережі, а не береться константою: класичний SPL Token і
 * Token-2022 однаково законні, а від вибору залежить деривація ATA. Перелік
 * «дозволених» токен-програм тут теж не заводиться — судить програма
 * (`InvalidTokenProgram`), і другий перелік на нашому боці розійшовся б із її
 * власним.
 */
export async function resolveTokenProgram(rpc: MintOwnerRpc, mint: Address): Promise<Address> {
  const { value } = await rpc.getAccountInfo(mint, { encoding: 'base64' }).send()
  if (value === null) throw new ChargeMintNotFoundError(mint)
  return value.owner
}

/**
 * Чим скінчилася спроба.
 *
 * `unknown` — окремий результат, а не «невдача»: транзакцію надіслано, але
 * мережа про підпис ще не сказала нічого. Записати це успіхом чи відмовою
 * означало б підмішати в `SC-001` здогад. Той самий підхід, що й `unconfirmed`
 * у потоці скасування (`T026`).
 */
export type ChargeVerdict =
  | { outcome: 'charged'; signature: Signature; slot: bigint }
  | {
      outcome: 'rejected'
      signature: Signature
      slot: bigint
      /** Помилка так, як її повернула мережа. */
      error: unknown
      /** Код помилки програми, якщо відмова саме від неї. */
      programErrorCode: number | null
    }
  | { outcome: 'unknown'; signature: Signature; detail: string }
  /** Спроби не було: транзакція нікуди не поїхала. У `SC-001` не рахується. */
  | { outcome: 'no-attempt'; signature: Signature | null; detail: string }

export type ChargeAttemptOptions = {
  commitment?: Commitment
  /**
   * Надсилати без передпольоту (`simulateTransaction` на вузлі).
   *
   * За замовчуванням `true`, і це не оптимізація. З передпольотом приречена
   * транзакція **не потрапляє в мережу взагалі**: вузол відмовляє її на своєму
   * боці, підпису на ланцюжку не існує, і показати «ось спроба списання, ось
   * відмова протоколу» нічим — а саме посилання на цю транзакцію M1 обіцяє
   * показати. Ціна — комісія за приречену транзакцію; на devnet це прийнятно.
   */
  skipPreflight?: boolean
  /** Скільки разів питати мережу про підпис. */
  pollAttempts?: number
  pollIntervalMs?: number
  /** Підмінна пауза — щоб тести не чекали по-справжньому. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_POLL_ATTEMPTS = 20
const DEFAULT_POLL_INTERVAL_MS = 1_500

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function detailOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Одна спроба списання: зібрати → підписати → надіслати → **спитати мережу**.
 *
 * Вердикт дає стан мережі, а не виняток від `sendTransaction`. Помилка
 * надсилання — це наша місцева подія: вузол міг відхилити запит, а міг уже
 * передати транзакцію далі й лише потім обірвати з'єднання. Тому після будь-якої
 * помилки надсилання підпис усе одно перевіряється в мережі, і лише мовчання
 * мережі перетворює її на `no-attempt`.
 */
export async function attemptCharge(
  rpc: ChargeRpc,
  input: ChargeInput,
  options: ChargeAttemptOptions = {},
): Promise<ChargeVerdict> {
  const commitment = options.commitment ?? 'confirmed'
  const sleep = options.sleep ?? realSleep
  const pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  let charge: ChargeTransaction
  try {
    const { value } = await rpc.getLatestBlockhash({ commitment }).send()
    charge = await buildChargeTransaction({
      ...input,
      lifetime: {
        blockhash: toBlockhash(value.blockhash),
        lastValidBlockHeight: value.lastValidBlockHeight,
      },
    })
  } catch (error) {
    // Ще нічого не надіслано — підпису не існує навіть у нас.
    return { outcome: 'no-attempt', signature: null, detail: detailOf(error) }
  }

  let sendError: unknown = null
  try {
    await rpc
      .sendTransaction(charge.wireTransactionBase64, {
        encoding: 'base64',
        preflightCommitment: commitment,
        skipPreflight: options.skipPreflight ?? true,
      })
      .send()
  } catch (error) {
    sendError = error
  }

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    if (attempt > 0) await sleep(pollIntervalMs)
    let status: SignatureStatus | null
    try {
      const { value } = await rpc
        .getSignatureStatuses([charge.signature], { searchTransactionHistory: true })
        .send()
      status = value[0] ?? null
    } catch {
      // Вузол не відповів на питання про статус — це ще не відповідь про статус.
      continue
    }
    if (status === null) continue
    if (status.err === null || status.err === undefined) {
      return { outcome: 'charged', signature: charge.signature, slot: BigInt(status.slot) }
    }
    return {
      outcome: 'rejected',
      signature: charge.signature,
      slot: BigInt(status.slot),
      error: status.err,
      programErrorCode: programErrorCodeOf(status.err),
    }
  }

  if (sendError !== null) {
    return {
      outcome: 'no-attempt',
      signature: charge.signature,
      detail: `the node refused the transaction and the network never saw it — ${detailOf(sendError)}`,
    }
  }
  return {
    outcome: 'unknown',
    signature: charge.signature,
    detail:
      `sent, but the network reported no status for it after ${pollAttempts} attempts. ` +
      'This is neither a charge nor a rejection: check the signature in an explorer',
  }
}

/** Рядок вердикту для CLI. Каже, що саме сталося, і ніколи не більше. */
export function describeVerdict(verdict: ChargeVerdict): string {
  switch (verdict.outcome) {
    case 'charged':
      return `CHARGED       slot ${verdict.slot}\nsignature:    ${verdict.signature}`
    case 'rejected': {
      const code =
        verdict.programErrorCode === null
          ? 'not a program error code (the runtime refused it, not the program)'
          : `program error ${verdict.programErrorCode}`
      return [
        `REJECTED      slot ${verdict.slot}`,
        `signature:    ${verdict.signature}`,
        `reason:       ${code}`,
        `raw error:    ${JSON.stringify(verdict.error)}`,
      ].join('\n')
    }
    case 'unknown':
      return `UNKNOWN       ${verdict.detail}\nsignature:    ${verdict.signature}`
    default:
      return `NO ATTEMPT    ${verdict.detail}${
        verdict.signature === null ? '' : `\nsignature:    ${verdict.signature}`
      }`
  }
}

/**
 * Поля мішені, названі руками. Усі необов'язкові: поки акаунт існує, вони лише
 * звіряються з мережею, і потрібними стають рівно тоді, коли акаунта вже немає.
 */
export type ChargeTargetFields = {
  kind?: string
  owner?: string
  mint?: string
  delegate?: string
  plan?: string
}

export class ChargeTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChargeTargetError'
  }
}

function requiredField(fields: ChargeTargetFields, name: keyof ChargeTargetFields, why: string) {
  const value = fields[name]
  if (value === undefined || value === '') {
    throw new ChargeTargetError(`--${name} is required: ${why}`)
  }
  return value
}

function toKind(raw: string): ChargeTarget['kind'] {
  const kind = ALLOWANCE_KINDS.find((candidate) => candidate === raw)
  if (kind === undefined) {
    throw new ChargeTargetError(`--kind must be one of ${ALLOWANCE_KINDS.join(', ')}, got "${raw}"`)
  }
  return kind
}

/**
 * Мішень зі знімка, названого руками, — шлях **після** відкликання.
 *
 * Нічого не вгадується й не має значення за замовчуванням: скасований дозвіл це
 * зниклий акаунт, тож кожне поле доводиться назвати рівно тим, яким воно було
 * до скасування. Підставлене за нас значення означало б транзакцію не тими
 * акаунтами й відмову не з тієї причини — тобто зелений `SC-001` ні про що.
 */
export function chargeTargetFromFields(pda: string, fields: ChargeTargetFields): ChargeTarget {
  const kind = toKind(requiredField(fields, 'kind', 'the closed account no longer says its type'))
  const owner = requiredField(fields, 'owner', 'the wallet the allowance was granted from')
  const mint = requiredField(fields, 'mint', 'the settlement mint of the allowance')
  if (kind === 'subscription') {
    const planPda = requiredField(fields, 'plan', 'a subscription is charged through its plan')
    // Для підписки `header.delegatee` і є адресою плану — знахідка `T019`.
    return { delegate: planPda, kind, mint, owner, pda, planPda }
  }
  const delegate = requiredField(fields, 'delegate', 'the merchant wallet the allowance names')
  return { delegate, kind, mint, owner, pda, planPda: null }
}

function assertFieldAgrees(
  fields: ChargeTargetFields,
  name: keyof ChargeTargetFields,
  actual: string | null,
): void {
  const value = fields[name]
  if (value === undefined) return
  if (value !== actual) {
    throw new ChargeTargetError(
      `--${name} says "${value}", but the network says "${actual ?? 'none'}" for this allowance. ` +
        'Network state wins over anything we were told, so fix the flag or drop it',
    )
  }
}

/**
 * Мішень списання: з мережі, поки акаунт є, і з названих полів, коли його вже
 * немає.
 *
 * Названі поля при живому акаунті **не перевизначають** прочитане, а лише
 * звіряються з ним: перевизначення означало б, що списання можна навести на
 * акаунти, яких мережа за цією адресою не показує.
 */
export function chargeTarget(
  allowance: Allowance | null,
  pda: string,
  fields: ChargeTargetFields,
): ChargeTarget {
  if (allowance === null) return chargeTargetFromFields(pda, fields)
  assertFieldAgrees(fields, 'kind', allowance.kind)
  assertFieldAgrees(fields, 'owner', allowance.owner)
  assertFieldAgrees(fields, 'mint', allowance.mint)
  assertFieldAgrees(fields, 'delegate', allowance.delegate)
  assertFieldAgrees(fields, 'plan', allowance.planPda)
  return chargeTargetFromAllowance(allowance)
}
