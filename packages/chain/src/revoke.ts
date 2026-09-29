import type { Allowance } from '@cancelchain/shared'
import type {
  Address,
  Base64EncodedWireTransaction,
  Blockhash,
  Instruction,
  Transaction,
  TransactionMessageWithBlockhashLifetime,
  TransactionMessageWithFeePayer,
  TransactionVersion,
} from '@solana/kit'
import {
  appendTransactionMessageInstruction,
  assertIsBlockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import {
  getCancelSubscriptionOverlayInstructionAsync,
  getRevokeDelegationOverlayInstruction,
  getRevokeSubscriptionOverlayInstruction,
} from '@solana/subscriptions'
import { PROGRAM_ADDRESS, toAddress } from './client.js'

/**
 * Транзакція відкликання — `FR-003`, `FR-019`.
 *
 * ⚠️ **Відкликання — це `revokeDelegation`, і тільки воно.** У програми є три
 * інструкції, які на слух звучать як «скасувати», і дві з них тут були б
 * помилкою на чужих грошах:
 *
 * | Інструкція | Що робить | Чому не тут |
 * |---|---|---|
 * | `revokeDelegation` (3) | **закриває акаунт дозволу** | це і є `FR-019` |
 * | `cancelSubscription` (12) | пише кінець оплаченого періоду в `expiresAtTs` | до цієї дати списання ще проходять — це `FR-028`, задача `T059` |
 * | `cancelSubscriptionNow` (17) | закриває підписку негайно | **вимагає підпису мерчанта** (`merchant: TransactionSigner`), тобто не односторонній |
 *
 * `FR-019` вимагає «негайно й безумовно», а `SC-001` міряє нуль успішних
 * списань **після** скасування. Обидві вимоги виконує лише закриття акаунта:
 * після нього наступна спроба списання впирається у відсутній акаунт, і
 * відмову дає протокол, а не наш інтерфейс.
 *
 * Одна інструкція на всі три типи дозволу — теж не спрощення, а те, що є в
 * SDK: `getRevokeSubscriptionOverlayInstruction` викликає той самий
 * `getRevokeDelegationInstruction`, лише додає план причіпним акаунтом.
 *
 * ⚠️ **Correction (T037a, 2026-09-29): the table above holds for `fixed` and
 * `recurring` only.** For a plan subscription the program refuses the
 * subscriber's `revokeDelegation` with `Custom 510` (`SubscriptionNotCancelled`)
 * until `expiresAtTs` is set **and** has passed (`revoke_delegation.rs`,
 * subscriber branch). `expiresAtTs` is written only by `cancelSubscription`, and
 * it is the end of the current billing period. So a subscription is cancelled in
 * two separate actions, each one signature:
 *
 * 1. `cancelSubscription` — the network refuses every pull from `expiresAtTs` on
 *    (`transfer_subscription.rs`: `SubscriptionCancelled`, 508). Until then the
 *    merchant may still pull what is left of the current period's cap;
 * 2. `revokeDelegation` — after `expiresAtTs`, closes the account and returns the
 *    rent. It changes nothing about charges any more; it only tidies up.
 *
 * Doing both in one transaction does not work either (verified on devnet
 * 2026-09-28: `[1, Custom 510]`), because the date is in the future at the
 * moment it is written. `revokeActionFor` says which of the two is due.
 */

/**
 * Мінімум із картки, потрібний для відкликання. Саме `Pick`, а не власний тип:
 * поле, яке зникне з `Allowance`, має зламати збірку тут, а не тихо приїхати
 * `undefined` у деривацію акаунтів.
 */
export type RevokeTarget = Pick<Allowance, 'kind' | 'owner' | 'pda' | 'planPda' | 'endsAt'>

export type RevokeInput = {
  allowance: RevokeTarget
  /** Гаманець, що підписує. Мусить збігатися з `allowance.owner`. */
  authority: string
  /**
   * The moment a subscription's `endsAt` is judged against. Defaults to now. Only
   * subscriptions read it: `fixed` and `recurring` close at any time.
   */
  now?: Date
  /**
   * Куди повертається рента закритого акаунта. Не задано — власнику дозволу.
   *
   * `undefined` тут навмисно не перетворюється на адресу: причіпного акаунта
   * просто немає, і його відсутність перевіряє round-trip. Підставити сюди
   * `ZERO_ADDRESS` означало б відправити ренту в нікуди — рівно та помилка, від
   * якої стереже правило про незаповнені поля.
   */
  receiver?: string
  /** Тільки для тестів на іншій адресі програми. За замовчуванням — наша. */
  programAddress?: Address
}

/** Транзакція живе до цієї висоти блоку — далі гаманцеві нема що надсилати. */
export type RevokeLifetime = {
  blockhash: Blockhash
  lastValidBlockHeight: bigint
}

/**
 * Рядок у брендований `Blockhash` — із перевіркою, а не приведенням типу.
 * Той самий підхід, що й `toAddress`: `as Blockhash` пропустив би в транзакцію
 * будь-який рядок, і невалідний хеш упав би аж у гаманці, тобто після кліку.
 */
export function toBlockhash(value: string): Blockhash {
  assertIsBlockhash(value)
  return value
}

export type RevokeTransactionInput = RevokeInput & { lifetime: RevokeLifetime }

/**
 * Версія транзакції. `0`, а не `legacy`: обидві мережа приймає, але legacy не
 * має таблиць адрес, і перший же наступний білдер, якому вони знадобляться,
 * мусив би змінити формат уже після того, як користувач звик до нього.
 */
export const REVOKE_TRANSACTION_VERSION = 0 satisfies TransactionVersion

export class RevokeAuthorityMismatchError extends Error {
  constructor(
    readonly pda: Address,
    readonly owner: Address,
    readonly authority: Address,
  ) {
    super(
      `allowance ${pda} belongs to ${owner}, but ${authority} is signing; the program would ` +
        'reject this as unauthorised, and building it would put a foreign wallet on the screen',
    )
    this.name = 'RevokeAuthorityMismatchError'
  }
}

export class RevokeMissingPlanError extends Error {
  constructor(readonly pda: Address) {
    super(
      `subscription ${pda} cannot be revoked without its plan address: the program reads the ` +
        'plan as a trailing account, and omitting it builds a differently shaped instruction',
    )
    this.name = 'RevokeMissingPlanError'
  }
}

export class RevokePlanNotApplicableError extends Error {
  constructor(
    readonly pda: Address,
    readonly kind: RevokeTarget['kind'],
    readonly planPda: string,
  ) {
    super(
      `allowance ${pda} is ${kind}, not a plan subscription, yet it carries plan ${planPda}; ` +
        'the plan would be silently dropped from the instruction, so the state is refused instead',
    )
    this.name = 'RevokePlanNotApplicableError'
  }
}

/**
 * A plan subscription whose account the program will not close yet: either it
 * was never cancelled (`endsAt === null`) or its paid period is still running.
 * The program answers both with `Custom 510` — after the wallet has signed.
 */
export class RevokeSubscriptionNotEndedError extends Error {
  constructor(
    readonly pda: Address,
    readonly endsAt: Date | null,
  ) {
    super(
      endsAt === null
        ? `subscription ${pda} has not been cancelled, and the program closes a subscription ` +
            'only after its cancellation date; cancel it first (cancelSubscription)'
        : `subscription ${pda} is cancelled but runs until ${endsAt.toISOString()}; the program ` +
            'closes its account only after that moment',
    )
    this.name = 'RevokeSubscriptionNotEndedError'
  }
}

export class RevokeNotASubscriptionError extends Error {
  constructor(
    readonly pda: Address,
    readonly kind: RevokeTarget['kind'],
  ) {
    super(
      `allowance ${pda} is ${kind}; cancelSubscription exists only for plan subscriptions, and ` +
        'a delegation is closed with revokeDelegation at any time',
    )
    this.name = 'RevokeNotASubscriptionError'
  }
}

export class RevokeAlreadyCancelledError extends Error {
  constructor(
    readonly pda: Address,
    readonly endsAt: Date,
  ) {
    super(
      `subscription ${pda} is already cancelled until ${endsAt.toISOString()}; the program ` +
        'would refuse a second cancellation (SubscriptionAlreadyCancelled)',
    )
    this.name = 'RevokeAlreadyCancelledError'
  }
}

/**
 * What cancelling this permission means right now.
 *
 * - `close` — `revokeDelegation`: the account is closed and nothing can be charged
 *   from the moment it lands. Always so for `fixed` / `recurring`; for a plan
 *   subscription only once its `endsAt` has passed, when it merely tidies up.
 * - `cancel-subscription` — `cancelSubscription`: the network sets the end of the
 *   current period and refuses every charge from then on.
 * - `wait` — a cancelled subscription still inside its paid period. There is
 *   nothing to sign until `until`.
 *
 * The browser clock decides between `wait` and `close`, the chain clock decides
 * for the program. A few seconds of skew at the boundary end in a named 510,
 * never in a charge: the charge boundary is fixed on chain already.
 */
export type RevokeAction =
  | { kind: 'close' }
  | { kind: 'cancel-subscription' }
  | { kind: 'wait'; until: Date }

export function revokeActionFor(
  allowance: Pick<Allowance, 'kind' | 'endsAt'>,
  now: Date = new Date(),
): RevokeAction {
  if (allowance.kind !== 'subscription') return { kind: 'close' }
  if (allowance.endsAt === null) return { kind: 'cancel-subscription' }
  const until = new Date(allowance.endsAt)
  return until.getTime() <= now.getTime() ? { kind: 'close' } : { kind: 'wait', until }
}

/**
 * What the merchant can still do after `cancelSubscription` — the numbers the
 * confirmation shows before the signature (`FR-019` for subscriptions).
 *
 * This mirrors `cancel_subscription.rs`: `expiresAtTs = periodStart + (⌊elapsed /
 * period⌋ + 1) · period`, i.e. the end of the period the chain clock is in, which
 * may lie past the period the account last recorded (the program rolls the
 * period only on a pull). It is an upper bound, hence the name: the program cuts
 * it to one second past the plan's own end, and to *now* when the plan is closed
 * or re-created with other terms. After the transaction the real date is read
 * back from the account; this one is only the promise made before signing.
 *
 * `chargedThisPeriod` is what the account says was pulled in the current period,
 * and zero when the recorded period is already over — the program resets it on
 * the next pull, so an old figure would be counted against a period it was not
 * taken in.
 */
export type SubscriptionCancelWindow = {
  endsNoLaterThan: Date
  currentPeriodStartedAt: Date
  chargedThisPeriod: bigint
  /** The most the merchant can still pull before `endsNoLaterThan`. */
  stillChargeable: bigint
}

export function subscriptionCancelWindow(
  subscription: {
    periodSeconds: number
    periodStartedAt: Date
    cap: bigint
    spentInPeriod: bigint
  },
  now: Date = new Date(),
): SubscriptionCancelWindow {
  const period = subscription.periodSeconds
  if (!Number.isInteger(period) || period <= 0) {
    throw new RangeError(`a subscription period must be a positive whole number of seconds`)
  }
  const start = Math.floor(subscription.periodStartedAt.getTime() / 1000)
  const current = Math.floor(now.getTime() / 1000)
  const periodsElapsed = Math.floor(Math.max(0, current - start) / period)
  const currentStart = start + periodsElapsed * period
  const charged = periodsElapsed === 0 ? subscription.spentInPeriod : 0n
  const left = subscription.cap - charged
  return {
    endsNoLaterThan: new Date((currentStart + period) * 1000),
    currentPeriodStartedAt: new Date(currentStart * 1000),
    chargedThisPeriod: charged,
    stillChargeable: left > 0n ? left : 0n,
  }
}

/**
 * Інструкція відкликання.
 *
 * Акаунти в неї кладе SDK, і саме тому тут перевіряються **входи**: програма
 * відповість `Unauthorized` або `InvalidPlanPda` уже після підпису, тобто
 * після того, як людина віддала транзакцію гаманцю. Назвати розбіжність
 * заздалегідь дешевше на один підпис.
 */
export function buildRevokeInstruction(input: RevokeInput): Instruction {
  const { allowance } = input
  const pda = toAddress(allowance.pda)
  const owner = toAddress(allowance.owner)
  const authority = toAddress(input.authority)
  if (authority !== owner) {
    throw new RevokeAuthorityMismatchError(pda, owner, authority)
  }

  const receiver = input.receiver === undefined ? undefined : toAddress(input.receiver)
  const programAddress = input.programAddress ?? PROGRAM_ADDRESS
  /**
   * Підписант-заглушка. Кодама вимагає `TransactionSigner` не заради підпису, а
   * заради ролі акаунта: саме він робить `authority` writable-signer'ом. Підпис
   * ставить гаманець у браузері — сервер ключа не має й мати не буде.
   */
  const signer = createNoopSigner(authority)

  if (allowance.kind === 'subscription') {
    if (allowance.planPda === null) {
      throw new RevokeMissingPlanError(pda)
    }
    const action = revokeActionFor(allowance, input.now)
    if (action.kind !== 'close') {
      throw new RevokeSubscriptionNotEndedError(pda, action.kind === 'wait' ? action.until : null)
    }
    return getRevokeSubscriptionOverlayInstruction({
      authority: signer,
      planPda: toAddress(allowance.planPda),
      programAddress,
      receiver,
      subscriptionPda: pda,
    })
  }

  if (allowance.planPda !== null) {
    throw new RevokePlanNotApplicableError(pda, allowance.kind, allowance.planPda)
  }
  return getRevokeDelegationOverlayInstruction({
    authority: signer,
    delegationAccount: pda,
    programAddress,
    receiver,
  })
}

export type RevokeTransactionMessage = Parameters<typeof compileTransaction>[0] &
  TransactionMessageWithFeePayer &
  TransactionMessageWithBlockhashLifetime

/**
 * Повідомлення транзакції: рівно одна інструкція, платник комісії — той самий
 * гаманець, що відкликає.
 *
 * Друга інструкція сюди не додається ніколи. `SC-002` міряє **один** підпис, а
 * будь-який попутний пасажир у тій самій транзакції означав би, що підпис під
 * скасуванням підтверджує ще щось, чого на екрані не було.
 */
export function buildRevokeTransactionMessage(
  input: RevokeTransactionInput,
): RevokeTransactionMessage {
  return singleInstructionMessage(buildRevokeInstruction(input), input)
}

/** One instruction, the signing wallet pays — shared by closing and by `cancelSubscription`. */
function singleInstructionMessage(
  instruction: Instruction,
  input: Pick<RevokeTransactionInput, 'authority' | 'lifetime'>,
): RevokeTransactionMessage {
  return pipe(
    createTransactionMessage({ version: REVOKE_TRANSACTION_VERSION }),
    (message) => setTransactionMessageFeePayer(toAddress(input.authority), message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(input.lifetime, message),
    (message) => appendTransactionMessageInstruction(instruction, message),
  )
}

export type RevokeTransaction = {
  message: RevokeTransactionMessage
  /** Скомпільована транзакція з порожнім місцем під підпис гаманця. */
  transaction: Transaction
  /** Байти для `solana:signAndSendTransaction` гаманця. */
  wireTransaction: Uint8Array
  /** Те саме в base64 — для `simulateTransaction` і для логів. */
  wireTransactionBase64: Base64EncodedWireTransaction
}

/**
 * Готова до підпису транзакція.
 *
 * `signatures` тут містить адресу гаманця з `null` замість підпису — це не
 * недороблена транзакція, а рівно те, що приймає wallet-standard: місце під
 * підпис зарезервоване, розмір кінцевий, і гаманець не переставляє акаунти.
 */
export function buildRevokeTransaction(input: RevokeTransactionInput): RevokeTransaction {
  return compiled(buildRevokeTransactionMessage(input))
}

function compiled(message: RevokeTransactionMessage): RevokeTransaction {
  const transaction = compileTransaction(message)
  return {
    message,
    transaction,
    wireTransaction: getTransactionEncoder().encode(transaction) as Uint8Array,
    wireTransactionBase64: getBase64EncodedWireTransaction(transaction),
  }
}

export type CancelSubscriptionInput = {
  allowance: Pick<Allowance, 'kind' | 'owner' | 'pda' | 'planPda' | 'endsAt'>
  /** The signing wallet. Must be `allowance.owner` — the program checks the delegator. */
  authority: string
  /** Tests on another program address only. Defaults to ours. */
  programAddress?: Address
}

/**
 * `cancelSubscription` (12) — the subscriber's side of `FR-019` for a plan
 * subscription.
 *
 * It carries no arguments: the program computes the date itself from the chain
 * clock and the account, so there is no field a caller could leave out and have
 * encoded as zero. The event authority is derived by the SDK (async, a PDA).
 */
export async function buildCancelSubscriptionInstruction(
  input: CancelSubscriptionInput,
): Promise<Instruction> {
  const { allowance } = input
  const pda = toAddress(allowance.pda)
  if (allowance.kind !== 'subscription') {
    throw new RevokeNotASubscriptionError(pda, allowance.kind)
  }
  const owner = toAddress(allowance.owner)
  const authority = toAddress(input.authority)
  if (authority !== owner) {
    throw new RevokeAuthorityMismatchError(pda, owner, authority)
  }
  if (allowance.planPda === null) {
    throw new RevokeMissingPlanError(pda)
  }
  if (allowance.endsAt !== null) {
    throw new RevokeAlreadyCancelledError(pda, new Date(allowance.endsAt))
  }
  return getCancelSubscriptionOverlayInstructionAsync({
    planPda: toAddress(allowance.planPda),
    programAddress: input.programAddress ?? PROGRAM_ADDRESS,
    // A role, not a signature: the wallet signs in the browser (see `buildRevokeInstruction`).
    subscriber: createNoopSigner(authority),
    subscriptionPda: pda,
  })
}

/** Same shape as the closing transaction: one instruction, one signature slot, the wallet pays. */
export async function buildCancelSubscriptionTransaction(
  input: CancelSubscriptionInput & { lifetime: RevokeLifetime },
): Promise<RevokeTransaction> {
  return compiled(singleInstructionMessage(await buildCancelSubscriptionInstruction(input), input))
}
