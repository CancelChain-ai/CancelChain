import { readFileSync } from 'node:fs'
import { encodeProgramEvent, findSubscription } from '@cancelchain/chain'
import { type Address, getBase58Decoder, getBase58Encoder } from '@solana/kit'
import {
  getCreateRecurringDelegationInstructionDataEncoder,
  getRevokeDelegationInstructionDataEncoder,
  getRevokeSubscriptionAuthorityInstructionDataEncoder,
  getTransferSubscriptionInstructionDataDecoder,
  SubscriptionsInstruction,
} from '@solana/subscriptions'
import { describe, expect, it } from 'vitest'
import {
  decodeTransaction,
  failingProgram,
  readInstructionError,
  type TransactionRecord,
} from './decode.js'

/**
 * Real devnet transactions, saved verbatim from `getTransaction`
 * (`encoding: 'json'`, `confirmed`). What each one did is known from outside
 * the decoder — the T028 devnet campaign (charge, over-cap, after-close) and
 * the live T037 subscribe and T037a cancel, whose accounts were read back.
 */
function fixture(name: string): TransactionRecord {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/devnet/${name}.json`, import.meta.url), 'utf8'),
  )
}

const PROGRAM = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44' as Address
const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR' as Address
const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg' as Address
const SUBSCRIPTION = 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2' as Address
/** The T028 recurring delegation, merchant-sim as delegatee. */
const DELEGATION = '3cNCoQXGZY87neBEvKQZArXnZnLkwTHUrb5Bt6qyB5zF' as Address
/** `CAP_PER_PERIOD` of `tests/fixtures/seed.ts`: 25 tokens of 6 decimals. */
const SEEDED_CAP = 25_000_000n
const MERCHANT_ATA = 'GAFkgwbddMnYYoiMWzP6A2NMuM6RSDkN6Kgi496GjGuq' as Address

describe('decodeTransaction — devnet', () => {
  it('subscribe: one created subscription, the authority init next to it is not an event', async () => {
    const decoded = await decodeTransaction(fixture('subscribe'))
    expect(decoded.failed).toBe(false)
    expect(decoded.problems).toEqual([])
    expect(decoded.events).toEqual([
      {
        signature:
          '4n43h2qHgmBYqFwJucz5S7T3rCZxDrkjnQWgDWvAdJ8gv2mR1gexjebRYAcTaLEFk2aT6Cw1TuJW8VBUFHaszsdo',
        slot: 505227603n,
        blockTime: 1790615256n,
        instructionIndex: 1,
        kind: 'created',
        allowance: SUBSCRIPTION,
        allowanceKind: 'subscription',
        owner: OWNER,
      },
    ])
  })

  it('cancel: the date charges stop, as T037a read it from the account', async () => {
    const decoded = await decodeTransaction(fixture('cancel-subscription'))
    expect(decoded.events).toMatchObject([
      { kind: 'cancelled', allowance: SUBSCRIPTION, chargesStopAt: 1793207256n },
    ])
  })

  it('charge: amount and receiver of a recurring charge', async () => {
    const decoded = await decodeTransaction(fixture('charge-recurring'))
    expect(decoded.events).toHaveLength(1)
    expect(decoded.events[0]).toMatchObject({
      kind: 'charged',
      allowance: DELEGATION,
      allowanceKind: 'recurring',
      receiver: expect.any(String),
    })
    const charged = decoded.events[0]
    if (charged?.kind !== 'charged') throw new Error('expected a charge')
    // `E2E_CHARGE_AMOUNT` of the T028 run: one token.
    expect(charged.amount).toBe(1_000_000n)
  })

  it('over the cap: a rejected attempt with the program code (400, AmountExceedsPeriodLimit)', async () => {
    const decoded = await decodeTransaction(fixture('reject-over-cap'))
    const charge = (await decodeTransaction(fixture('charge-recurring'))).events[0]
    if (charge?.kind !== 'charged') throw new Error('expected a charge')
    expect(decoded.failed).toBe(true)
    expect(decoded.events).toEqual([
      expect.objectContaining({
        kind: 'rejected',
        allowance: DELEGATION,
        allowanceKind: 'recurring',
        // T028 asked for one unit over what was left: the seeded cap (25 tokens,
        // `tests/fixtures/seed.ts`) minus the control charge.
        attempted: SEEDED_CAP - charge.amount + 1n,
        failure: { type: 'custom', code: 400 },
        raisedBy: PROGRAM,
      }),
    ])
  })

  it('after the permission is closed: rejected by the runtime, not by a program code', async () => {
    const decoded = await decodeTransaction(fixture('reject-after-close'))
    expect(decoded.events).toMatchObject([
      {
        kind: 'rejected',
        allowance: DELEGATION,
        failure: { type: 'runtime', name: 'InvalidAccountOwner' },
        raisedBy: PROGRAM,
      },
    ])
  })

  it('a refusal raised by the token program names it — code 1 is not the program’s own', async () => {
    // Someone else's subscription charge on devnet (2026-09-29): the token
    // program refused for lack of funds and this program passed `Custom 1` up.
    const decoded = await decodeTransaction(fixture('reject-token-insufficient-funds'))
    expect(decoded.events).toMatchObject([
      {
        kind: 'rejected',
        failure: { type: 'custom', code: 1 },
        raisedBy: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      },
    ])
  })

  it('a charge made by another program through CPI, in a version 1 transaction', async () => {
    // Someone else's integration on devnet (2026-09-29): program `LatBPQ…` calls
    // `transferSubscription` as an inner instruction. The expected values come
    // from that inner instruction, decoded by the SDK — not from the event.
    const tx = fixture('charge-via-cpi-v1')
    const keys = tx.transaction.message.accountKeys
    const transfer = (tx.meta?.innerInstructions ?? [])
      .flatMap((group) => group.instructions)
      .find(
        (ix) =>
          keys[Number(ix.programIdIndex)] === PROGRAM &&
          getBase58Encoder().encode(ix.data)[0] === SubscriptionsInstruction.TransferSubscription,
      )
    if (transfer === undefined) throw new Error('fixture has no inner transferSubscription')
    const data = getTransferSubscriptionInstructionDataDecoder().decode(
      getBase58Encoder().encode(transfer.data),
    )
    const decoded = await decodeTransaction(tx)
    expect(decoded.problems).toEqual([])
    expect(decoded.events).toMatchObject([
      {
        kind: 'charged',
        allowanceKind: 'subscription',
        allowance: keys[Number(transfer.accounts[0])],
        amount: data.transferData.amount,
        instructionIndex: 1,
      },
    ])
  })

  it('reads the same transaction the way @solana/kit returns it — integers as bigint', async () => {
    const plain = fixture('reject-over-cap')
    const lifted: TransactionRecord = {
      ...plain,
      slot: BigInt(plain.slot),
      blockTime: 1788381240n,
      // kit lifts the instruction index and the code; a `typeof === 'number'` check drops both.
      meta:
        plain.meta === null
          ? null
          : { ...plain.meta, err: { InstructionError: [0n, { Custom: 400n }] } },
    }
    expect(await decodeTransaction(lifted)).toEqual(await decodeTransaction(plain))
  })

  it('a failed transaction keeps none of its events — they were rolled back', async () => {
    const plain = fixture('subscribe')
    const failed: TransactionRecord = {
      ...plain,
      meta:
        plain.meta === null
          ? null
          : { ...plain.meta, err: { InstructionError: [1, { Custom: 519 }] } },
    }
    const decoded = await decodeTransaction(failed)
    expect(decoded.failed).toBe(true)
    // A refused subscribe is not a refused charge, and the "created" inside it never happened.
    expect(decoded.events).toEqual([])
  })
})

const base58 = getBase58Decoder()
const WALLET = 'SysvarC1ock11111111111111111111111111111111' as Address
const MERCHANT = 'SysvarRent111111111111111111111111111111111' as Address
const AUTHORITY = 'SysvarS1otHashes111111111111111111111111111' as Address
const MINT = 'So11111111111111111111111111111111111111112' as Address
const ROUTER = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address

type Ix = { program: Address; accounts: Address[]; data: Uint8Array }

/** A hand-built transaction: the first key signs, everything else is writable. */
function synthetic(input: {
  outer: Ix[]
  inner?: { index: number; instructions: Ix[] }[]
  err?: unknown
  logs?: string[]
}): TransactionRecord {
  const keys: Address[] = [WALLET]
  const indexOf = (key: Address): number => {
    const at = keys.indexOf(key)
    if (at !== -1) return at
    keys.push(key)
    return keys.length - 1
  }
  const compile = (ix: Ix) => ({
    programIdIndex: indexOf(ix.program),
    accounts: ix.accounts.map(indexOf),
    data: base58.decode(ix.data),
  })
  const instructions = input.outer.map(compile)
  const innerInstructions = (input.inner ?? []).map((group) => ({
    index: group.index,
    instructions: group.instructions.map(compile),
  }))
  return {
    slot: 1,
    blockTime: 2,
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: keys,
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 0,
        },
        instructions,
      },
    },
    meta: { err: input.err ?? null, logMessages: input.logs ?? [], innerInstructions },
  }
}

function emitted(event: Parameters<typeof encodeProgramEvent>[0]): Ix {
  return { program: PROGRAM, accounts: [AUTHORITY], data: encodeProgramEvent(event) }
}

describe('decodeTransaction — what emits no event', () => {
  it('closing a permission is "revoked", whatever kind it was', async () => {
    const decoded = await decodeTransaction(
      synthetic({
        outer: [
          {
            program: PROGRAM,
            accounts: [WALLET, DELEGATION],
            data: new Uint8Array(getRevokeDelegationInstructionDataEncoder().encode({})),
          },
        ],
      }),
    )
    expect(decoded.events).toMatchObject([{ kind: 'revoked', allowance: DELEGATION }])
  })

  it('creating a recurring delegation is "created" for the delegation account', async () => {
    const data = getCreateRecurringDelegationInstructionDataEncoder().encode({
      recurringDelegation: {
        nonce: 0,
        amountPerPeriod: 10,
        periodLengthS: 60,
        startTs: 0,
        expiryTs: 0,
        expectedSubscriptionAuthorityInitId: 0,
      },
    })
    const decoded = await decodeTransaction(
      synthetic({
        outer: [
          {
            program: PROGRAM,
            accounts: [WALLET, AUTHORITY, DELEGATION, MERCHANT, MINT],
            data: new Uint8Array(data),
          },
        ],
      }),
    )
    expect(decoded.events).toMatchObject([
      { kind: 'created', allowance: DELEGATION, allowanceKind: 'recurring', owner: WALLET },
    ])
  })

  it('closing the subscription authority is a wallet-wide event, not a permission one', async () => {
    const decoded = await decodeTransaction(
      synthetic({
        outer: [
          {
            program: PROGRAM,
            accounts: [WALLET, MERCHANT_ATA, MINT, ROUTER, AUTHORITY],
            data: new Uint8Array(getRevokeSubscriptionAuthorityInstructionDataEncoder().encode({})),
          },
        ],
      }),
    )
    expect(decoded.events).toMatchObject([
      { kind: 'authority-closed', owner: WALLET, authority: AUTHORITY },
    ])
  })
})

describe('decodeTransaction — calls through another program', () => {
  const plain = fixture('reject-over-cap')
  const transfer = plain.transaction.message.instructions[0]
  if (transfer === undefined) throw new Error('fixture has no instruction')
  const keys = plain.transaction.message.accountKeys as Address[]
  const transferIx: Ix = {
    program: PROGRAM,
    accounts: transfer.accounts.map((i) => keys[Number(i)] as Address),
    data: new Uint8Array(getBase58Encoder().encode(transfer.data)),
  }

  it('a charge refused inside a CPI is ours when our program logged the failure', async () => {
    const decoded = await decodeTransaction(
      synthetic({
        outer: [{ program: ROUTER, accounts: [], data: new Uint8Array([1]) }],
        inner: [{ index: 0, instructions: [transferIx] }],
        err: { InstructionError: [0, { Custom: 400 }] },
        logs: [
          `Program ${ROUTER} invoke [1]`,
          `Program ${PROGRAM} invoke [2]`,
          `Program ${PROGRAM} failed: custom program error: 0x190`,
          `Program ${ROUTER} failed: custom program error: 0x190`,
        ],
      }),
    )
    expect(decoded.events).toMatchObject([
      {
        kind: 'rejected',
        allowance: DELEGATION,
        failure: { type: 'custom', code: 400 },
        raisedBy: PROGRAM,
      },
    ])
  })

  it('without that log line the failure is named as unattributed, not guessed', async () => {
    const decoded = await decodeTransaction(
      synthetic({
        outer: [{ program: ROUTER, accounts: [], data: new Uint8Array([1]) }],
        inner: [{ index: 0, instructions: [transferIx] }],
        err: { InstructionError: [0, { Custom: 6000 }] },
        logs: [`Program ${ROUTER} failed: custom program error: 0x1770`],
      }),
    )
    expect(decoded.events).toEqual([])
    expect(decoded.problems).toEqual([
      {
        type: 'unattributed-failure',
        instructionIndex: 0,
        failure: { type: 'custom', code: 6000 },
      },
    ])
  })

  it('events emitted inside a CPI still count, attributed to the outer instruction', async () => {
    const decoded = await decodeTransaction(
      synthetic({
        outer: [{ program: ROUTER, accounts: [], data: new Uint8Array([1]) }],
        inner: [
          {
            index: 0,
            instructions: [
              emitted({
                type: 'subscriptionResumed',
                data: { plan: PLAN, subscriber: OWNER, resumedTs: 5n },
              }),
            ],
          },
        ],
      }),
    )
    const pda = (await findSubscription({ planPda: PLAN, subscriber: OWNER })).address
    expect(pda).toBe(SUBSCRIPTION)
    expect(decoded.events).toMatchObject([
      { kind: 'resumed', allowance: SUBSCRIPTION, instructionIndex: 0 },
    ])
  })
})

describe('decodeTransaction — nothing vanishes silently', () => {
  it('an event of a type we do not know is a problem, not a skip', async () => {
    const bytes = encodeProgramEvent({
      type: 'subscriptionResumed',
      data: { plan: PLAN, subscriber: OWNER, resumedTs: 5n },
    })
    bytes[8] = 9
    const decoded = await decodeTransaction(
      synthetic({ outer: [{ program: PROGRAM, accounts: [AUTHORITY], data: bytes }] }),
    )
    expect(decoded.events).toEqual([])
    expect(decoded.problems).toEqual([
      { type: 'unreadable-event', instructionIndex: 0, reason: 'unknown-type', discriminator: 9 },
    ])
  })

  it('an instruction the SDK cannot parse is a problem', async () => {
    const decoded = await decodeTransaction(
      synthetic({ outer: [{ program: PROGRAM, accounts: [], data: new Uint8Array([250]) }] }),
    )
    expect(decoded.problems).toMatchObject([
      { type: 'unparsable-instruction', instructionIndex: 0 },
    ])
  })

  it('without a failed line in the logs, who refused is unknown — not guessed', () => {
    expect(failingProgram([])).toBeNull()
    expect(failingProgram(['Log truncated'])).toBeNull()
    expect(failingProgram([`Program ${PROGRAM} failed: custom program error: 0x190`])).toBe(PROGRAM)
  })

  it('a failure that never reached an instruction belongs to no permission', () => {
    expect(readInstructionError('BlockhashNotFound')).toBeNull()
    expect(readInstructionError({ InsufficientFundsForRent: { account_index: 0 } })).toBeNull()
    expect(readInstructionError({ InstructionError: [2, { BorshIoError: 'x' }] })).toEqual({
      instructionIndex: 2,
      failure: { type: 'unrecognised', error: { BorshIoError: 'x' } },
    })
  })
})
