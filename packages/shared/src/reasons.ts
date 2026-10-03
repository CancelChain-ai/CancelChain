import { z } from 'zod'

/**
 * Скінченний перелік категорій відмови у списанні (`FR-015`, `SC-011`).
 *
 * Категорії `other` тут немає **навмисно**. `SC-011` вимагає, щоб частка
 * «інша помилка» дорівнювала нулю, а смітникова категорія перетворює цей вимір
 * на самообман: усе невідоме тихо стікає в неї, і показник лишається зеленим.
 * Якщо програма поверне код, якого ми не знаємо, подія пишеться з `reason = null`,
 * а воркер логує це як помилку мапінгу — дірка має бути видимою.
 *
 * `merchant_account_missing` was added in `T040` (owner's decision, 2026-10-03):
 * the merchant has no token account to receive into. The cause is known and it
 * is not the subscriber's — `null` would claim it is unknown.
 */
export const REJECT_REASONS = [
  'revoked',
  'cap_exceeded',
  'paused',
  'expired',
  'insufficient_funds',
  'wrong_mint',
  'not_due_yet',
  'merchant_account_missing',
] as const

export type RejectReason = (typeof REJECT_REASONS)[number]

export const rejectReasonSchema = z.enum(REJECT_REASONS)

/** `null` означає рівно одне: код програми нам невідомий. Не «інша причина». */
export const rejectReasonOrUnknownSchema = rejectReasonSchema.nullable()

/**
 * Формулювання для інтерфейсу. Мерчант і користувач бачать причину словами,
 * ніколи не кодом (`FR-015`).
 */
export const REJECT_REASON_LABELS = {
  revoked: 'Permission cancelled',
  cap_exceeded: 'Over the ceiling for this period',
  paused: 'Paused by the subscriber',
  expired: 'Permission expired',
  insufficient_funds: 'Not enough funds',
  wrong_mint: 'Wrong asset',
  not_due_yet: 'Too early — the period has not come round yet',
  merchant_account_missing: 'The merchant has no account to receive this asset',
} as const satisfies Record<RejectReason, string>

/** Текст для невідомого коду. Каже правду, а не вигадує категорію. */
export const UNKNOWN_REJECT_REASON_LABEL = 'Rejected by the network — reason not recognised'

export function rejectReasonLabel(reason: RejectReason | null): string {
  return reason === null ? UNKNOWN_REJECT_REASON_LABEL : REJECT_REASON_LABELS[reason]
}

// ── Mapping (`T040`) ─────────────────────────────────────────────────────────

/** Subscriptions Delegation Program. An indexer test keeps it equal to the SDK's address. */
export const SUBSCRIPTIONS_PROGRAM = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44'
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

/**
 * What the chain said about a refusal, in the shape the indexer keeps in
 * `events.raw`. A schema, because the backfill reads rows written before it.
 */
export const rejectionFactsSchema = z.object({
  failure: z.discriminatedUnion('type', [
    z.object({ type: z.literal('custom'), code: z.number().int() }),
    z.object({ type: z.literal('runtime'), name: z.string() }),
    z.object({ type: z.literal('unrecognised'), error: z.unknown().optional() }),
  ]),
  /** The program from the innermost `… failed:` line; `null` when the logs do not say. */
  raisedBy: z.string().nullable(),
  /**
   * Whether the charge's token accounts existed before the transaction
   * (`meta.preTokenBalances`). Without it `110` cannot tell whose account was
   * missing. Rows written before `T040` do not carry it.
   */
  tokenAccountsExisted: z
    .object({ source: z.boolean(), destination: z.boolean() })
    .nullable()
    .optional(),
  /**
   * The subscription authority the charge named: whether it existed before the
   * transaction, and whether it is the subscriber's own (derived from the
   * source account's owner and the mint). Rows written before `T040b` lack it.
   */
  authority: z
    .object({ existed: z.boolean().nullable(), isSubscribers: z.boolean().nullable() })
    .optional(),
})

export type RejectionFacts = z.infer<typeof rejectionFactsSchema>

export type RejectionContext = {
  /**
   * The permission carries our pause label. The chain keeps no pause: pausing
   * and cancelling are one operation (`cancelSubscription`), and `508` answers both.
   */
  paused: boolean
}

export type Classification = { reason: RejectReason } | { reason: null; unmapped: string }

/**
 * A code means nothing without its program (found in `T038`): `Custom 1` of the
 * token program is a lack of funds, not this program's first code. Hence the
 * key is the pair `(raisedBy, code)`. Only codes whose meaning to a person is
 * unambiguous are listed; everything else is `null`.
 */
const BY_PROGRAM_AND_CODE: Readonly<Record<string, Readonly<Record<number, RejectReason>>>> = {
  [SUBSCRIPTIONS_PROGRAM]: {
    125: 'wrong_mint', // MintMismatch
    128: 'expired', // DelegationExpired
    136: 'revoked', // StaleSubscriptionAuthority: the authority was closed, init_id rotated
    300: 'cap_exceeded', // AmountExceedsLimit (fixed)
    400: 'cap_exceeded', // AmountExceedsPeriodLimit
    401: 'not_due_yet', // PeriodNotElapsed
    407: 'not_due_yet', // DelegationNotStarted
    501: 'expired', // PlanExpired
  },
  [TOKEN_PROGRAM]: { 1: 'insufficient_funds', 3: 'wrong_mint' },
  [TOKEN_2022_PROGRAM]: { 1: 'insufficient_funds', 3: 'wrong_mint' },
}

/** `SubscriptionCancelled`: the stop date has passed — a cancellation or our pause. */
const SUBSCRIPTION_CANCELLED = 508
/** `InvalidTokenSplTokenAccountData` / `InvalidToken2022TokenAccountData`. */
const TOKEN_ACCOUNT_DATA = new Set([110, 107])
/** `InvalidSubscriptionAuthorityPda`. */
const INVALID_AUTHORITY = 103

export function classifyRejection(
  facts: RejectionFacts,
  context: RejectionContext,
): Classification {
  const { failure, raisedBy } = facts
  if (raisedBy === null) return { reason: null, unmapped: 'the logs name no failing program' }

  if (failure.type === 'runtime') {
    // A closed account belongs to the system program, and the program refuses
    // with a runtime error, not a code (`T028`). The most important category.
    if (raisedBy === SUBSCRIPTIONS_PROGRAM && failure.name === 'InvalidAccountOwner') {
      return { reason: 'revoked' }
    }
    return { reason: null, unmapped: `runtime ${failure.name} from ${raisedBy}` }
  }
  if (failure.type === 'unrecognised') {
    return { reason: null, unmapped: `unrecognised failure from ${raisedBy}` }
  }

  const { code } = failure
  if (raisedBy === SUBSCRIPTIONS_PROGRAM && code === SUBSCRIPTION_CANCELLED) {
    return { reason: context.paused ? 'paused' : 'revoked' }
  }
  if (raisedBy === SUBSCRIPTIONS_PROGRAM && TOKEN_ACCOUNT_DATA.has(code)) {
    // The same code answers a missing account on either side (seen on devnet),
    // so each side is named only when the transaction shows it.
    const existed = facts.tokenAccountsExisted
    if (existed?.source === true && existed.destination === false) {
      return { reason: 'merchant_account_missing' }
    }
    if (existed?.source === false && existed.destination === true) {
      // The subscriber emptied and closed their token account (devnet,
      // 2026-09-29, `383SBC…`). The permission still stands; what is missing
      // is the money it draws from — and topping up recreates the account.
      return { reason: 'insufficient_funds' }
    }
    return {
      reason: null,
      unmapped: `custom ${code} from ${raisedBy}: ${
        existed === undefined || existed === null
          ? 'no record of which token account was missing'
          : `token accounts existed: source ${existed.source}, destination ${existed.destination}`
      }`,
    }
  }
  if (raisedBy === SUBSCRIPTIONS_PROGRAM && code === INVALID_AUTHORITY) {
    // "Wrong authority address" literally. It is the subscriber's revocation
    // only when the charge named the subscriber's own authority and it was
    // gone: "revoke everything in this mint" closes it (devnet, 2026-09-29,
    // `6AU3rE…`). A wrong address from the caller stays unknown.
    const { authority } = facts
    if (authority?.isSubscribers === true && authority.existed === false) {
      return { reason: 'revoked' }
    }
    return {
      reason: null,
      unmapped: `custom ${code} from ${raisedBy}: ${
        authority === undefined
          ? 'no record of the authority the charge named'
          : `authority existed ${authority.existed}, is the subscriber's ${authority.isSubscribers}`
      }`,
    }
  }
  const reason = BY_PROGRAM_AND_CODE[raisedBy]?.[code]
  return reason === undefined
    ? { reason: null, unmapped: `custom ${code} from ${raisedBy}` }
    : { reason }
}
