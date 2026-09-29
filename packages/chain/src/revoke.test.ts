import type { Address, Blockhash, Instruction } from '@solana/kit'
import {
  AccountRole,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit'
import {
  CANCEL_SUBSCRIPTION_DISCRIMINATOR,
  findEventAuthorityPda,
  getCancelSubscriptionInstructionDataDecoder,
  getRevokeDelegationInstructionDataDecoder,
  identifySubscriptionsInstruction,
  REVOKE_DELEGATION_DISCRIMINATOR,
  SubscriptionsInstruction,
  ZERO_ADDRESS,
} from '@solana/subscriptions'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ADDRESS } from './client.js'
import {
  buildCancelSubscriptionInstruction,
  buildCancelSubscriptionTransaction,
  buildRevokeInstruction,
  buildRevokeTransaction,
  buildRevokeTransactionMessage,
  REVOKE_TRANSACTION_VERSION,
  RevokeAlreadyCancelledError,
  RevokeAuthorityMismatchError,
  RevokeMissingPlanError,
  RevokeNotASubscriptionError,
  RevokePlanNotApplicableError,
  RevokeSubscriptionNotEndedError,
  type RevokeTarget,
  revokeActionFor,
  subscriptionCancelWindow,
} from './revoke.js'

const PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH' as Address
const OWNER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const STRANGER = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq' as Address
const PLAN_PDA = 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe' as Address
const RECEIVER = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' as Address

const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash
const LAST_VALID_BLOCK_HEIGHT = 492_096_495n
const LIFETIME = { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }

const FIXED: RevokeTarget = {
  kind: 'fixed',
  owner: OWNER,
  pda: PDA,
  planPda: null,
  endsAt: null,
}
const RECURRING: RevokeTarget = { ...FIXED, kind: 'recurring' }
/** Cancelled and past its date — the only state in which the program closes a subscription. */
const SUBSCRIPTION: RevokeTarget = {
  kind: 'subscription',
  owner: OWNER,
  pda: PDA,
  planPda: PLAN_PDA,
  endsAt: '2026-01-01T00:00:00.000Z',
}
const LIVE_SUBSCRIPTION: RevokeTarget = { ...SUBSCRIPTION, endsAt: null }

type PlainAccount = { address: Address; role: AccountRole }

/**
 * Акаунти без підписанта-заглушки. Саме в такому вигляді вони їдуть у мережу і
 * саме таким повертаються з розкомпіляції — інакше round-trip порівнював би
 * об'єкт із функціями, а не те, що бачить програма.
 */
function plainAccounts(instruction: Instruction): PlainAccount[] {
  const accounts = 'accounts' in instruction ? (instruction.accounts ?? []) : []
  return accounts.map((account) => ({ address: account.address, role: account.role }))
}

function instructionData(instruction: Instruction): Uint8Array {
  const { data } = instruction as { data?: Uint8Array }
  if (data === undefined) throw new Error('instruction carries no data')
  return data
}

describe('вибір інструкції', () => {
  it('це revokeDelegation — не cancelSubscription і не cancelSubscriptionNow', () => {
    for (const allowance of [FIXED, RECURRING, SUBSCRIPTION]) {
      const instruction = buildRevokeInstruction({ allowance, authority: OWNER })
      expect(identifySubscriptionsInstruction({ data: instructionData(instruction) })).toBe(
        SubscriptionsInstruction.RevokeDelegation,
      )
      expect(instructionData(instruction)).toEqual(Uint8Array.of(REVOKE_DELEGATION_DISCRIMINATOR))
    }
  })

  it('адреса програми — наша, і береться з SDK', () => {
    const instruction = buildRevokeInstruction({ allowance: FIXED, authority: OWNER })
    expect(instruction.programAddress).toBe(PROGRAM_ADDRESS)
  })

  it('тип дозволу не змінює інструкцію: fixed і recurring дають ту саму', () => {
    const fixed = buildRevokeInstruction({ allowance: FIXED, authority: OWNER })
    const recurring = buildRevokeInstruction({ allowance: RECURRING, authority: OWNER })
    expect(plainAccounts(fixed)).toEqual(plainAccounts(recurring))
    expect(instructionData(fixed)).toEqual(instructionData(recurring))
  })
})

describe('round-trip: закодував → декодував → рівність', () => {
  it('дані інструкції — самий дискримінатор, без прихованих аргументів', () => {
    const instruction = buildRevokeInstruction({ allowance: FIXED, authority: OWNER })
    const decoded = getRevokeDelegationInstructionDataDecoder().decode(instructionData(instruction))
    expect(decoded).toEqual({ discriminator: REVOKE_DELEGATION_DISCRIMINATOR })
  })

  /**
   * ⚠️ `lastValidBlockHeight` у байти **не їде**: у мережевому форматі його
   * немає, і `compileTransaction` тримає його лише на об'єкті транзакції. Тому
   * рівність тут перевіряється по тому, що справді перетинає межу, — а `T026`
   * мусить нести висоту блоку окремо, інакше підтвердження нема на чому чекати.
   */
  it('транзакція: байти → транзакція → рівність того, що їде в мережу', () => {
    const built = buildRevokeTransaction({
      allowance: SUBSCRIPTION,
      authority: OWNER,
      lifetime: LIFETIME,
    })
    const decoded = getTransactionDecoder().decode(
      getTransactionEncoder().encode(built.transaction),
    )
    expect(decoded.messageBytes).toEqual(built.transaction.messageBytes)
    expect(decoded.signatures).toEqual(built.transaction.signatures)
    expect(decoded).not.toHaveProperty('lifetimeConstraint')
    expect(built.wireTransaction).toEqual(getTransactionEncoder().encode(built.transaction))
  })

  it('повідомлення: скомпілював → розкомпілював → ті самі акаунти, платник і час життя', () => {
    const message = buildRevokeTransactionMessage({
      allowance: SUBSCRIPTION,
      authority: OWNER,
      lifetime: LIFETIME,
    })
    const { transaction } = buildRevokeTransaction({
      allowance: SUBSCRIPTION,
      authority: OWNER,
      lifetime: LIFETIME,
    })
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
    const back = decompileTransactionMessage(compiled, {
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    })

    expect(back.version).toBe(REVOKE_TRANSACTION_VERSION)
    expect(back.feePayer.address).toBe(OWNER)
    expect(back.lifetimeConstraint).toEqual(LIFETIME)
    expect(back.instructions).toHaveLength(1)

    const [source] = message.instructions
    const [returned] = back.instructions
    if (source === undefined || returned === undefined) throw new Error('no instruction')
    expect(returned.programAddress).toBe(source.programAddress)
    expect(instructionData(returned)).toEqual(instructionData(source))
    expect(plainAccounts(returned)).toEqual(plainAccounts(source))
  })
})

describe('незаповнені поля лишаються незаповненими', () => {
  it('без receiver причіпного акаунта немає — ні порожнього, ні нульового', () => {
    const instruction = buildRevokeInstruction({ allowance: FIXED, authority: OWNER })
    expect(plainAccounts(instruction)).toEqual([
      { address: OWNER, role: AccountRole.WRITABLE_SIGNER },
      { address: PDA, role: AccountRole.WRITABLE },
    ])
  })

  it('нульова адреса не з’являється в жодному складі акаунтів', () => {
    const inputs = [
      { allowance: FIXED, authority: OWNER },
      { allowance: FIXED, authority: OWNER, receiver: RECEIVER },
      { allowance: SUBSCRIPTION, authority: OWNER },
      { allowance: SUBSCRIPTION, authority: OWNER, receiver: RECEIVER },
    ]
    for (const input of inputs) {
      const addresses = plainAccounts(buildRevokeInstruction(input)).map((a) => a.address)
      expect(addresses).not.toContain(ZERO_ADDRESS)
    }
  })

  it('відсутність receiver переживає round-trip через мережевий формат', () => {
    const { transaction, message } = buildRevokeTransaction({
      allowance: FIXED,
      authority: OWNER,
      lifetime: LIFETIME,
    })
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
    const back = decompileTransactionMessage(compiled, {
      lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT,
    })
    const [returned] = back.instructions
    const [source] = message.instructions
    if (returned === undefined || source === undefined) throw new Error('no instruction')
    expect(plainAccounts(returned)).toHaveLength(2)
    expect(plainAccounts(returned)).toEqual(plainAccounts(source))
  })

  it('заданий receiver їде причіпним writable-акаунтом', () => {
    const instruction = buildRevokeInstruction({
      allowance: FIXED,
      authority: OWNER,
      receiver: RECEIVER,
    })
    expect(plainAccounts(instruction)).toEqual([
      { address: OWNER, role: AccountRole.WRITABLE_SIGNER },
      { address: PDA, role: AccountRole.WRITABLE },
      { address: RECEIVER, role: AccountRole.WRITABLE },
    ])
  })
})

describe('підписка возить план причіпним акаунтом', () => {
  it('план — третій акаунт, тільки для читання', () => {
    const instruction = buildRevokeInstruction({ allowance: SUBSCRIPTION, authority: OWNER })
    expect(plainAccounts(instruction)).toEqual([
      { address: OWNER, role: AccountRole.WRITABLE_SIGNER },
      { address: PDA, role: AccountRole.WRITABLE },
      { address: PLAN_PDA, role: AccountRole.READONLY },
    ])
  })

  it('порядок причіпних акаунтів — план, потім receiver', () => {
    const instruction = buildRevokeInstruction({
      allowance: SUBSCRIPTION,
      authority: OWNER,
      receiver: RECEIVER,
    })
    expect(plainAccounts(instruction)).toEqual([
      { address: OWNER, role: AccountRole.WRITABLE_SIGNER },
      { address: PDA, role: AccountRole.WRITABLE },
      { address: PLAN_PDA, role: AccountRole.READONLY },
      { address: RECEIVER, role: AccountRole.WRITABLE },
    ])
  })
})

describe('розбіжності називаються до підпису', () => {
  it('чужий гаманець не підписує чужий дозвіл', () => {
    expect(() => buildRevokeInstruction({ allowance: FIXED, authority: STRANGER })).toThrow(
      RevokeAuthorityMismatchError,
    )
  })

  it('підписка без плану не будується', () => {
    expect(() =>
      buildRevokeInstruction({
        allowance: { ...SUBSCRIPTION, planPda: null },
        authority: OWNER,
      }),
    ).toThrow(RevokeMissingPlanError)
  })

  it('план на дозволі поза планом не ковтається мовчки', () => {
    expect(() =>
      buildRevokeInstruction({
        allowance: { ...FIXED, planPda: PLAN_PDA },
        authority: OWNER,
      }),
    ).toThrow(RevokePlanNotApplicableError)
  })

  it('зіпсована адреса падає тут, а не запитом до мережі', () => {
    expect(() =>
      buildRevokeInstruction({ allowance: { ...FIXED, pda: 'not-an-address' }, authority: OWNER }),
    ).toThrow()
  })
})

describe('транзакція під один підпис', () => {
  it('рівно одна інструкція і рівно одне місце під підпис', () => {
    const { message, transaction } = buildRevokeTransaction({
      allowance: SUBSCRIPTION,
      authority: OWNER,
      lifetime: LIFETIME,
    })
    expect(message.instructions).toHaveLength(1)
    expect(Object.keys(transaction.signatures)).toEqual([OWNER])
    expect(transaction.signatures[OWNER]).toBeNull()
  })

  it('base64 і байти описують ту саму транзакцію', () => {
    const built = buildRevokeTransaction({
      allowance: FIXED,
      authority: OWNER,
      lifetime: LIFETIME,
    })
    expect(Buffer.from(built.wireTransaction).toString('base64')).toBe(built.wireTransactionBase64)
  })
})

describe('revokeActionFor — which of the two subscription actions is due (T037a)', () => {
  const now = new Date('2026-09-29T12:00:00.000Z')

  it('a delegation closes at any time, whatever endsAt says', () => {
    expect(revokeActionFor(FIXED, now)).toEqual({ kind: 'close' })
    expect(revokeActionFor(RECURRING, now)).toEqual({ kind: 'close' })
  })

  it('a live subscription is cancelled first, not closed', () => {
    expect(revokeActionFor(LIVE_SUBSCRIPTION, now)).toEqual({ kind: 'cancel-subscription' })
  })

  it('a cancelled subscription inside its period has nothing to sign until its date', () => {
    const endsAt = '2026-10-28T17:07:36.000Z'
    expect(revokeActionFor({ ...SUBSCRIPTION, endsAt }, now)).toEqual({
      kind: 'wait',
      until: new Date(endsAt),
    })
  })

  it('closes at the date itself — the program allows it once expiresAtTs <= now', () => {
    expect(revokeActionFor({ ...SUBSCRIPTION, endsAt: now.toISOString() }, now)).toEqual({
      kind: 'close',
    })
  })
})

describe('closing a subscription is refused before the signature, not with Custom 510', () => {
  it('never cancelled', () => {
    expect(() =>
      buildRevokeInstruction({ allowance: LIVE_SUBSCRIPTION, authority: OWNER }),
    ).toThrow(RevokeSubscriptionNotEndedError)
  })

  it('cancelled, period still running — the error carries the date', () => {
    const endsAt = '2026-10-28T17:07:36.000Z'
    const now = new Date('2026-10-28T17:07:35.000Z')
    const attempt = () =>
      buildRevokeInstruction({ allowance: { ...SUBSCRIPTION, endsAt }, authority: OWNER, now })
    expect(attempt).toThrow(RevokeSubscriptionNotEndedError)
    expect(attempt).toThrow(endsAt)
  })

  it('builds at the date itself', () => {
    const endsAt = '2026-10-28T17:07:36.000Z'
    const instruction = buildRevokeInstruction({
      allowance: { ...SUBSCRIPTION, endsAt },
      authority: OWNER,
      now: new Date(endsAt),
    })
    expect(instructionData(instruction)).toEqual(Uint8Array.of(REVOKE_DELEGATION_DISCRIMINATOR))
  })
})

describe('buildCancelSubscriptionInstruction — round-trip', () => {
  it('is cancelSubscription (12): not revokeDelegation, not cancelSubscriptionNow', async () => {
    const instruction = await buildCancelSubscriptionInstruction({
      allowance: LIVE_SUBSCRIPTION,
      authority: OWNER,
    })
    expect(identifySubscriptionsInstruction({ data: instructionData(instruction) })).toBe(
      SubscriptionsInstruction.CancelSubscription,
    )
    expect(instruction.programAddress).toBe(PROGRAM_ADDRESS)
  })

  it('data is the discriminator and nothing else — there is no field to leave empty', async () => {
    const instruction = await buildCancelSubscriptionInstruction({
      allowance: LIVE_SUBSCRIPTION,
      authority: OWNER,
    })
    const data = instructionData(instruction)
    expect(data).toEqual(Uint8Array.of(CANCEL_SUBSCRIPTION_DISCRIMINATOR))
    expect(getCancelSubscriptionInstructionDataDecoder().decode(data)).toEqual({
      discriminator: CANCEL_SUBSCRIPTION_DISCRIMINATOR,
    })
  })

  it('accounts in program order: subscriber, plan, subscription, event authority, program', async () => {
    const instruction = await buildCancelSubscriptionInstruction({
      allowance: LIVE_SUBSCRIPTION,
      authority: OWNER,
    })
    const [eventAuthority] = await findEventAuthorityPda()
    expect(plainAccounts(instruction)).toEqual([
      { address: OWNER, role: AccountRole.READONLY_SIGNER },
      { address: PLAN_PDA, role: AccountRole.READONLY },
      { address: PDA, role: AccountRole.WRITABLE },
      { address: eventAuthority, role: AccountRole.READONLY },
      { address: PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ])
    expect(plainAccounts(instruction).map((a) => a.address)).not.toContain(ZERO_ADDRESS)
  })

  it('compiled → decompiled: the same instruction, the owner pays and is the only signer', async () => {
    const built = await buildCancelSubscriptionTransaction({
      allowance: LIVE_SUBSCRIPTION,
      authority: OWNER,
      lifetime: LIFETIME,
    })
    const back = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(built.transaction.messageBytes),
      { lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT },
    )
    expect(back.version).toBe(REVOKE_TRANSACTION_VERSION)
    expect(back.feePayer.address).toBe(OWNER)
    expect(back.lifetimeConstraint).toEqual(LIFETIME)
    expect(back.instructions).toHaveLength(1)

    const [source] = built.message.instructions
    const [returned] = back.instructions
    if (source === undefined || returned === undefined) throw new Error('no instruction')
    expect(instructionData(returned)).toEqual(instructionData(source))
    // The fee payer is writable in the message, so the compiler widens the
    // subscriber's read-only signer role; every other role survives unchanged.
    const widened = plainAccounts(source).map((account) =>
      account.address === OWNER ? { ...account, role: AccountRole.WRITABLE_SIGNER } : account,
    )
    expect(plainAccounts(returned)).toEqual(widened)
    expect(Object.keys(built.transaction.signatures)).toEqual([OWNER])
    expect(built.transaction.signatures[OWNER]).toBeNull()
    expect(Buffer.from(built.wireTransaction).toString('base64')).toBe(built.wireTransactionBase64)
  })

  it('refuses what the program would refuse after the signature', async () => {
    await expect(
      buildCancelSubscriptionInstruction({ allowance: RECURRING, authority: OWNER }),
    ).rejects.toThrow(RevokeNotASubscriptionError)
    await expect(
      buildCancelSubscriptionInstruction({ allowance: LIVE_SUBSCRIPTION, authority: STRANGER }),
    ).rejects.toThrow(RevokeAuthorityMismatchError)
    await expect(
      buildCancelSubscriptionInstruction({
        allowance: { ...LIVE_SUBSCRIPTION, planPda: null },
        authority: OWNER,
      }),
    ).rejects.toThrow(RevokeMissingPlanError)
    await expect(
      buildCancelSubscriptionInstruction({ allowance: SUBSCRIPTION, authority: OWNER }),
    ).rejects.toThrow(RevokeAlreadyCancelledError)
  })
})

describe('subscriptionCancelWindow — mirrors cancel_subscription.rs', () => {
  // Subscription CKjAhy… on devnet as read 2026-09-29: a 720 h plan, nothing pulled yet.
  const PERIOD = 720 * 3_600
  const START_TS = 1_790_615_256
  const base = {
    periodSeconds: PERIOD,
    periodStartedAt: new Date(START_TS * 1000),
    cap: 9_990_000n,
  }
  const at = (ts: number) => new Date(ts * 1000)

  it('inside the recorded period: ends at its end, and what was pulled counts', () => {
    const window = subscriptionCancelWindow(
      { ...base, spentInPeriod: 4_000_000n },
      at(1_790_688_118),
    )
    expect(window.endsNoLaterThan).toEqual(at(START_TS + PERIOD))
    expect(window.currentPeriodStartedAt).toEqual(at(START_TS))
    expect(window.chargedThisPeriod).toBe(4_000_000n)
    expect(window.stillChargeable).toBe(5_990_000n)
  })

  it('recorded period already over: the next boundary, and the old pull does not count', () => {
    const window = subscriptionCancelWindow(
      { ...base, spentInPeriod: 9_990_000n },
      at(START_TS + 2 * PERIOD + 60),
    )
    expect(window.endsNoLaterThan).toEqual(at(START_TS + 3 * PERIOD))
    expect(window.currentPeriodStartedAt).toEqual(at(START_TS + 2 * PERIOD))
    expect(window.chargedThisPeriod).toBe(0n)
    expect(window.stillChargeable).toBe(9_990_000n)
  })

  it('exactly at a boundary the new period has begun (integer division, as on chain)', () => {
    const window = subscriptionCancelWindow({ ...base, spentInPeriod: 1n }, at(START_TS + PERIOD))
    expect(window.endsNoLaterThan).toEqual(at(START_TS + 2 * PERIOD))
    expect(window.chargedThisPeriod).toBe(0n)
  })

  it('a pull above the cap never yields a negative remainder', () => {
    const window = subscriptionCancelWindow(
      { ...base, spentInPeriod: 10_000_000n },
      at(1_790_688_118),
    )
    expect(window.stillChargeable).toBe(0n)
  })

  it('refuses a period the program could not have', () => {
    expect(() =>
      subscriptionCancelWindow({ ...base, periodSeconds: 0, spentInPeriod: 0n }),
    ).toThrow(RangeError)
  })
})
