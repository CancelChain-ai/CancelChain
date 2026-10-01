import {
  findSubscription,
  PROGRAM_ADDRESS,
  type ProgramEvent,
  readProgramEvent,
  toAddress,
  type UnreadableEvent,
} from '@cancelchain/chain'
import {
  type AccountMeta,
  AccountRole,
  type Address,
  getBase58Encoder,
  type ReadonlyUint8Array,
} from '@solana/kit'
import {
  type ParsedSubscriptionsInstruction,
  parseSubscriptionsInstruction,
  SubscriptionsInstruction,
} from '@solana/subscriptions'

/**
 * One transaction of the Subscriptions program → the events of the permissions
 * it touched (`FR-005`).
 *
 * Two sources, because the program only half-describes itself:
 * - **its events** (self-CPI inner instructions, see `events.ts` in
 *   `packages/chain`) for subscriptions created, charges, cancellations,
 *   resumptions and plan updates;
 * - **its instructions** for what emits no event at all: creating a fixed or
 *   recurring delegation, closing any permission, closing a wallet's
 *   subscription authority, and every rejected charge — a failed transaction
 *   rolls its events back, so the attempt is visible only as the instruction
 *   that was refused and the error it got.
 *
 * Nothing here talks to the network or the database. Mapping an error code to a
 * reason category is `T040`; turning these into stored rows is `T039`.
 */

/** Numbers as the node sends them: plain JSON gives `number`, `@solana/kit` lifts u64 to `bigint`. */
type Integer = number | bigint

type CompiledInstruction = {
  programIdIndex: Integer
  accounts: readonly Integer[]
  /** Base58, as `getTransaction` returns it with `encoding: 'json'`. */
  data: string
}

/**
 * Exactly the part of a `getTransaction` (`encoding: 'json'`) response the
 * decoder reads — the same trick as `SignaturesForAddressRpc`: a real kit
 * response and a JSON fixture both fit it without casting.
 */
export type TransactionRecord = {
  slot: Integer
  blockTime: Integer | null
  transaction: {
    signatures: readonly string[]
    message: {
      accountKeys: readonly string[]
      header: {
        numRequiredSignatures: Integer
        numReadonlySignedAccounts: Integer
        numReadonlyUnsignedAccounts: Integer
      }
      instructions: readonly CompiledInstruction[]
    }
  }
  meta: {
    err: unknown
    logMessages?: readonly string[] | null
    innerInstructions?:
      | readonly { index: Integer; instructions: readonly CompiledInstruction[] }[]
      | null
    loadedAddresses?: { writable: readonly string[]; readonly: readonly string[] } | null
  } | null
}

export type AllowanceKind = 'fixed' | 'recurring' | 'subscription'

/**
 * How the program refused. `custom` is the program's own error code (its
 * `SubscriptionsError`); `runtime` is the runtime refusing before the program
 * could — e.g. `InvalidAccountOwner` for a charge against a closed permission,
 * which is the most important rejection of all and has no custom code (`T028`).
 */
export type ProgramFailure =
  | { type: 'custom'; code: number }
  | { type: 'runtime'; name: string }
  | { type: 'unrecognised'; error: unknown }

type Common = {
  signature: string
  slot: bigint
  /** Unix seconds; `null` when the node does not know the block's time. */
  blockTime: bigint | null
  /** Index of the top-level instruction the event came from. */
  instructionIndex: number
  /**
   * Place of the instruction behind the event in the transaction's execution
   * order, CPIs included — a property of the transaction, not of this decoder.
   * One transaction can charge the same permission several times (a split
   * payment does, on devnet); this is what tells those charges apart.
   */
  position: number
}

export type IndexedEvent = Common &
  (
    | { kind: 'created'; allowance: Address; allowanceKind: AllowanceKind; owner: Address }
    | {
        kind: 'charged'
        allowance: Address
        allowanceKind: AllowanceKind
        amount: bigint
        receiver: Address
      }
    | {
        kind: 'rejected'
        allowance: Address
        allowanceKind: AllowanceKind
        /** What the merchant tried to take. */
        attempted: bigint
        failure: ProgramFailure
        /**
         * The program that raised `failure`, from the innermost `… failed:` log
         * line; `null` when the logs do not say. A code means nothing without
         * it: a token transfer refused for lack of funds surfaces as `Custom 1`
         * of the token program, passed up unchanged by this program — the error
         * field alone would read it as this program's code 1.
         */
        raisedBy: Address | null
      }
    /**
     * `cancelSubscription`: the subscription stays chargeable until
     * `chargesStopAt` (unix seconds), then every charge is refused. The same
     * on-chain operation stands behind our Cancel (`T037a`), pause and "don't
     * renew" (`T015`), so it is named after what the program did, not after
     * any one button.
     */
    | { kind: 'cancelled'; allowance: Address; chargesStopAt: bigint }
    | { kind: 'resumed'; allowance: Address }
    /** The permission account was closed. `revokeDelegation` is shared by all three kinds. */
    | { kind: 'revoked'; allowance: Address }
    /**
     * A plan's mutable terms changed — for every subscription on it at once,
     * so it names the plan, not a permission.
     */
    | { kind: 'plan-updated'; plan: Address; status: number; endTs: bigint; pullers: Address[] }
    /**
     * The wallet's subscription authority for one mint was closed. Its `init_id`
     * rotates with it, so every permission that wallet gave in that mint stops
     * working at once — without any of those accounts being touched.
     */
    | { kind: 'authority-closed'; owner: Address; authority: Address }
  )

export type DecodedTransaction = {
  signature: string
  slot: bigint
  blockTime: bigint | null
  failed: boolean
  events: IndexedEvent[]
  /**
   * What the decoder saw and could not turn into an event. Never dropped: an
   * event we cannot read is a gap in someone's history, and it has to be loud.
   */
  problems: DecodeProblem[]
  logs: readonly string[]
}

export type DecodeProblem =
  | ({ type: 'unreadable-event'; instructionIndex: number } & UnreadableEvent)
  | { type: 'unparsable-instruction'; instructionIndex: number; message: string }
  | { type: 'unattributed-failure'; instructionIndex: number; failure: ProgramFailure }

const base58 = getBase58Encoder()

type LocatedInstruction = {
  /** Top-level instruction this one belongs to. */
  outerIndex: number
  /** Index in execution order across the whole transaction, CPIs included. */
  position: number
  /** `false` for the top-level instruction itself. */
  inner: boolean
  programAddress: Address
  accounts: AccountMeta[]
  data: ReadonlyUint8Array
}

/** Account roles from the message header, so the SDK parser gets real metas rather than guesses. */
function accountTable(tx: TransactionRecord): AccountMeta[] {
  const { accountKeys, header } = tx.transaction.message
  const signers = Number(header.numRequiredSignatures)
  const readonlySigners = Number(header.numReadonlySignedAccounts)
  const readonlyUnsigned = Number(header.numReadonlyUnsignedAccounts)
  const staticMetas = accountKeys.map((key, i): AccountMeta => {
    const signer = i < signers
    const writable = signer
      ? i < signers - readonlySigners
      : i < accountKeys.length - readonlyUnsigned
    const role = signer
      ? writable
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER
      : writable
        ? AccountRole.WRITABLE
        : AccountRole.READONLY
    return { address: toAddress(key), role }
  })
  const loaded = tx.meta?.loadedAddresses
  return [
    ...staticMetas,
    ...(loaded?.writable ?? []).map((key) => ({
      address: toAddress(key),
      role: AccountRole.WRITABLE,
    })),
    ...(loaded?.readonly ?? []).map((key) => ({
      address: toAddress(key),
      role: AccountRole.READONLY,
    })),
  ]
}

function locate(
  compiled: CompiledInstruction,
  table: AccountMeta[],
  outerIndex: number,
  inner: boolean,
  position: number,
): LocatedInstruction {
  const meta = (index: Integer): AccountMeta => {
    const found = table[Number(index)]
    if (found === undefined) throw new Error(`account index ${index} is outside the transaction`)
    return found
  }
  return {
    outerIndex,
    position,
    inner,
    programAddress: meta(compiled.programIdIndex).address,
    accounts: compiled.accounts.map(meta),
    data: base58.encode(compiled.data),
  }
}

/** Every instruction of the transaction in execution order, CPIs included. */
function allInstructions(tx: TransactionRecord): LocatedInstruction[] {
  const table = accountTable(tx)
  const innerByOuter = new Map<number, readonly CompiledInstruction[]>()
  for (const group of tx.meta?.innerInstructions ?? []) {
    innerByOuter.set(Number(group.index), group.instructions)
  }
  return tx.transaction.message.instructions
    .flatMap((outer, outerIndex) => [
      { compiled: outer, outerIndex, inner: false },
      ...(innerByOuter.get(outerIndex) ?? []).map((compiled) => ({
        compiled,
        outerIndex,
        inner: true,
      })),
    ])
    .map((ix, position) => locate(ix.compiled, table, ix.outerIndex, ix.inner, position))
}

/**
 * `{ InstructionError: [index, detail] }` → which top-level instruction failed
 * and how. Anything else (fee payer out of lamports, expired blockhash) did not
 * reach the program and belongs to no permission.
 */
export function readInstructionError(
  err: unknown,
): { instructionIndex: number; failure: ProgramFailure } | null {
  if (typeof err !== 'object' || err === null || !('InstructionError' in err)) return null
  const detail: unknown = err.InstructionError
  if (!Array.isArray(detail) || detail.length !== 2) return null
  const [index, cause] = detail as [unknown, unknown]
  // kit lifts the index and the code to bigint; `typeof === 'number'` alone would drop them.
  if (typeof index !== 'number' && typeof index !== 'bigint') return null
  return { instructionIndex: Number(index), failure: readFailure(cause) }
}

function readFailure(cause: unknown): ProgramFailure {
  if (typeof cause === 'string') return { type: 'runtime', name: cause }
  if (typeof cause === 'object' && cause !== null && 'Custom' in cause) {
    const code: unknown = cause.Custom
    if (typeof code === 'number' || typeof code === 'bigint') {
      return { type: 'custom', code: Number(code) }
    }
  }
  return { type: 'unrecognised', error: cause }
}

type Parsed = ParsedSubscriptionsInstruction<string>

function parse(
  ix: LocatedInstruction,
): { ok: true; parsed: Parsed } | { ok: false; message: string } {
  try {
    return {
      ok: true,
      parsed: parseSubscriptionsInstruction({
        programAddress: ix.programAddress,
        accounts: ix.accounts,
        data: ix.data,
      }),
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** A charge attempt: which permission, which kind, how much. `null` for anything else. */
function chargeAttempt(
  parsed: Parsed,
): { allowance: Address; allowanceKind: AllowanceKind; attempted: bigint } | null {
  switch (parsed.instructionType) {
    case SubscriptionsInstruction.TransferSubscription:
      return {
        allowance: parsed.accounts.subscriptionPda.address,
        allowanceKind: 'subscription',
        attempted: parsed.data.transferData.amount,
      }
    case SubscriptionsInstruction.TransferRecurring:
      return {
        allowance: parsed.accounts.delegationPda.address,
        allowanceKind: 'recurring',
        attempted: parsed.data.transferData.amount,
      }
    case SubscriptionsInstruction.TransferFixed:
      return {
        allowance: parsed.accounts.delegationPda.address,
        allowanceKind: 'fixed',
        attempted: parsed.data.transferData.amount,
      }
    default:
      return null
  }
}

type Body = IndexedEvent extends infer E
  ? E extends unknown
    ? Omit<E, keyof Common>
    : never
  : never

/** Instructions that change a permission and emit no event. */
function fromInstruction(parsed: Parsed): Body | null {
  switch (parsed.instructionType) {
    case SubscriptionsInstruction.CreateFixedDelegation:
      return {
        kind: 'created',
        allowance: parsed.accounts.delegationAccount.address,
        allowanceKind: 'fixed',
        owner: parsed.accounts.delegator.address,
      }
    case SubscriptionsInstruction.CreateRecurringDelegation:
      return {
        kind: 'created',
        allowance: parsed.accounts.delegationAccount.address,
        allowanceKind: 'recurring',
        owner: parsed.accounts.delegator.address,
      }
    case SubscriptionsInstruction.RevokeDelegation:
      return { kind: 'revoked', allowance: parsed.accounts.delegationAccount.address }
    case SubscriptionsInstruction.RevokeAbandonedDelegation:
      return { kind: 'revoked', allowance: parsed.accounts.delegationAccount.address }
    case SubscriptionsInstruction.RevokeAbandonedSubscription:
      return { kind: 'revoked', allowance: parsed.accounts.subscriptionAccount.address }
    case SubscriptionsInstruction.CloseSubscriptionAuthority:
      return {
        kind: 'authority-closed',
        owner: parsed.accounts.user.address,
        authority: parsed.accounts.subscriptionAuthority.address,
      }
    case SubscriptionsInstruction.RevokeSubscriptionAuthority:
      return {
        kind: 'authority-closed',
        owner: parsed.accounts.user.address,
        authority: parsed.accounts.subscriptionAuthority.address,
      }
    default:
      return null
  }
}

async function subscriptionOf(event: { plan: Address; subscriber: Address }): Promise<Address> {
  return (await findSubscription({ planPda: event.plan, subscriber: event.subscriber })).address
}

async function fromEvent(event: ProgramEvent): Promise<Body> {
  switch (event.type) {
    case 'subscriptionCreated':
      return {
        kind: 'created',
        allowance: await subscriptionOf(event.data),
        allowanceKind: 'subscription',
        owner: event.data.subscriber,
      }
    case 'subscriptionCancelled':
      return {
        kind: 'cancelled',
        allowance: await subscriptionOf(event.data),
        chargesStopAt: event.data.expiresAtTs,
      }
    case 'subscriptionResumed':
      return { kind: 'resumed', allowance: await subscriptionOf(event.data) }
    case 'subscriptionTransfer':
      return {
        kind: 'charged',
        allowance: event.data.subscription,
        allowanceKind: 'subscription',
        amount: event.data.amount,
        receiver: event.data.receiver,
      }
    case 'recurringTransfer':
      return {
        kind: 'charged',
        allowance: event.data.delegation,
        allowanceKind: 'recurring',
        amount: event.data.amount,
        receiver: event.data.receiver,
      }
    case 'fixedTransfer':
      return {
        kind: 'charged',
        allowance: event.data.delegation,
        allowanceKind: 'fixed',
        amount: event.data.amount,
        receiver: event.data.receiver,
      }
    case 'planUpdated':
      return {
        kind: 'plan-updated',
        plan: event.data.plan,
        status: event.data.status,
        endTs: event.data.endTs,
        pullers: event.data.pullers,
      }
  }
}

function failedLine(program: string): string {
  return `Program ${program} failed`
}

const FAILED_LINE = /^Program (\S+) failed: /

/** The innermost program that failed: the runtime logs the failure from the inside out. */
export function failingProgram(logs: readonly string[]): Address | null {
  for (const line of logs) {
    const match = FAILED_LINE.exec(line)
    if (match?.[1] === undefined) continue
    try {
      return toAddress(match[1])
    } catch {
      return null
    }
  }
  return null
}

export async function decodeTransaction(
  tx: TransactionRecord,
  program: Address = PROGRAM_ADDRESS,
): Promise<DecodedTransaction> {
  const signature = tx.transaction.signatures[0]
  if (signature === undefined) throw new Error('transaction has no signature')
  const common = {
    signature,
    slot: BigInt(tx.slot),
    blockTime: tx.blockTime === null ? null : BigInt(tx.blockTime),
  }
  const logs = tx.meta?.logMessages ?? []
  const failed = tx.meta !== null && tx.meta.err !== null && tx.meta.err !== undefined
  const events: IndexedEvent[] = []
  const problems: DecodeProblem[] = []
  const ours = allInstructions(tx).filter((ix) => ix.programAddress === program)

  if (failed) {
    // A failed transaction changes nothing: events emitted before the failure
    // are rolled back with it. The only fact left is a refused charge.
    const error = readInstructionError(tx.meta?.err)
    if (error === null) return { ...common, failed, events, problems, logs }
    const inFailedInstruction = ours.filter((ix) => ix.outerIndex === error.instructionIndex)
    const direct = inFailedInstruction.find((ix) => !ix.inner)
    // Called through another program, the error still belongs to the outer
    // instruction — the failure is ours only if our program logged it.
    const refusedByUs =
      direct !== undefined || logs.some((line) => line.startsWith(failedLine(program)))
    for (const ix of inFailedInstruction) {
      const parsed = parse(ix)
      if (!parsed.ok) continue
      const attempt = chargeAttempt(parsed.parsed)
      if (attempt === null) continue
      if (!refusedByUs) {
        problems.push({
          type: 'unattributed-failure',
          instructionIndex: error.instructionIndex,
          failure: error.failure,
        })
        break
      }
      events.push({
        ...common,
        instructionIndex: error.instructionIndex,
        position: ix.position,
        kind: 'rejected',
        ...attempt,
        failure: error.failure,
        raisedBy: failingProgram(logs),
      })
    }
    return { ...common, failed, events, problems, logs }
  }

  for (const ix of ours) {
    const read = readProgramEvent(ix.data)
    if (read.status === 'event') {
      events.push({
        ...common,
        instructionIndex: ix.outerIndex,
        position: ix.position,
        ...(await fromEvent(read.event)),
      })
      continue
    }
    if (read.status === 'unreadable') {
      const { status: _status, ...unreadable } = read
      problems.push({ type: 'unreadable-event', instructionIndex: ix.outerIndex, ...unreadable })
      continue
    }
    const parsed = parse(ix)
    if (!parsed.ok) {
      problems.push({
        type: 'unparsable-instruction',
        instructionIndex: ix.outerIndex,
        message: parsed.message,
      })
      continue
    }
    const body = fromInstruction(parsed.parsed)
    if (body !== null) {
      events.push({ ...common, instructionIndex: ix.outerIndex, position: ix.position, ...body })
    }
  }
  return { ...common, failed, events, problems, logs }
}
