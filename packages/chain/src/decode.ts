import {
  type Allowance,
  type AllowanceStatus,
  allowanceSchema,
  fromU64,
  periodSecondsFromHours,
} from '@cancelchain/shared'
import type { Address, ReadonlyUint8Array } from '@solana/kit'
import {
  AccountDiscriminator,
  CURRENT_PROGRAM_VERSION,
  type FixedDelegation,
  getFixedDelegationDecoder,
  getFixedDelegationEncoder,
  getRecurringDelegationDecoder,
  getRecurringDelegationEncoder,
  getSubscriptionDelegationDecoder,
  getSubscriptionDelegationEncoder,
  type RecurringDelegation,
  type SubscriptionDelegation,
} from '@solana/subscriptions'

/**
 * Декодування акаунтів дозволу й приведення їх до спільної форми `Allowance`.
 *
 * Розмір і розкладка беруться з кодеків SDK, а не переписуються числами: акаунт
 * тут описує чужі гроші, і розбіжність у зміщенні на один байт дала б не
 * помилку, а правдоподібне число не з того поля.
 */

/** Нуль у полі часу — «не задано». Не 1970 рік. */
const NO_TIMESTAMP = 0n

/*
 * Що 0 у цих полях означає саме відсутність значення, а не момент часу, видно
 * з двох повідомлень самої програми (`subscriptionsErrorMessages`, не з
 * документації): `End timestamp must be zero or in the future` і
 * `start_ts of 0 (start on landing) requires a non-zero expiry`.
 */

export const DELEGATION_SIZES = {
  fixed: getFixedDelegationEncoder().fixedSize,
  recurring: getRecurringDelegationEncoder().fixedSize,
  subscription: getSubscriptionDelegationEncoder().fixedSize,
} as const

/** Чому акаунт не вдалося прочитати. Ніколи не мовчазний `null`. */
export type UndecodableReason = 'empty' | 'discriminator' | 'length'

export type DecodedDelegation =
  | { kind: 'fixed'; address: Address; version: number; data: FixedDelegation }
  | { kind: 'recurring'; address: Address; version: number; data: RecurringDelegation }
  | { kind: 'subscription'; address: Address; version: number; data: SubscriptionDelegation }
  | {
      kind: 'unknown'
      address: Address
      /** `null` лише коли даних немає взагалі. */
      discriminator: number | null
      reason: UndecodableReason
    }

/**
 * Читає акаунт дозволу за дискримінатором у першому байті.
 *
 * Тип дозволу **не виводиться з адреси** — фіксований і періодичний дозволи
 * мають однакову PDA (`pda.ts`), тож єдине джерело типу — цей байт.
 *
 * Не кидає на чужому акаунті: `T019` читає всі акаунти гаманця пачкою, і одна
 * незнайома структура не має права зупинити список. Але й не мовчить — у
 * `unknown` названо, що саме не зійшлося.
 */
export function decodeDelegation(address: Address, data: ReadonlyUint8Array): DecodedDelegation {
  const discriminator = data[0]
  if (discriminator === undefined) {
    return { kind: 'unknown', address, discriminator: null, reason: 'empty' }
  }

  const expected = expectedSizeFor(discriminator)
  if (expected === null) {
    return { kind: 'unknown', address, discriminator, reason: 'discriminator' }
  }
  if (data.length !== expected) {
    return { kind: 'unknown', address, discriminator, reason: 'length' }
  }

  switch (discriminator) {
    case AccountDiscriminator.FixedDelegation: {
      const decoded = getFixedDelegationDecoder().decode(data)
      return { kind: 'fixed', address, version: decoded.header.version, data: decoded }
    }
    case AccountDiscriminator.RecurringDelegation: {
      const decoded = getRecurringDelegationDecoder().decode(data)
      return { kind: 'recurring', address, version: decoded.header.version, data: decoded }
    }
    default: {
      const decoded = getSubscriptionDelegationDecoder().decode(data)
      return { kind: 'subscription', address, version: decoded.header.version, data: decoded }
    }
  }
}

function expectedSizeFor(discriminator: number): number | null {
  switch (discriminator) {
    case AccountDiscriminator.FixedDelegation:
      return DELEGATION_SIZES.fixed
    case AccountDiscriminator.RecurringDelegation:
      return DELEGATION_SIZES.recurring
    case AccountDiscriminator.SubscriptionDelegation:
      return DELEGATION_SIZES.subscription
    default:
      return null
  }
}

export class UnsupportedVersionError extends Error {
  constructor(
    readonly address: Address,
    readonly version: number,
  ) {
    super(
      `allowance ${address} has account version ${version}, this build understands ` +
        `${CURRENT_PROGRAM_VERSION}; the layout may have moved, so the fields are not trusted`,
    )
    this.name = 'UnsupportedVersionError'
  }
}

export class MissingPlanError extends Error {
  constructor(readonly address: Address) {
    super(
      `subscription ${address} needs its plan: the account carries neither the mint nor the ` +
        'plan address, so both have to be resolved from the plan account',
    )
    this.name = 'MissingPlanError'
  }
}

export class UndecodableAccountError extends Error {
  constructor(
    readonly address: Address,
    readonly reason: UndecodableReason,
  ) {
    super(`allowance ${address} could not be decoded: ${reason}`)
    this.name = 'UndecodableAccountError'
  }
}

/** Мітка часу мережі → ISO 8601, з нулем як «не задано». */
export function timestampFromChain(seconds: bigint): string | null {
  if (seconds === NO_TIMESTAMP) return null
  if (seconds < 0n) {
    throw new RangeError(`timestamp cannot be negative: ${seconds}`)
  }
  const millis = Number(seconds) * 1000
  if (!Number.isSafeInteger(millis)) {
    throw new RangeError(`timestamp does not fit in a JS date: ${seconds}`)
  }
  return new Date(millis).toISOString()
}

/**
 * u64 з мережі в число. Тільки для величин, які числом справді є: довжина
 * періоду й кількість годин. Суми через це не проходять — вони лишаються
 * `bigint`, бо u64 у double не влазить (`packages/shared/primitives.ts`).
 */
function positiveU64ToNumber(value: bigint, what: string): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${what} out of range: ${value}`)
  }
  return Number(value)
}

/** Довжина періоду з мережі (секунди, u64) у число, яким її тримає сховище. */
export function periodSecondsFromChain(seconds: bigint): number {
  return positiveU64ToNumber(seconds, 'period length')
}

/** Години плану з мережі в секунди сховища — конвертація явна, `PLAN.md` про неї попереджає. */
export function periodSecondsFromChainHours(hours: bigint): number {
  return periodSecondsFromHours(positiveU64ToNumber(hours, 'period hours'))
}

/** Дані плану, яких немає в акаунті підписки й які треба принести ззовні. */
export type PlanRef = {
  pda: Address
  mint: Address
}

export type AllowanceContext = {
  /** Слот, на якому акаунт прочитано. Це і є мітка свіжості кешу. */
  slot: number
  syncedAt: string
  /** Обов'язковий для `subscription`, безглуздий для решти. */
  plan?: PlanRef
  /** Момент, відносно якого рахується вичерпаність. За замовчуванням — зараз. */
  now?: Date
}

/**
 * Статус із того, що видно в акаунті.
 *
 * `revoked` тут не з'являється ніколи: скасований дозвіл — це **відсутній
 * акаунт**, а не акаунт із прапорцем. `paused` теж ніколи: у мережі паузи
 * не існує окремо від «скасовано до кінця періоду» (`cancelSubscription` дає
 * саме її, `resumeSubscription` знімає), тож `FR-011` і `FR-028` лягають на
 * одне й те саме поле `expiresAtTs`. Розрізняє їх наш намір, а не мережа, —
 * і цю різницю не можна вигадувати тут.
 */
function deriveStatus(decoded: DecodedDelegation, now: Date): AllowanceStatus {
  const seconds = BigInt(Math.floor(now.getTime() / 1000))
  switch (decoded.kind) {
    case 'fixed': {
      const { amount, expiryTs } = decoded.data
      const expired = expiryTs !== NO_TIMESTAMP && expiryTs <= seconds
      return amount === 0n || expired ? 'exhausted' : 'active'
    }
    case 'recurring': {
      const { expiryTs } = decoded.data
      return expiryTs !== NO_TIMESTAMP && expiryTs <= seconds ? 'exhausted' : 'active'
    }
    case 'subscription': {
      const { expiresAtTs } = decoded.data
      return expiresAtTs !== NO_TIMESTAMP && expiresAtTs <= seconds ? 'exhausted' : 'active'
    }
    default:
      throw new UndecodableAccountError(decoded.address, decoded.reason)
  }
}

/**
 * Прочитаний акаунт → спільна форма `Allowance`.
 *
 * ⚠️ **Скільки вже витрачено за `fixed`-дозволом, акаунт не каже.** У
 * `FixedDelegation` є лише `amount` — те, що ще дозволено взяти; поля
 * «витрачено» в структурі немає взагалі. Тому `spentInPeriod` для `fixed` —
 * нуль, і це не «нічого не витрачено», а «мережа цього не зберігає». Картка
 * `FR-002` мусить казати це словами, а не малювати порожню смужку (`T024`).
 */
export function toAllowance(decoded: DecodedDelegation, context: AllowanceContext): Allowance {
  if (decoded.kind === 'unknown') {
    throw new UndecodableAccountError(decoded.address, decoded.reason)
  }
  if (decoded.version !== CURRENT_PROGRAM_VERSION) {
    throw new UnsupportedVersionError(decoded.address, decoded.version)
  }

  const { header } = decoded.data
  const now = context.now ?? new Date()
  const common = {
    pda: decoded.address,
    owner: header.delegator,
    delegate: header.delegatee,
    status: deriveStatus(decoded, now),
    /** Паузи в акаунті немає — див. `deriveStatus`. */
    pausedAt: null,
    lastSlot: context.slot,
    syncedAt: context.syncedAt,
  }

  if (decoded.kind === 'fixed') {
    const { amount, expiryTs, mint } = decoded.data
    return allowanceSchema.parse({
      ...common,
      kind: 'fixed',
      mint,
      capAmount: fromU64(amount),
      spentInPeriod: fromU64(0n),
      periodSeconds: null,
      periodStartedAt: null,
      expiresAt: timestampFromChain(expiryTs),
      endsAt: null,
      planPda: null,
    })
  }

  if (decoded.kind === 'recurring') {
    const { amountPerPeriod, amountPulledInPeriod, currentPeriodStartTs, expiryTs, mint } =
      decoded.data
    return allowanceSchema.parse({
      ...common,
      kind: 'recurring',
      mint,
      capAmount: fromU64(amountPerPeriod),
      spentInPeriod: fromU64(amountPulledInPeriod),
      periodSeconds: periodSecondsFromChain(decoded.data.periodLengthS),
      periodStartedAt: timestampFromChain(currentPeriodStartTs),
      expiresAt: timestampFromChain(expiryTs),
      endsAt: null,
      planPda: null,
    })
  }

  const plan = context.plan
  if (plan === undefined) {
    throw new MissingPlanError(decoded.address)
  }
  const { amountPulledInPeriod, currentPeriodStartTs, expiresAtTs, terms } = decoded.data
  return allowanceSchema.parse({
    ...common,
    kind: 'subscription',
    mint: plan.mint,
    capAmount: fromU64(terms.amount),
    spentInPeriod: fromU64(amountPulledInPeriod),
    periodSeconds: periodSecondsFromChainHours(terms.periodHours),
    periodStartedAt: timestampFromChain(currentPeriodStartTs),
    /**
     * `expiresAt` тут `null` навмисно. Підписка не має терміну, обраного при
     * оформленні: `SubscribeData` поля про строк не містить взагалі, а
     * `expiresAtTs` заповнює лише `cancelSubscription`. Отже ненульове значення
     * означає не «протермінується», а «скасовано, діє до цієї дати» — тобто
     * рівно `endsAt` з `FR-028`.
     */
    expiresAt: null,
    endsAt: timestampFromChain(expiresAtTs),
    planPda: plan.pda,
  })
}
