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
 */

/**
 * Мінімум із картки, потрібний для відкликання. Саме `Pick`, а не власний тип:
 * поле, яке зникне з `Allowance`, має зламати збірку тут, а не тихо приїхати
 * `undefined` у деривацію акаунтів.
 */
export type RevokeTarget = Pick<Allowance, 'kind' | 'owner' | 'pda' | 'planPda'>

export type RevokeInput = {
  allowance: RevokeTarget
  /** Гаманець, що підписує. Мусить збігатися з `allowance.owner`. */
  authority: string
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
  const instruction = buildRevokeInstruction(input)
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
  const message = buildRevokeTransactionMessage(input)
  const transaction = compileTransaction(message)
  return {
    message,
    transaction,
    wireTransaction: getTransactionEncoder().encode(transaction) as Uint8Array,
    wireTransactionBase64: getBase64EncodedWireTransaction(transaction),
  }
}
