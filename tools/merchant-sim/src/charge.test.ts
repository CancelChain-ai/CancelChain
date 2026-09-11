import { createChainClient, findSubscriptionAuthority, PROGRAM_ADDRESS } from '@cancelchain/chain'
import type { Allowance } from '@cancelchain/shared'
import { U64_MAX } from '@cancelchain/shared'
import type { Address, Blockhash, Instruction, Signature, TransactionSigner } from '@solana/kit'
import {
  createNoopSigner,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit'
import {
  identifySubscriptionsInstruction,
  parseTransferFixedInstruction,
  parseTransferRecurringInstruction,
  parseTransferSubscriptionInstruction,
  SubscriptionsInstruction,
  ZERO_ADDRESS,
} from '@solana/subscriptions'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  attemptCharge,
  buildChargeInstruction,
  buildChargeTransaction,
  CHARGE_TRANSACTION_VERSION,
  ChargeAmountError,
  ChargeDelegateMismatchError,
  ChargeMintNotFoundError,
  ChargeMissingPlanError,
  ChargePlanAddressMismatchError,
  ChargePlanNotApplicableError,
  type ChargeRpc,
  type ChargeTarget,
  ChargeTargetError,
  chargeTarget,
  chargeTargetFromAllowance,
  chargeTargetFromFields,
  describeVerdict,
  type MintOwnerRpc,
  programErrorCodeOf,
  rejectionReasonKey,
  resolveTokenProgram,
  runtimeErrorLabelOf,
} from './charge.js'

const PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH' as Address
const OWNER = '4DYhzGx6zWLmFDCBLJfCyRpTBnJnbfLqzHz7BvUJBFHU' as Address
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const PLAN_PDA = 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe' as Address
const STRANGER = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq' as Address
const OTHER_ATA = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' as Address

const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash
const LAST_VALID_BLOCK_HEIGHT = 492_096_495n
const LIFETIME = { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }

const AMOUNT = 12_500_000n

/** Мерчант із справжнім ключем — інакше транзакцію нічим підписати. */
let merchant: TransactionSigner

beforeAll(async () => {
  merchant = await generateKeyPairSigner()
})

function fixed(): ChargeTarget {
  return {
    delegate: merchant.address,
    kind: 'fixed',
    mint: MINT,
    owner: OWNER,
    pda: PDA,
    planPda: null,
  }
}

function recurring(): ChargeTarget {
  return { ...fixed(), kind: 'recurring' }
}

/** У підписки `header.delegatee` — це адреса плану (знахідка `T019`). */
function subscription(): ChargeTarget {
  return {
    delegate: PLAN_PDA,
    kind: 'subscription',
    mint: MINT,
    owner: OWNER,
    pda: PDA,
    planPda: PLAN_PDA,
  }
}

const build = (allowance: ChargeTarget, extra: { amount?: bigint; receiverAta?: string } = {}) =>
  buildChargeInstruction({
    allowance,
    amount: extra.amount ?? AMOUNT,
    merchant,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    ...(extra.receiverAta === undefined ? {} : { receiverAta: extra.receiverAta }),
  })

async function ata(owner: Address): Promise<Address> {
  const [address] = await findAssociatedTokenPda({
    mint: MINT,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  })
  return address
}

type PlainAccount = { address: Address; role: number }

function plainAccounts(instruction: Instruction): PlainAccount[] {
  const accounts = 'accounts' in instruction ? (instruction.accounts ?? []) : []
  return accounts.map((account) => ({ address: account.address, role: account.role }))
}

/**
 * Звуження до форми, яку приймають `parse*Instruction` із SDK.
 *
 * Потрібне тому, що `Instruction` у kit допускає акаунти з таблиць адрес, а
 * розбірники — ні. Наші інструкції таких акаунтів не мають за побудовою
 * (жодного `AddressLookupTable` у білдері немає), тож перевіряється рівно те,
 * що робить приведення чесним: акаунти й дані на місці.
 */
type ParsableInstruction = Parameters<typeof parseTransferFixedInstruction>[0]

function parsable(instruction: Instruction): ParsableInstruction {
  if (!('accounts' in instruction) || instruction.accounts === undefined) {
    throw new Error('instruction carries no accounts')
  }
  if (!('data' in instruction) || instruction.data === undefined) {
    throw new Error('instruction carries no data')
  }
  return instruction as ParsableInstruction
}

function instructionData(instruction: Instruction): Uint8Array {
  const { data } = instruction as { data?: Uint8Array }
  if (data === undefined) throw new Error('instruction carries no data')
  return data
}

describe('вибір інструкції', () => {
  it('кожен тип дозволу списується своєю інструкцією', async () => {
    expect(identifySubscriptionsInstruction(parsable(await build(fixed())))).toBe(
      SubscriptionsInstruction.TransferFixed,
    )
    expect(identifySubscriptionsInstruction(parsable(await build(recurring())))).toBe(
      SubscriptionsInstruction.TransferRecurring,
    )
    expect(identifySubscriptionsInstruction(parsable(await build(subscription())))).toBe(
      SubscriptionsInstruction.TransferSubscription,
    )
  })

  it('адреса програми — наша, і береться з SDK', async () => {
    for (const target of [fixed(), recurring(), subscription()]) {
      expect((await build(target)).programAddress).toBe(PROGRAM_ADDRESS)
    }
  })

  it('fixed і recurring відрізняються лише інструкцією, не набором акаунтів', async () => {
    const one = await build(fixed())
    const two = await build(recurring())
    expect(plainAccounts(one)).toEqual(plainAccounts(two))
    expect(instructionData(one)).not.toEqual(instructionData(two))
  })
})

describe('round-trip: закодував → декодував → рівність', () => {
  it('fixed: сума, власник і мін повертаються тими самими', async () => {
    const parsed = parseTransferFixedInstruction(parsable(await build(fixed())))
    expect(parsed.data.transferData).toEqual({ amount: AMOUNT, delegator: OWNER, mint: MINT })
  })

  it('recurring: те саме тіло інструкції', async () => {
    const parsed = parseTransferRecurringInstruction(parsable(await build(recurring())))
    expect(parsed.data.transferData).toEqual({ amount: AMOUNT, delegator: OWNER, mint: MINT })
  })

  it('subscription: тіло те саме, а план приїжджає окремим акаунтом', async () => {
    const parsed = parseTransferSubscriptionInstruction(parsable(await build(subscription())))
    expect(parsed.data.transferData).toEqual({ amount: AMOUNT, delegator: OWNER, mint: MINT })
    expect(parsed.accounts.planPda.address).toBe(PLAN_PDA)
    expect(parsed.accounts.subscriptionPda.address).toBe(PDA)
  })

  it('fixed: усі дев’ять акаунтів — саме ті, що деривуються з дозволу', async () => {
    const parsed = parseTransferFixedInstruction(parsable(await build(fixed())))
    const authority = await findSubscriptionAuthority({ tokenMint: MINT, user: OWNER })
    expect(parsed.accounts.delegationPda.address).toBe(PDA)
    expect(parsed.accounts.subscriptionAuthority.address).toBe(authority.address)
    expect(parsed.accounts.delegatorAta.address).toBe(await ata(OWNER))
    expect(parsed.accounts.receiverAta.address).toBe(await ata(merchant.address))
    expect(parsed.accounts.tokenMint.address).toBe(MINT)
    expect(parsed.accounts.tokenProgram.address).toBe(TOKEN_PROGRAM_ADDRESS)
    expect(parsed.accounts.delegatee.address).toBe(merchant.address)
    expect(parsed.accounts.selfProgram.address).toBe(PROGRAM_ADDRESS)
  })

  it('subscription: ATA власника деривується сам, і саме з власника дозволу', async () => {
    const parsed = parseTransferSubscriptionInstruction(parsable(await build(subscription())))
    expect(parsed.accounts.delegatorAta.address).toBe(await ata(OWNER))
    expect(parsed.accounts.caller.address).toBe(merchant.address)
  })

  it('незаданий отримувач — це ATA мерчанта, а не порожня адреса', async () => {
    for (const parsed of [
      parseTransferFixedInstruction(parsable(await build(fixed()))),
      parseTransferSubscriptionInstruction(parsable(await build(subscription()))),
    ]) {
      expect(parsed.accounts.receiverAta.address).toBe(await ata(merchant.address))
      expect(parsed.accounts.receiverAta.address).not.toBe(ZERO_ADDRESS)
    }
  })

  it('заданий отримувач іде в інструкцію як є', async () => {
    const parsed = parseTransferFixedInstruction(
      parsable(await build(fixed(), { receiverAta: OTHER_ATA })),
    )
    expect(parsed.accounts.receiverAta.address).toBe(OTHER_ATA)
  })

  it('транзакція переживає кодування у дріт і назад без змін', async () => {
    const charge = await buildChargeTransaction({
      allowance: fixed(),
      amount: AMOUNT,
      lifetime: LIFETIME,
      merchant,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
    const wire = getTransactionEncoder().encode(charge.transaction)
    const decoded = getTransactionDecoder().decode(wire)
    const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)
    const message = decompileTransactionMessage(compiled)

    expect(message.instructions).toHaveLength(1)
    const [only] = message.instructions
    if (only === undefined) throw new Error('the transaction lost its instruction')
    const original = await build(fixed())
    expect(instructionData(only)).toEqual(instructionData(original))
    expect(plainAccounts(only).map((account) => account.address)).toEqual(
      plainAccounts(original).map((account) => account.address),
    )
  })

  it('мерчант їде у транзакції writable — бо він же й платить комісію', async () => {
    /*
     * Єдина розбіжність round-trip'а, і вона не наша: в інструкції `delegatee`
     * лише readonly-signer (роль 2), а після компіляції той самий акаунт стає
     * writable-signer (роль 3) — з нього списується комісія. Перевіряється саме
     * це, щоб зміна ролі з будь-якої іншої причини впала тестом.
     */
    const charge = await buildChargeTransaction({
      allowance: fixed(),
      amount: AMOUNT,
      lifetime: LIFETIME,
      merchant,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
    const compiled = getCompiledTransactionMessageDecoder().decode(charge.transaction.messageBytes)
    const message = decompileTransactionMessage(compiled)
    const [only] = message.instructions
    if (only === undefined) throw new Error('the transaction lost its instruction')
    expect(plainAccounts(only)).toContainEqual({ address: merchant.address, role: 3 })
    expect(plainAccounts(await build(fixed()))).toContainEqual({
      address: merchant.address,
      role: 2,
    })
  })
})

describe('перевіряються входи, а не стан дозволу', () => {
  it('сума нуль не проходить: це не «нічого не сталося»', async () => {
    await expect(build(fixed(), { amount: 0n })).rejects.toThrow(ChargeAmountError)
  })

  it('від’ємна сума і сума понад u64 не проходять', async () => {
    await expect(build(fixed(), { amount: -1n })).rejects.toThrow(ChargeAmountError)
    await expect(build(fixed(), { amount: U64_MAX + 1n })).rejects.toThrow(ChargeAmountError)
  })

  it('чужий дозвіл не збирається нашим ключем', async () => {
    const foreign: ChargeTarget = { ...fixed(), delegate: STRANGER }
    await expect(build(foreign)).rejects.toThrow(ChargeDelegateMismatchError)
  })

  it('підписка без плану не збирається', async () => {
    await expect(build({ ...subscription(), planPda: null })).rejects.toThrow(
      ChargeMissingPlanError,
    )
  })

  it('план на дозволі поза планом не мовчить, а відмовляє', async () => {
    await expect(build({ ...fixed(), planPda: PLAN_PDA })).rejects.toThrow(
      ChargePlanNotApplicableError,
    )
  })

  it('план і delegatee підписки мусять збігатися', async () => {
    await expect(build({ ...subscription(), delegate: STRANGER })).rejects.toThrow(
      ChargePlanAddressMismatchError,
    )
  })

  it('для підписки право тягнути перевіряє план, а не ми', async () => {
    // `caller` не мусить збігатися з `delegate`: перелік `pullers` читає програма.
    const instruction = await build(subscription())
    expect(
      parseTransferSubscriptionInstruction(parsable(instruction)).accounts.caller.address,
    ).toBe(merchant.address)
  })

  it('мішень із названих полів дає ту саму інструкцію, що й прочитана з мережі', async () => {
    // Це і є шлях після відкликання: акаунта немає, поля названо руками.
    const fromFields = chargeTargetFromFields(PDA, {
      delegate: merchant.address,
      kind: 'fixed',
      mint: MINT,
      owner: OWNER,
    })
    const one = await build(fromFields)
    const two = await build(fixed())
    expect(plainAccounts(one)).toEqual(plainAccounts(two))
    expect(instructionData(one)).toEqual(instructionData(two))
  })
})

describe('транзакція', () => {
  it('комісію платить мерчант, і в транзакції рівно одна інструкція', async () => {
    const charge = await buildChargeTransaction({
      allowance: fixed(),
      amount: AMOUNT,
      lifetime: LIFETIME,
      merchant,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
    expect(charge.message.feePayer.address).toBe(merchant.address)
    expect(charge.message.instructions).toHaveLength(1)
    expect(charge.message.version).toBe(CHARGE_TRANSACTION_VERSION)
  })

  it('підпис мерчанта вже стоїть — і він відомий до надсилання', async () => {
    const charge = await buildChargeTransaction({
      allowance: fixed(),
      amount: AMOUNT,
      lifetime: LIFETIME,
      merchant,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
    expect(charge.transaction.signatures[merchant.address]).not.toBeNull()
    expect(charge.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/)
  })
})

describe('programErrorCodeOf', () => {
  it('дістає код помилки програми з відповіді мережі', () => {
    expect(programErrorCodeOf({ InstructionError: [0, { Custom: 130 }] })).toBe(130)
  })

  it('kit віддає код як bigint — і саме так він приходить із devnet', () => {
    // Форма, знята зі справжньої відповіді вузла 2026-09-02: обидва числа bigint.
    expect(programErrorCodeOf({ InstructionError: [0n, { Custom: 400n }] })).toBe(400)
  })

  it('код, що не влазить у число, не обрізається мовчки', () => {
    expect(programErrorCodeOf({ InstructionError: [0n, { Custom: -1n }] })).toBeNull()
    expect(programErrorCodeOf({ InstructionError: [0n, { Custom: 2n ** 64n }] })).toBeNull()
  })

  it('відмова не від програми коду не має', () => {
    expect(programErrorCodeOf({ InstructionError: [0, 'ProgramFailedToComplete'] })).toBeNull()
    expect(programErrorCodeOf('AccountNotFound')).toBeNull()
    expect(programErrorCodeOf(null)).toBeNull()
    expect(programErrorCodeOf({ InstructionError: [0] })).toBeNull()
  })
})

type Status = { err: unknown; slot: bigint } | null

type Script = {
  statuses?: readonly Status[]
  sendThrows?: unknown
  blockhashThrows?: unknown
}

type Recorded = { method: string; signatures?: readonly Signature[]; skipPreflight?: boolean }

function fakeRpc(script: Script = {}): { rpc: ChargeRpc; calls: Recorded[] } {
  const calls: Recorded[] = []
  let poll = 0
  const rpc: ChargeRpc = {
    getLatestBlockhash: () => ({
      send: async () => {
        calls.push({ method: 'getLatestBlockhash' })
        if (script.blockhashThrows !== undefined) throw script.blockhashThrows
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT } }
      },
    }),
    sendTransaction: (_wire, config) => ({
      send: async () => {
        calls.push({ method: 'sendTransaction', skipPreflight: config.skipPreflight })
        if (script.sendThrows !== undefined) throw script.sendThrows
        return 'sent' as Signature
      },
    }),
    getSignatureStatuses: (signatures) => ({
      send: async () => {
        calls.push({ method: 'getSignatureStatuses', signatures })
        const status = script.statuses?.[poll] ?? null
        poll += 1
        return { value: [status] }
      },
    }),
  }
  return { rpc, calls }
}

const attempt = (rpc: ChargeRpc, target: ChargeTarget = fixed()) =>
  attemptCharge(
    rpc,
    { allowance: target, amount: AMOUNT, merchant, tokenProgram: TOKEN_PROGRAM_ADDRESS },
    { pollAttempts: 3, pollIntervalMs: 0, sleep: async () => {} },
  )

describe('attemptCharge — вердикт дає мережа', () => {
  it('порожня помилка в статусі означає списання', async () => {
    const { rpc } = fakeRpc({ statuses: [{ err: null, slot: 401n }] })
    const verdict = await attempt(rpc)
    expect(verdict.outcome).toBe('charged')
    if (verdict.outcome !== 'charged') return
    expect(verdict.slot).toBe(401n)
  })

  it('помилка програми означає відмову, і код названо', async () => {
    const err = { InstructionError: [0, { Custom: 111 }] }
    const { rpc } = fakeRpc({ statuses: [{ err, slot: 402n }] })
    const verdict = await attempt(rpc)
    expect(verdict.outcome).toBe('rejected')
    if (verdict.outcome !== 'rejected') return
    expect(verdict.programErrorCode).toBe(111)
    expect(verdict.error).toEqual(err)
  })

  it('відмова не від програми лишається відмовою, але без вигаданого коду', async () => {
    const { rpc } = fakeRpc({ statuses: [{ err: 'AccountInUse', slot: 403n }] })
    const verdict = await attempt(rpc)
    expect(verdict.outcome).toBe('rejected')
    if (verdict.outcome !== 'rejected') return
    expect(verdict.programErrorCode).toBeNull()
  })

  it('мовчання мережі — це «невідомо», не успіх і не відмова', async () => {
    const { rpc, calls } = fakeRpc({ statuses: [] })
    const verdict = await attempt(rpc)
    expect(verdict.outcome).toBe('unknown')
    expect(calls.filter((call) => call.method === 'getSignatureStatuses')).toHaveLength(3)
  })

  it('питається саме той підпис, який зібрано локально', async () => {
    const { rpc, calls } = fakeRpc({ statuses: [{ err: null, slot: 404n }] })
    const verdict = await attempt(rpc)
    const asked = calls.find((call) => call.method === 'getSignatureStatuses')
    expect(asked?.signatures).toEqual([verdict.signature])
  })

  it('за замовчуванням передпольоту немає: приречена спроба мусить сісти в ланцюжок', async () => {
    const { rpc, calls } = fakeRpc({ statuses: [{ err: null, slot: 405n }] })
    await attempt(rpc)
    expect(calls.find((call) => call.method === 'sendTransaction')?.skipPreflight).toBe(true)
  })

  it('помилка надсилання не є вердиктом: якщо мережа знає підпис — рахується мережа', async () => {
    const { rpc } = fakeRpc({
      sendThrows: new Error('node hung up'),
      statuses: [{ err: { InstructionError: [0, { Custom: 130 }] }, slot: 406n }],
    })
    const verdict = await attempt(rpc)
    expect(verdict.outcome).toBe('rejected')
  })

  it('надсилання впало і мережа підпису не знає — спроби не було', async () => {
    const { rpc } = fakeRpc({ sendThrows: new Error('429 Too Many Requests') })
    const verdict = await attempt(rpc)
    expect(verdict.outcome).toBe('no-attempt')
    if (verdict.outcome !== 'no-attempt') return
    expect(verdict.detail).toContain('429')
    expect(verdict.signature).not.toBeNull()
  })

  it('без хеша блоку транзакції не існує навіть у нас', async () => {
    const { rpc, calls } = fakeRpc({ blockhashThrows: new Error('rpc down') })
    const verdict = await attempt(rpc)
    expect(verdict.outcome).toBe('no-attempt')
    if (verdict.outcome !== 'no-attempt') return
    expect(verdict.signature).toBeNull()
    expect(calls.map((call) => call.method)).toEqual(['getLatestBlockhash'])
  })

  it('стан дозволу не читається взагалі — суддя лише протокол', async () => {
    const { rpc, calls } = fakeRpc({
      statuses: [{ err: { InstructionError: [0, { Custom: 117 }] }, slot: 407n }],
    })
    const verdict = await attempt(rpc)
    // Спроба за дозволом, якого в мережі вже немає, все одно надсилається.
    expect(verdict.outcome).toBe('rejected')
    expect(calls.map((call) => call.method)).toEqual([
      'getLatestBlockhash',
      'sendTransaction',
      'getSignatureStatuses',
    ])
  })
})

describe('runtimeErrorLabelOf і rejectionReasonKey', () => {
  it('відмова рантайму має назву, а не «немає коду»', () => {
    // Форма зі справжнього прогону: після скасування акаунт належить системній
    // програмі, і мережа відповідає рядком, а не числом.
    const closed = { InstructionError: [0n, 'InvalidAccountOwner'] }
    expect(runtimeErrorLabelOf(closed)).toBe('InvalidAccountOwner')
    expect(rejectionReasonKey(closed)).toBe('InvalidAccountOwner')
    expect(programErrorCodeOf(closed)).toBeNull()
  })

  it('код програми лишається кодом', () => {
    expect(rejectionReasonKey({ InstructionError: [0n, { Custom: 400n }] })).toBe('400')
  })

  it('нерозпізнана форма називається «other», а не вигаданим кодом', () => {
    expect(rejectionReasonKey({ InstructionError: [0n, { Weird: 1 }] })).toBe('other')
    expect(runtimeErrorLabelOf('AccountInUse')).toBe('AccountInUse')
  })
})

describe('describeVerdict', () => {
  it('відмову без коду програми називає прямо, а не «невідома причина»', () => {
    const text = describeVerdict({
      error: { InstructionError: [0n, 'InvalidAccountOwner'] },
      outcome: 'rejected',
      programErrorCode: null,
      signature: 'sig' as Signature,
      slot: 1n,
    })
    expect(text).toContain('InvalidAccountOwner')
    expect(text).toContain('the runtime refused it, not the program')
    // Помилка мережі несе bigint, а JSON.stringify на ньому кидає: друк
    // відмови не має права валити команду.
    expect(text).toContain('"InvalidAccountOwner"')
  })

  it('відсутню спробу не показує успіхом', () => {
    const text = describeVerdict({ detail: 'rpc down', outcome: 'no-attempt', signature: null })
    expect(text).toContain('NO ATTEMPT')
  })
})

describe('resolveTokenProgram', () => {
  const mintRpc = (value: { owner: Address } | null): MintOwnerRpc => ({
    getAccountInfo: () => ({ send: async () => ({ value }) }),
  })

  it('токен-програма — це власник акаунта міну, а не наша константа', async () => {
    await expect(
      resolveTokenProgram(mintRpc({ owner: TOKEN_PROGRAM_ADDRESS }), MINT),
    ).resolves.toBe(TOKEN_PROGRAM_ADDRESS)
    // Token-2022 проходить тим самим шляхом: переліку «дозволених» тут немає.
    await expect(resolveTokenProgram(mintRpc({ owner: STRANGER }), MINT)).resolves.toBe(STRANGER)
  })

  it('міну немає — деривувати рахунки нема з чого', async () => {
    await expect(resolveTokenProgram(mintRpc(null), MINT)).rejects.toThrow(ChargeMintNotFoundError)
  })
})

const ALLOWANCE: Allowance = {
  capAmount: '20000000',
  delegate: STRANGER,
  endsAt: null,
  expiresAt: null,
  kind: 'recurring',
  lastSlot: 400,
  mint: MINT,
  owner: OWNER,
  pausedAt: null,
  pda: PDA,
  periodSeconds: 2_592_000,
  periodStartedAt: '2026-08-01T00:00:00.000Z',
  planPda: null,
  spentInPeriod: '0',
  status: 'active',
  syncedAt: '2026-09-02T00:00:00.000Z',
}

describe('мішень: мережа поки є акаунт, названі поля коли його вже немає', () => {
  it('прочитаний дозвіл дає мішень цілком', () => {
    expect(chargeTarget(ALLOWANCE, PDA, {})).toEqual(chargeTargetFromAllowance(ALLOWANCE))
  })

  it('названі поля при живому акаунті звіряються, а не перевизначають', () => {
    expect(() => chargeTarget(ALLOWANCE, PDA, { owner: STRANGER })).toThrow(ChargeTargetError)
    expect(() => chargeTarget(ALLOWANCE, PDA, { plan: PLAN_PDA })).toThrow(/says "none"/)
    expect(() => chargeTarget(ALLOWANCE, PDA, { owner: OWNER, kind: 'recurring' })).not.toThrow()
  })

  it('акаунта немає — мішень збирається з полів', () => {
    const target = chargeTarget(null, PDA, {
      delegate: STRANGER,
      kind: 'fixed',
      mint: MINT,
      owner: OWNER,
    })
    expect(target).toEqual({
      delegate: STRANGER,
      kind: 'fixed',
      mint: MINT,
      owner: OWNER,
      pda: PDA,
      planPda: null,
    })
  })

  it('для підписки план і є delegatee', () => {
    const target = chargeTarget(null, PDA, {
      kind: 'subscription',
      mint: MINT,
      owner: OWNER,
      plan: PLAN_PDA,
    })
    expect(target.delegate).toBe(PLAN_PDA)
    expect(target.planPda).toBe(PLAN_PDA)
  })

  it('пропущене поле називається поіменно, а не підставляється за нас', () => {
    expect(() => chargeTarget(null, PDA, { kind: 'fixed', mint: MINT, owner: OWNER })).toThrow(
      /--delegate is required/,
    )
    expect(() =>
      chargeTarget(null, PDA, { kind: 'subscription', mint: MINT, owner: OWNER }),
    ).toThrow(/--plan is required/)
    expect(() => chargeTarget(null, PDA, {})).toThrow(/--kind is required/)
    expect(() => chargeTarget(null, PDA, { kind: 'monthly' })).toThrow(/--kind must be one of/)
  })
})

describe('ChargeRpc', () => {
  it('справжній клієнт мережі відповідає типу спроби списання', () => {
    const client = createChainClient({
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      usdcMint: MINT,
    })
    const rpc: ChargeRpc = client.rpc
    const mintRpc: MintOwnerRpc = client.rpc
    expect(typeof rpc.sendTransaction).toBe('function')
    expect(typeof rpc.getSignatureStatuses).toBe('function')
    expect(typeof mintRpc.getAccountInfo).toBe('function')
  })

  it('підписант-заглушка теж збирає інструкцію — підпис ставиться пізніше', async () => {
    const instruction = await buildChargeInstruction({
      allowance: { ...fixed(), delegate: STRANGER },
      amount: AMOUNT,
      merchant: createNoopSigner(STRANGER),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
    expect(parseTransferFixedInstruction(parsable(instruction)).accounts.delegatee.address).toBe(
      STRANGER,
    )
  })
})
