import { U64_MAX } from '@cancelchain/shared'
import type {
  Address,
  Base64EncodedWireTransaction,
  Instruction,
  Transaction,
  TransactionMessageWithBlockhashLifetime,
  TransactionMessageWithFeePayer,
  TransactionSigner,
} from '@solana/kit'
import {
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import {
  getCreateFixedDelegationOverlayInstructionAsync,
  getCreateRecurringDelegationOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  UNKNOWN_INIT_ID,
} from '@solana/subscriptions'
import { PROGRAM_ADDRESS, toAddress } from './client.js'
import { findDelegation, findSubscriptionAuthority, type Pda } from './pda.js'
import type { RevokeLifetime } from './revoke.js'

/**
 * Видача дозволу з явно названими межами — `FR-007`.
 *
 * Чотири межі зі спеки лягають на дві різні інструкції, і межі в них не збігаються:
 *
 * | Межа `FR-007` | `fixed` | `recurring` |
 * |---|---|---|
 * | отримувач | `delegatee` | `delegatee` |
 * | стеля суми | `amount` — разова | `amountPerPeriod` — скидається щоперіоду |
 * | довжина періоду | **не існує** | `periodLengthS` |
 * | дата закінчення | `expiryTs` | `expiryTs` |
 *
 * Тому вхід тут — розмічене об'єднання, а не один об'єкт із необов'язковими
 * полями: «період» у фіксованого дозволу не «не заданий», його немає в
 * структурі акаунта взагалі, і поле, яке в одному випадку працює, а в іншому
 * мовчки зникає, — це рівно та помилка, від якої стереже правило про
 * round-trip.
 *
 * Підписки за планом тут немає навмисно: вона створюється `subscribe` проти
 * чужого плану, і межі їй диктує план, а не той, хто підписується. Це інша
 * інструкція й інша задача (`T036`).
 */

/** Нуль у полі часу — «не задано», а не 1970 рік. Дзеркало до `timestampFromChain`. */
const NO_TIMESTAMP = 0n

/**
 * ISO 8601 → секунди мережі. `null` → `0`.
 *
 * Зворотне до `timestampFromChain` з `decode.ts`, і round-trip між ними
 * перевіряється тестом: розбіжність тут означала б, що дозвіл із датою, яку
 * показали людині, ляже в мережу з іншою.
 */
export function timestampToChain(iso: string | null): bigint {
  if (iso === null) return NO_TIMESTAMP
  const millis = Date.parse(iso)
  if (Number.isNaN(millis)) {
    throw new RangeError(`expected an ISO 8601 timestamp, got ${JSON.stringify(iso)}`)
  }
  if (millis < 0) throw new RangeError(`timestamp predates the epoch: ${iso}`)
  const seconds = BigInt(Math.floor(millis / 1000))
  if (seconds === NO_TIMESTAMP) {
    throw new RangeError(
      `timestamp ${iso} lands on the epoch, which the program reads as "no timestamp"`,
    )
  }
  return seconds
}

export type GrantBounds =
  | {
      kind: 'fixed'
      /** Отримувач: гаманець мерчанта, якому дозволено тягнути. */
      delegatee: string
      /** Стеля в базових одиницях міну. Для `fixed` — разова, не поновлювана. */
      capAmount: bigint
      /** `null` — без дати закінчення. */
      expiresAt: string | null
    }
  | {
      kind: 'recurring'
      delegatee: string
      /** Стеля **на період**. Скидається з початком кожного нового періоду. */
      capAmount: bigint
      periodSeconds: number
      /**
       * Коли починається перший період. `null` — «щойно транзакція сяде»
       * (програма читає це як `startTs = 0`), і тоді дата закінчення
       * обов'язкова — цього вимагає сама програма.
       */
      startsAt: string | null
      expiresAt: string | null
    }

/**
 * Ідентифікатор ініціалізації авторитету підписок — сторож несвіжості.
 *
 * Програма приймає авторитет лише тоді, коли його збережений `initId` збігається
 * з переданим. Це захищає від того, що між показом меж на екрані й підписом
 * авторитет закрили й створили наново: без цієї перевірки дозвіл ліг би на
 * інший авторитет, ніж бачила людина.
 *
 * `'same-transaction'` — окремий випадок, коли `initSubscriptionAuthority` їде в
 * тій самій транзакції й `initId` ще не існує. Тоді SDK кладе сентинел
 * `UNKNOWN_INIT_ID`, і **перевірка вимикається**: програма приймає авторитет,
 * ініціалізований у поточному слоті. Тому це не «зручне значення за
 * замовчуванням», а свідома відмова від сторожа, і назвати її доводиться словом.
 */
export type AuthorityInitId = bigint | 'same-transaction'

export type GrantInput = {
  bounds: GrantBounds
  /** Власник гаманця: він видає дозвіл і він же його підписує. */
  delegator: TransactionSigner
  tokenMint: string
  /**
   * Те, що дозволяє одній парі «гаманець ↔ мерчант» мати кілька незалежних
   * дозволів. Значення за замовчуванням немає: збіг із наявним дозволом дає
   * `DelegationAlreadyExists`, і мовчазний нуль зробив би другу видачу
   * невідтворюваною помилкою.
   */
  nonce: bigint
  authorityInitId: AuthorityInitId
  /** Хто платить ренту за акаунт. Не задано — сам `delegator`. */
  payer?: TransactionSigner
  /** Момент, відносно якого перевіряються дати. За замовчуванням — зараз. */
  now?: Date
  programAddress?: Address
}

export class GrantAmountError extends Error {
  constructor(readonly capAmount: bigint) {
    super(
      `the ceiling must be a positive u64, got ${capAmount}. Zero is not "no limit": the program ` +
        'rejects a zero-amount delegation outright (FixedDelegationAmountZero / ' +
        'RecurringDelegationAmountZero)',
    )
    this.name = 'GrantAmountError'
  }
}

export class GrantPeriodError extends Error {
  constructor(readonly periodSeconds: number) {
    super(
      `the period must be a positive whole number of seconds, got ${periodSeconds}; the program ` +
        'stores it as u64 and answers InvalidPeriodLength for anything else',
    )
    this.name = 'GrantPeriodError'
  }
}

export class GrantExpiryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrantExpiryError'
  }
}

export class GrantNonceError extends Error {
  constructor(readonly nonce: bigint) {
    super(`nonce does not fit in u64: ${nonce}`)
    this.name = 'GrantNonceError'
  }
}

function assertBounds(bounds: GrantBounds, now: Date): void {
  if (bounds.capAmount <= 0n || bounds.capAmount > U64_MAX) {
    throw new GrantAmountError(bounds.capAmount)
  }
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000))
  const expiry = timestampToChain(bounds.expiresAt)

  if (expiry !== NO_TIMESTAMP && expiry <= nowSeconds) {
    throw new GrantExpiryError(
      `the end date ${bounds.expiresAt} is already in the past; the program refuses it, and an ` +
        'allowance that expires on arrival is not what the person saw on the screen',
    )
  }

  if (bounds.kind === 'fixed') return

  if (!Number.isInteger(bounds.periodSeconds) || bounds.periodSeconds <= 0) {
    throw new GrantPeriodError(bounds.periodSeconds)
  }
  const start = timestampToChain(bounds.startsAt)
  /*
   * Правило самої програми (`RecurringDelegationStartOnLandingRequiresExpiry`):
   * почати «щойно сяде» можна лише разом із датою закінчення. Перевіряємо тут,
   * бо інакше людина дізнається про це вже після підпису.
   */
  if (start === NO_TIMESTAMP && expiry === NO_TIMESTAMP) {
    throw new GrantExpiryError(
      'a recurring allowance that starts when the transaction lands must have an end date; the ' +
        'program refuses an open-ended one (RecurringDelegationStartOnLandingRequiresExpiry)',
    )
  }
  if (start !== NO_TIMESTAMP && expiry !== NO_TIMESTAMP && start >= expiry) {
    throw new GrantExpiryError(
      `the first period starts at ${bounds.startsAt}, which is not before the end date ` +
        `${bounds.expiresAt}; the program answers RecurringDelegationStartTimeGreaterThanExpiry`,
    )
  }
}

function initIdFor(value: AuthorityInitId): bigint {
  return value === 'same-transaction' ? UNKNOWN_INIT_ID : value
}

/**
 * Інструкція видачі.
 *
 * `payer` не підставляється сам: коли його немає, ренту платить `delegator`, і
 * саме так це видно в акаунті (`header.payer`). Підставити сюди мерчанта
 * означало б, що чужий гаманець записаний спонсором дозволу без відома того,
 * хто підписує.
 */
export async function buildGrantInstruction(input: GrantInput): Promise<Instruction> {
  const { bounds } = input
  const now = input.now ?? new Date()
  assertBounds(bounds, now)
  if (input.nonce < 0n || input.nonce > U64_MAX) throw new GrantNonceError(input.nonce)

  const common = {
    delegatee: toAddress(bounds.delegatee),
    delegator: input.delegator,
    expectedSubscriptionAuthorityInitId: initIdFor(input.authorityInitId),
    expiryTs: timestampToChain(bounds.expiresAt),
    nonce: input.nonce,
    programAddress: input.programAddress ?? PROGRAM_ADDRESS,
    tokenMint: toAddress(input.tokenMint),
    ...(input.payer === undefined ? {} : { payer: input.payer }),
  }

  if (bounds.kind === 'fixed') {
    return getCreateFixedDelegationOverlayInstructionAsync({ ...common, amount: bounds.capAmount })
  }
  return getCreateRecurringDelegationOverlayInstructionAsync({
    ...common,
    amountPerPeriod: bounds.capAmount,
    periodLengthS: BigInt(bounds.periodSeconds),
    startTs: timestampToChain(bounds.startsAt),
  })
}

export type InitAuthorityInput = {
  owner: TransactionSigner
  tokenMint: string
  /** Токен-програма міну — властивість міну, не наша. Читається з мережі. */
  tokenProgram: string
  /** Токен-акаунт власника в цьому міні. */
  userAta: string
  payer?: TransactionSigner
  programAddress?: Address
}

/**
 * Ініціалізація авторитету підписок — акаунта, під яким висять усі дозволи
 * гаманця в межах одного міну.
 *
 * Живе тут, а не окремо, бо без нього перша видача просто не сідає: дозвіл
 * створюється **під** авторитетом, і його відсутність дала б відмову, яку
 * легко прийняти за відмову у видачі.
 */
export function buildInitAuthorityInstruction(input: InitAuthorityInput): Promise<Instruction> {
  return getInitSubscriptionAuthorityOverlayInstructionAsync({
    owner: input.owner,
    programAddress: input.programAddress ?? PROGRAM_ADDRESS,
    tokenMint: toAddress(input.tokenMint),
    tokenProgram: toAddress(input.tokenProgram),
    userAta: toAddress(input.userAta),
    ...(input.payer === undefined ? {} : { payer: input.payer }),
  })
}

/**
 * Адреса, яку створить ця видача, — відома **до** підпису.
 *
 * Потрібна саме заздалегідь: показати людині, що саме з'явиться в списку, і
 * дочекатися появи цього акаунта замість того, щоб довіряти підпису (той самий
 * принцип, що й у підтвердженні скасування).
 */
export async function findGrantedAllowance(seeds: {
  delegator: string
  delegatee: string
  tokenMint: string
  nonce: bigint
}): Promise<Pda> {
  const authority = await findSubscriptionAuthority({
    tokenMint: toAddress(seeds.tokenMint),
    user: toAddress(seeds.delegator),
  })
  return findDelegation({
    delegatee: toAddress(seeds.delegatee),
    delegator: toAddress(seeds.delegator),
    nonce: seeds.nonce,
    subscriptionAuthority: authority.address,
  })
}

export type GrantTransactionMessage = Parameters<typeof compileTransaction>[0] &
  TransactionMessageWithFeePayer &
  TransactionMessageWithBlockhashLifetime

export type GrantTransactionInput = GrantInput & {
  lifetime: RevokeLifetime
  /**
   * Ініціалізувати авторитет у **цій самій** транзакції. Потрібно рівно один
   * раз на гаманець і мін — при першій видачі.
   *
   * Мін сюди не передається: він уже названий у `tokenMint` самої видачі, і два
   * місця для однієї адреси означали б авторитет в одному міні й дозвіл в
   * іншому — розбіжність, якої в типах не видно.
   */
  initAuthority?: Omit<InitAuthorityInput, 'owner' | 'payer' | 'programAddress' | 'tokenMint'>
}

export class GrantInitIdMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrantInitIdMismatchError'
  }
}

/**
 * Транзакція видачі: одна інструкція, або дві — коли авторитет створюється тут же.
 *
 * Ці два випадки зв'язані жорстко й перевіряються: `'same-transaction'` без
 * `initAuthority` означав би вимкнений сторож несвіжості **без** причини, а
 * `initAuthority` із конкретним `initId` — очікування ідентифікатора, якого
 * на момент підпису ще не існує.
 */
export async function buildGrantTransaction(
  input: GrantTransactionInput,
): Promise<GrantTransaction> {
  const bundlesInit = input.initAuthority !== undefined
  const sameTransaction = input.authorityInitId === 'same-transaction'
  if (bundlesInit && !sameTransaction) {
    throw new GrantInitIdMismatchError(
      'the authority is being initialised in this very transaction, so its initId does not exist ' +
        "yet; pass authorityInitId: 'same-transaction'",
    )
  }
  if (!bundlesInit && sameTransaction) {
    throw new GrantInitIdMismatchError(
      "authorityInitId is 'same-transaction', but no initSubscriptionAuthority instruction is " +
        'bundled; that would switch off the staleness guard for nothing',
    )
  }

  const instructions: Instruction[] = []
  if (input.initAuthority !== undefined) {
    instructions.push(
      await buildInitAuthorityInstruction({
        ...input.initAuthority,
        owner: input.delegator,
        tokenMint: input.tokenMint,
        ...(input.payer === undefined ? {} : { payer: input.payer }),
        ...(input.programAddress === undefined ? {} : { programAddress: input.programAddress }),
      }),
    )
  }
  instructions.push(await buildGrantInstruction(input))

  const message = instructions.reduce<GrantTransactionMessage>(
    (carry, instruction) => appendTransactionMessageInstruction(instruction, carry),
    pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayerSigner(input.payer ?? input.delegator, draft),
      (draft) => setTransactionMessageLifetimeUsingBlockhash(input.lifetime, draft),
    ),
  )
  const transaction = compileTransaction(message)
  return {
    message,
    transaction,
    wireTransaction: getTransactionEncoder().encode(transaction) as Uint8Array,
    wireTransactionBase64: getBase64EncodedWireTransaction(transaction),
  }
}

export type GrantTransaction = {
  message: GrantTransactionMessage
  transaction: Transaction
  wireTransaction: Uint8Array
  wireTransactionBase64: Base64EncodedWireTransaction
}
