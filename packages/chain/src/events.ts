import type { Address, ReadonlyUint8Array } from '@solana/kit'
import {
  getAddressCodec,
  getArrayCodec,
  getI64Codec,
  getStructCodec,
  getU8Codec,
  getU64Codec,
} from '@solana/kit'

/**
 * Events of the Subscriptions program — what an indexer can learn from a
 * transaction that the transaction's accounts no longer say.
 *
 * **They are not in the logs.** The program never calls `msg!`; it emits each
 * event as a self-CPI to its own no-op `EmitEvent` instruction, signed by the
 * event authority PDA, the way Anchor's `emit_cpi!` does. The payload lives in
 * the inner instruction's data: an 8-byte tag, one discriminator byte, then the
 * packed (`#[repr(C, packed)]`) struct. So a `logsSubscribe` notification says
 * only that the program ran and whether it failed; the event itself needs the
 * transaction (`getTransaction`).
 *
 * `@solana/subscriptions@0.5.0` ships no event codecs, so they are written out
 * here from the program source (`program/src/events/*.rs`,
 * github.com/solana-foundation/subscriptions). Field order and widths are
 * pinned by golden bytes of real devnet transactions in `events.test.ts` — a
 * one-byte shift would not fail, it would read a plausible number from the
 * wrong field.
 */

/** `Sha256("anchor:event")[..8]`, the program's `EVENT_IX_TAG` in little-endian. */
export const EVENT_TAG: ReadonlyUint8Array = new Uint8Array([
  0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d,
])

/** Tag plus the discriminator byte. */
export const EVENT_HEADER_SIZE = EVENT_TAG.length + 1

/** Discriminator byte → event type, as `EventDiscriminators` in `event_engine.rs`. */
export const PROGRAM_EVENT_TYPES = [
  'subscriptionCreated',
  'subscriptionCancelled',
  'subscriptionTransfer',
  'fixedTransfer',
  'recurringTransfer',
  'subscriptionResumed',
  'planUpdated',
] as const

export type ProgramEventType = (typeof PROGRAM_EVENT_TYPES)[number]

export type SubscriptionCreatedEvent = {
  plan: Address
  subscriber: Address
  mint: Address
  createdTs: bigint
  payer: Address
}

/** `expiresAtTs` is the moment from which the program refuses every charge. */
export type SubscriptionCancelledEvent = {
  plan: Address
  subscriber: Address
  expiresAtTs: bigint
}

export type SubscriptionTransferEvent = {
  subscription: Address
  plan: Address
  delegator: Address
  mint: Address
  amount: bigint
  periodStartTs: bigint
  periodEndTs: bigint
  amountPulledInPeriod: bigint
  receiver: Address
  receiverTokenAccount: Address
  puller: Address
}

export type FixedTransferEvent = {
  delegation: Address
  delegator: Address
  delegatee: Address
  mint: Address
  amount: bigint
  remainingAmount: bigint
  receiver: Address
  receiverTokenAccount: Address
}

export type RecurringTransferEvent = {
  delegation: Address
  delegator: Address
  delegatee: Address
  mint: Address
  amount: bigint
  periodStartTs: bigint
  periodEndTs: bigint
  amountPulledInPeriod: bigint
  receiver: Address
  receiverTokenAccount: Address
}

export type SubscriptionResumedEvent = {
  plan: Address
  subscriber: Address
  resumedTs: bigint
}

/** Only the plan's mutable fields: amount and period cannot change after creation. */
export type PlanUpdatedEvent = {
  plan: Address
  owner: Address
  status: number
  endTs: bigint
  /** Always four slots; unused ones hold the default (all-zero) address. */
  pullers: Address[]
}

export type ProgramEvent =
  | { type: 'subscriptionCreated'; data: SubscriptionCreatedEvent }
  | { type: 'subscriptionCancelled'; data: SubscriptionCancelledEvent }
  | { type: 'subscriptionTransfer'; data: SubscriptionTransferEvent }
  | { type: 'fixedTransfer'; data: FixedTransferEvent }
  | { type: 'recurringTransfer'; data: RecurringTransferEvent }
  | { type: 'subscriptionResumed'; data: SubscriptionResumedEvent }
  | { type: 'planUpdated'; data: PlanUpdatedEvent }

const address = getAddressCodec()
const u64 = getU64Codec()
const i64 = getI64Codec()

// Each codec is fixed-size, and `fixedSize` is what the program calls `DATA_LEN`.
const CODECS = {
  subscriptionCreated: getStructCodec([
    ['plan', address],
    ['subscriber', address],
    ['mint', address],
    ['createdTs', i64],
    ['payer', address],
  ]),
  subscriptionCancelled: getStructCodec([
    ['plan', address],
    ['subscriber', address],
    ['expiresAtTs', i64],
  ]),
  subscriptionTransfer: getStructCodec([
    ['subscription', address],
    ['plan', address],
    ['delegator', address],
    ['mint', address],
    ['amount', u64],
    ['periodStartTs', i64],
    ['periodEndTs', i64],
    ['amountPulledInPeriod', u64],
    ['receiver', address],
    ['receiverTokenAccount', address],
    ['puller', address],
  ]),
  fixedTransfer: getStructCodec([
    ['delegation', address],
    ['delegator', address],
    ['delegatee', address],
    ['mint', address],
    ['amount', u64],
    ['remainingAmount', u64],
    ['receiver', address],
    ['receiverTokenAccount', address],
  ]),
  recurringTransfer: getStructCodec([
    ['delegation', address],
    ['delegator', address],
    ['delegatee', address],
    ['mint', address],
    ['amount', u64],
    ['periodStartTs', i64],
    ['periodEndTs', i64],
    ['amountPulledInPeriod', u64],
    ['receiver', address],
    ['receiverTokenAccount', address],
  ]),
  subscriptionResumed: getStructCodec([
    ['plan', address],
    ['subscriber', address],
    ['resumedTs', i64],
  ]),
  planUpdated: getStructCodec([
    ['plan', address],
    ['owner', address],
    ['status', getU8Codec()],
    ['endTs', i64],
    ['pullers', getArrayCodec(address, { size: 4 })],
  ]),
} as const satisfies Record<ProgramEventType, unknown>

/** Payload size of each event, without the header. */
export const PROGRAM_EVENT_SIZES = Object.fromEntries(
  PROGRAM_EVENT_TYPES.map((type) => [type, fixedSizeOf(CODECS[type])]),
) as Record<ProgramEventType, number>

function fixedSizeOf(codec: object): number {
  if (!('fixedSize' in codec) || typeof codec.fixedSize !== 'number') {
    throw new Error('event codec must be fixed-size')
  }
  return codec.fixedSize
}

/** Why bytes that start with the event tag still did not become an event. Never a silent skip. */
export type UnreadableEvent =
  | { reason: 'unknown-type'; discriminator: number }
  | { reason: 'length'; eventType: ProgramEventType; expected: number; actual: number }

export type EventReadResult =
  | { status: 'event'; event: ProgramEvent }
  /** Ordinary instruction data, not an event. */
  | { status: 'not-an-event' }
  | ({ status: 'unreadable' } & UnreadableEvent)

function startsWithTag(data: ReadonlyUint8Array): boolean {
  if (data.length < EVENT_HEADER_SIZE) return false
  return EVENT_TAG.every((byte, i) => data[i] === byte)
}

/**
 * Reads one inner instruction's data as an event.
 *
 * An unknown discriminator or a wrong length is `unreadable`, not
 * `not-an-event`: the tag says the program meant an event, so a newer program
 * version we cannot read yet must surface as a gap, not vanish.
 */
export function readProgramEvent(data: ReadonlyUint8Array): EventReadResult {
  if (!startsWithTag(data)) return { status: 'not-an-event' }
  const discriminator = data[EVENT_TAG.length] ?? -1
  const type = PROGRAM_EVENT_TYPES[discriminator]
  if (type === undefined) return { status: 'unreadable', reason: 'unknown-type', discriminator }
  const payload = data.slice(EVENT_HEADER_SIZE)
  const expected = PROGRAM_EVENT_SIZES[type]
  if (payload.length !== expected) {
    return {
      status: 'unreadable',
      reason: 'length',
      eventType: type,
      expected,
      actual: payload.length,
    }
  }
  return { status: 'event', event: decodePayload(type, payload) }
}

function decodePayload(type: ProgramEventType, payload: ReadonlyUint8Array): ProgramEvent {
  switch (type) {
    case 'subscriptionCreated':
      return { type, data: CODECS.subscriptionCreated.decode(payload) }
    case 'subscriptionCancelled':
      return { type, data: CODECS.subscriptionCancelled.decode(payload) }
    case 'subscriptionTransfer':
      return { type, data: CODECS.subscriptionTransfer.decode(payload) }
    case 'fixedTransfer':
      return { type, data: CODECS.fixedTransfer.decode(payload) }
    case 'recurringTransfer':
      return { type, data: CODECS.recurringTransfer.decode(payload) }
    case 'subscriptionResumed':
      return { type, data: CODECS.subscriptionResumed.decode(payload) }
    case 'planUpdated':
      return { type, data: CODECS.planUpdated.decode(payload) }
  }
}

function encodePayload(event: ProgramEvent): ReadonlyUint8Array {
  switch (event.type) {
    case 'subscriptionCreated':
      return CODECS.subscriptionCreated.encode(event.data)
    case 'subscriptionCancelled':
      return CODECS.subscriptionCancelled.encode(event.data)
    case 'subscriptionTransfer':
      return CODECS.subscriptionTransfer.encode(event.data)
    case 'fixedTransfer':
      return CODECS.fixedTransfer.encode(event.data)
    case 'recurringTransfer':
      return CODECS.recurringTransfer.encode(event.data)
    case 'subscriptionResumed':
      return CODECS.subscriptionResumed.encode(event.data)
    case 'planUpdated':
      return CODECS.planUpdated.encode(event.data)
  }
}

/**
 * Event → the exact bytes the program would emit. Used by round-trip tests and
 * by fixtures; nothing in production emits events.
 */
export function encodeProgramEvent(event: ProgramEvent): Uint8Array {
  const discriminator = PROGRAM_EVENT_TYPES.indexOf(event.type)
  const payload = encodePayload(event)
  const out = new Uint8Array(EVENT_HEADER_SIZE + payload.length)
  out.set(EVENT_TAG, 0)
  out[EVENT_TAG.length] = discriminator
  out.set(payload, EVENT_HEADER_SIZE)
  return out
}
