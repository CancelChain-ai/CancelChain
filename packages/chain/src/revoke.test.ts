import type { Address, Blockhash, Instruction } from '@solana/kit'
import {
  AccountRole,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit'
import {
  getRevokeDelegationInstructionDataDecoder,
  identifySubscriptionsInstruction,
  REVOKE_DELEGATION_DISCRIMINATOR,
  SubscriptionsInstruction,
  ZERO_ADDRESS,
} from '@solana/subscriptions'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ADDRESS } from './client.js'
import {
  buildRevokeInstruction,
  buildRevokeTransaction,
  buildRevokeTransactionMessage,
  REVOKE_TRANSACTION_VERSION,
  RevokeAuthorityMismatchError,
  RevokeMissingPlanError,
  RevokePlanNotApplicableError,
  type RevokeTarget,
} from './revoke.js'

const PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH' as Address
const OWNER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const STRANGER = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq' as Address
const PLAN_PDA = 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe' as Address
const RECEIVER = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' as Address

const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash
const LAST_VALID_BLOCK_HEIGHT = 492_096_495n
const LIFETIME = { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }

const FIXED: RevokeTarget = { kind: 'fixed', owner: OWNER, pda: PDA, planPda: null }
const RECURRING: RevokeTarget = { kind: 'recurring', owner: OWNER, pda: PDA, planPda: null }
const SUBSCRIPTION: RevokeTarget = {
  kind: 'subscription',
  owner: OWNER,
  pda: PDA,
  planPda: PLAN_PDA,
}

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
