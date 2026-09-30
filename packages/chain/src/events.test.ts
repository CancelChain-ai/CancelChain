import type { Address } from '@solana/kit'
import { getBase58Encoder } from '@solana/kit'
import { getTransferRecurringInstructionDataDecoder } from '@solana/subscriptions'
import { describe, expect, it } from 'vitest'
import {
  EVENT_HEADER_SIZE,
  EVENT_TAG,
  encodeProgramEvent,
  PROGRAM_EVENT_SIZES,
  PROGRAM_EVENT_TYPES,
  type ProgramEvent,
  readProgramEvent,
} from './events.js'

const base58 = getBase58Encoder()

/**
 * Inner-instruction data of three real devnet transactions (2026-09), copied
 * byte for byte from `getTransaction`. Every expected value below comes from
 * somewhere other than our decoder: the account state read back after the
 * transaction, the transaction's own `blockTime`, or its outer instruction
 * decoded by the SDK.
 */
const DEVNET = {
  /** Owner `CuXtQL…` subscribes to plan `EwH6mq…` — tx `4n43h2qH…`, blockTime 1790615256. */
  subscriptionCreated:
    'yCGxBopjnVMwsFDc8vPKPtFD6rP7vNcjBcQgXU8efx9j4pnUCouq8K8vkefoMcBSz347NN7bu5XZkfLR7tEZdeCUR5wQGts7cvfyckjQngyVM1Yov9zwNZnNeNA3ippSX6GAVQEp33Vxi49by9Fk8wAHFTUnn9uUzPELzj3Cax2YNxoLUPTkP82m3xn53ygYdaMSvR',
  /** The same subscription cancelled from the UI in T037a — tx `4aFvLqyd…`. */
  subscriptionCancelled:
    'Byo2ZrbHgYrMpJiQpvP3YcRdFykdNLH5rgnGci9rRhXnUYzCM5XjmdoCXzx2gatGwf69YVPw75RqQUMFGmPYPGmgsYBc3RSJmeaywbyoKotuSDu',
  /** The T028 control charge on a recurring delegation — tx `2942wYGG…`. */
  recurringTransfer:
    '2zjR1PvPvgqbVrtyXQjww5GZ8xw6tHQqBZKc6f3LQBsoPzgugZv2mfCauVs82ydxvPL382xD7YFpWMCnZvnsc9DM88ZRD9vau4hX2wJpz3ipAA8CvyUQDoPWGvw7xMRQp2CfBhwANFjak9gi9SKUPWz2SAbkmLYqzGENDDmmBisdQL8ZeoWTqXYMm1bMwuAGKsbPELpgnPUooLQFAUG2jg7942JhnmvDALM4nH334AvUfVwY6YehiXYUHpWeVckotRKYdDDGqdXayDPRH1NdxeGWzrrqpLMtnDvsqoWmeB8zfNSaxDquzhnrjD4RKYw',
  /** Outer `transferRecurring` instruction of that same charge. */
  recurringTransferInstruction:
    'LqpALZRqSRqVa5dbPLHSiDt9GNtVZKLeufKHoHFSBAf1yo98CHUccQCwrsMqNabPZJyZpnSQQaYPDmrFvGr7XZzFyvzx1opfN9Q',
} as const

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR' as Address
const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg' as Address
const MERCHANT = 'FGHMNoGvR5zP9K5Cs4XrwZhQnAxNrFEQYH3TK22fBkKF' as Address
const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address

function read(encoded: string): ProgramEvent {
  const result = readProgramEvent(base58.encode(encoded))
  if (result.status !== 'event') throw new Error(`expected an event, got ${result.status}`)
  return result.event
}

describe('program events — golden bytes from devnet', () => {
  it('reads subscriptionCreated with the creation time the block carries', () => {
    const event = read(DEVNET.subscriptionCreated)
    expect(event).toEqual({
      type: 'subscriptionCreated',
      data: {
        plan: PLAN,
        subscriber: OWNER,
        mint: USDC_DEVNET,
        createdTs: 1790615256n,
        payer: OWNER,
      },
    })
  })

  it('reads subscriptionCancelled with the date T037a recorded on chain', () => {
    // 1793207256 = 2026-10-28 17:07:36 UTC, read from the account after the cancel.
    expect(read(DEVNET.subscriptionCancelled)).toEqual({
      type: 'subscriptionCancelled',
      data: { plan: PLAN, subscriber: OWNER, expiresAtTs: 1793207256n },
    })
  })

  it('reads recurringTransfer consistently with the instruction that caused it', () => {
    const event = read(DEVNET.recurringTransfer)
    if (event.type !== 'recurringTransfer') throw new Error(event.type)
    const instruction = getTransferRecurringInstructionDataDecoder().decode(
      base58.encode(DEVNET.recurringTransferInstruction),
    )
    expect(event.data.amount).toBe(instruction.transferData.amount)
    expect(event.data.delegator).toBe(instruction.transferData.delegator)
    expect(event.data.mint).toBe(instruction.transferData.mint)
    expect(event.data.delegation).toBe('3cNCoQXGZY87neBEvKQZArXnZnLkwTHUrb5Bt6qyB5zF')
    expect(event.data.delegatee).toBe(MERCHANT)
    expect(event.data.receiverTokenAccount).toBe('GAFkgwbddMnYYoiMWzP6A2NMuM6RSDkN6Kgi496GjGuq')
    // First charge of the period: everything pulled so far is this charge.
    expect(event.data.amountPulledInPeriod).toBe(event.data.amount)
    expect(event.data.periodEndTs).toBeGreaterThan(event.data.periodStartTs)
  })
})

describe('program events — sizes match the program', () => {
  it('has the DATA_LEN of every struct in program/src/events', () => {
    // 32-byte addresses, 8-byte integers, one u8 in planUpdated; no padding (repr(C, packed)).
    expect(PROGRAM_EVENT_SIZES).toEqual({
      subscriptionCreated: 32 * 4 + 8,
      subscriptionCancelled: 32 * 2 + 8,
      subscriptionTransfer: 32 * 7 + 8 * 4,
      fixedTransfer: 32 * 6 + 8 * 2,
      recurringTransfer: 32 * 6 + 8 * 4,
      subscriptionResumed: 32 * 2 + 8,
      planUpdated: 32 * 2 + 1 + 8 + 32 * 4,
    })
  })
})

const A = 'SysvarC1ock11111111111111111111111111111111' as Address
const B = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
const C = '11111111111111111111111111111111' as Address

const SAMPLES: ProgramEvent[] = [
  {
    type: 'subscriptionCreated',
    data: { plan: A, subscriber: B, mint: C, createdTs: 1n, payer: A },
  },
  { type: 'subscriptionCancelled', data: { plan: A, subscriber: B, expiresAtTs: -1n } },
  {
    type: 'subscriptionTransfer',
    data: {
      subscription: A,
      plan: B,
      delegator: C,
      mint: A,
      amount: 2n ** 64n - 1n,
      periodStartTs: 3n,
      periodEndTs: 4n,
      amountPulledInPeriod: 5n,
      receiver: B,
      receiverTokenAccount: C,
      puller: A,
    },
  },
  {
    type: 'fixedTransfer',
    data: {
      delegation: A,
      delegator: B,
      delegatee: C,
      mint: A,
      amount: 6n,
      remainingAmount: 0n,
      receiver: B,
      receiverTokenAccount: C,
    },
  },
  {
    type: 'recurringTransfer',
    data: {
      delegation: A,
      delegator: B,
      delegatee: C,
      mint: A,
      amount: 7n,
      periodStartTs: 8n,
      periodEndTs: 9n,
      amountPulledInPeriod: 0n,
      receiver: B,
      receiverTokenAccount: C,
    },
  },
  { type: 'subscriptionResumed', data: { plan: A, subscriber: B, resumedTs: 10n } },
  {
    type: 'planUpdated',
    data: { plan: A, owner: B, status: 2, endTs: 0n, pullers: [A, B, C, C] },
  },
]

describe('program events — round trip', () => {
  it('covers every event type', () => {
    expect(SAMPLES.map((sample) => sample.type)).toEqual([...PROGRAM_EVENT_TYPES])
  })

  it.each(SAMPLES)('$type: encode → read gives the same event, zeros included', (sample) => {
    const bytes = encodeProgramEvent(sample)
    expect(bytes.slice(0, EVENT_TAG.length)).toEqual(new Uint8Array(EVENT_TAG))
    expect(bytes[EVENT_TAG.length]).toBe(PROGRAM_EVENT_TYPES.indexOf(sample.type))
    expect(bytes.length).toBe(EVENT_HEADER_SIZE + PROGRAM_EVENT_SIZES[sample.type])
    expect(readProgramEvent(bytes)).toEqual({ status: 'event', event: sample })
  })
})

describe('program events — what is not an event', () => {
  it('treats ordinary instruction data as not-an-event', () => {
    expect(readProgramEvent(base58.encode(DEVNET.recurringTransferInstruction))).toEqual({
      status: 'not-an-event',
    })
    expect(readProgramEvent(new Uint8Array([12]))).toEqual({ status: 'not-an-event' })
  })

  it('names an unknown discriminator instead of dropping it', () => {
    const bytes = encodeProgramEvent(SAMPLES[1] as ProgramEvent)
    bytes[EVENT_TAG.length] = 7
    expect(readProgramEvent(bytes)).toEqual({
      status: 'unreadable',
      reason: 'unknown-type',
      discriminator: 7,
    })
  })

  it('names a payload of the wrong length instead of reading a shifted field', () => {
    const bytes = encodeProgramEvent(SAMPLES[1] as ProgramEvent)
    const extended = new Uint8Array(bytes.length + 1)
    extended.set(bytes)
    expect(readProgramEvent(extended)).toEqual({
      status: 'unreadable',
      reason: 'length',
      eventType: 'subscriptionCancelled',
      expected: 72,
      actual: 73,
    })
    expect(readProgramEvent(bytes.slice(0, -1))).toMatchObject({ reason: 'length', actual: 71 })
  })
})
