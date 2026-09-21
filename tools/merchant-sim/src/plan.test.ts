import { createChainClient, findPlan, PROGRAM_ADDRESS } from '@cancelchain/chain'
import { U64_MAX } from '@cancelchain/shared'
import type { Address, Blockhash, Instruction, Signature, TransactionSigner } from '@solana/kit'
import {
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
} from '@solana/kit'
import {
  AccountDiscriminator,
  getCreatePlanInstructionDataDecoder,
  getCreatePlanInstructionDataEncoder,
  getPlanEncoder,
  identifySubscriptionsInstruction,
  type PlanArgs,
  PlanStatus,
  parseCreatePlanInstruction,
  SubscriptionsInstruction,
  ZERO_ADDRESS,
} from '@solana/subscriptions'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ChargeRpc } from './charge.js'
import {
  assertPlanTerms,
  buildCreatePlanInstruction,
  buildCreatePlanTransaction,
  createPlan,
  describeCreatePlanVerdict,
  describePlan,
  findPlanAddress,
  NotAPlanError,
  PlanAmountError,
  PlanEndError,
  PlanIdError,
  PlanListError,
  PlanMetadataUriError,
  PlanNotFoundError,
  PlanPeriodError,
  type PlanReaderRpc,
  type PlanSnapshot,
  type PlanTerms,
  readPlan,
} from './plan.js'

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const OTHER_WALLET = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq' as Address
const THIRD_WALLET = '4DYhzGx6zWLmFDCBLJfCyRpTBnJnbfLqzHz7BvUJBFHU' as Address
const SOMEWHERE = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH' as Address

const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash
const LIFETIME = { blockhash: BLOCKHASH, lastValidBlockHeight: 492_096_495n }

const NOW = new Date('2026-09-21T12:00:00.000Z')
const NEXT_YEAR = '2027-09-21T12:00:00.000Z'
const NEXT_YEAR_SECONDS = 1_821_528_000n

const PLAN_ID = 1_758_456_000_000n
const AMOUNT = 9_990_000n
const PERIOD_HOURS = 720

let merchant: TransactionSigner

beforeAll(async () => {
  merchant = await generateKeyPairSigner()
})

/** Мінімальний план: усе, що можна не заповнювати, не заповнене. */
function bare(): PlanTerms {
  return {
    planId: PLAN_ID,
    amount: AMOUNT,
    periodHours: PERIOD_HOURS,
    endsAt: null,
    destinations: [merchant.address],
    pullers: [merchant.address],
    metadataUri: '',
  }
}

/** План, у якому заповнено все, що взагалі можна заповнити. */
function full(): PlanTerms {
  return {
    ...bare(),
    endsAt: NEXT_YEAR,
    destinations: [merchant.address, OTHER_WALLET, THIRD_WALLET],
    pullers: [merchant.address, OTHER_WALLET],
    metadataUri: 'https://example.invalid/plans/pro.json',
  }
}

const build = (terms: PlanTerms, extra: { payer?: TransactionSigner } = {}) =>
  buildCreatePlanInstruction({
    terms,
    merchant,
    tokenMint: MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    now: NOW,
    ...(extra.payer === undefined ? {} : { payer: extra.payer }),
  })

type ParsableInstruction = Parameters<typeof parseCreatePlanInstruction>[0]

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

type PlainAccount = { address: Address; role: number }

function plainAccounts(instruction: Instruction): PlainAccount[] {
  const accounts = 'accounts' in instruction ? (instruction.accounts ?? []) : []
  return accounts.map((account) => ({ address: account.address, role: account.role }))
}

const pad = (wallets: readonly string[]): Address[] =>
  Array.from({ length: 4 }, (_, index) => (wallets[index] ?? ZERO_ADDRESS) as Address)

describe('інструкція створення плану', () => {
  it('це createPlan нашої програми', async () => {
    const instruction = await build(bare())
    expect(identifySubscriptionsInstruction(parsable(instruction))).toBe(
      SubscriptionsInstruction.CreatePlan,
    )
    expect(instruction.programAddress).toBe(PROGRAM_ADDRESS)
  })

  it('адреса плану відома до підпису й збігається з тією, що в інструкції', async () => {
    const parsed = parseCreatePlanInstruction(parsable(await build(bare())))
    const expected = await findPlanAddress({ owner: merchant.address, planId: PLAN_ID })
    const viaSeeds = await findPlan({ owner: merchant.address, planId: PLAN_ID })
    expect(parsed.accounts.planPda.address).toBe(expected)
    expect(expected).toBe(viaSeeds.address)
  })

  it('акаунти: мерчант підписує, план і мін названі, платника за замовчуванням немає', async () => {
    const parsed = parseCreatePlanInstruction(parsable(await build(bare())))
    expect(parsed.accounts.merchant.address).toBe(merchant.address)
    expect(parsed.accounts.tokenMint.address).toBe(MINT)
    expect(parsed.accounts.tokenProgram.address).toBe(TOKEN_PROGRAM_ADDRESS)
    expect(parsed.accounts.payer).toBeUndefined()
  })

  it('окремий платник іде в інструкцію лише коли названий', async () => {
    const payer = await generateKeyPairSigner()
    const parsed = parseCreatePlanInstruction(parsable(await build(bare(), { payer })))
    expect(parsed.accounts.payer?.address).toBe(payer.address)
    expect(parsed.accounts.merchant.address).toBe(merchant.address)
  })
})

describe('round-trip: закодував → декодував → рівність', () => {
  it('порожні поля їдуть як порожні, а не як щось інше', async () => {
    const parsed = parseCreatePlanInstruction(parsable(await build(bare())))
    expect(parsed.data.planData).toEqual({
      planId: PLAN_ID,
      mint: MINT,
      terms: { amount: AMOUNT, periodHours: BigInt(PERIOD_HOURS), createdAt: 0n },
      endTs: 0n,
      destinations: pad([merchant.address]),
      pullers: pad([merchant.address]),
      metadataUri: '',
    })
  })

  it('заповнені поля повертаються тими самими, у тому самому порядку', async () => {
    const parsed = parseCreatePlanInstruction(parsable(await build(full())))
    expect(parsed.data.planData).toEqual({
      planId: PLAN_ID,
      mint: MINT,
      terms: { amount: AMOUNT, periodHours: BigInt(PERIOD_HOURS), createdAt: 0n },
      endTs: NEXT_YEAR_SECONDS,
      destinations: pad([merchant.address, OTHER_WALLET, THIRD_WALLET]),
      pullers: pad([merchant.address, OTHER_WALLET]),
      metadataUri: 'https://example.invalid/plans/pro.json',
    })
  })

  it('байти інструкції декодуються й кодуються назад у ті самі байти', async () => {
    const data = instructionData(await build(full()))
    const decoded = getCreatePlanInstructionDataDecoder().decode(data)
    expect(getCreatePlanInstructionDataEncoder().encode(decoded)).toEqual(data)
  })

  it('те, що поїхало в інструкцію, читається з акаунта тими самими умовами', async () => {
    /*
     * Найдовший шлях: наші умови → інструкція → (програма зберігає їх у акаунт,
     * ставлячи createdAt) → readPlan. Якби `readPlan` і білдер розходилися в
     * одиницях чи в порядку полів, це єдиний тест, який би це побачив.
     */
    const terms = full()
    const parsed = parseCreatePlanInstruction(parsable(await build(terms)))
    const pda = await findPlanAddress({ owner: merchant.address, planId: PLAN_ID })
    const stored: PlanArgs = {
      discriminator: AccountDiscriminator.Plan,
      owner: merchant.address,
      bump: 254,
      status: PlanStatus.Active,
      data: {
        ...parsed.data.planData,
        terms: { ...parsed.data.planData.terms, createdAt: 1_758_456_000n },
      },
    }
    const snapshot = await readPlan(planReader({ [pda]: encodeAccount(stored) }), pda)
    expect(snapshot).toEqual<PlanSnapshot>({
      pda,
      owner: merchant.address,
      status: 'active',
      planId: PLAN_ID,
      mint: MINT,
      amount: AMOUNT,
      periodHours: PERIOD_HOURS,
      createdAt: '2025-09-21T12:00:00.000Z',
      endsAt: NEXT_YEAR,
      destinations: [merchant.address, OTHER_WALLET, THIRD_WALLET],
      pullers: [merchant.address, OTHER_WALLET],
      metadataUri: terms.metadataUri,
    })
  })

  it('транзакція переживає кодування у дріт і назад без змін', async () => {
    const plan = await buildCreatePlanTransaction({
      terms: full(),
      merchant,
      tokenMint: MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      lifetime: LIFETIME,
      now: NOW,
    })
    const wire = getTransactionEncoder().encode(plan.transaction)
    const decoded = getTransactionDecoder().decode(wire)
    const message = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(decoded.messageBytes),
    )
    expect(message.instructions).toHaveLength(1)
    const [only] = message.instructions
    if (only === undefined) throw new Error('the transaction lost its instruction')
    const original = await build(full())
    expect(instructionData(only)).toEqual(instructionData(original))
    expect(plainAccounts(only).map((account) => account.address)).toEqual(
      plainAccounts(original).map((account) => account.address),
    )
    expect(message.feePayer.address).toBe(merchant.address)
  })

  it('підпис мерчанта вже стоїть і відомий до надсилання', async () => {
    const plan = await buildCreatePlanTransaction({
      terms: bare(),
      merchant,
      tokenMint: MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      lifetime: LIFETIME,
      now: NOW,
    })
    const signature = plan.transaction.signatures[merchant.address]
    expect(signature).toBeDefined()
    expect(signature?.some((byte) => byte !== 0)).toBe(true)
    expect(plan.signature).toBe(getSignatureFromTransaction(plan.transaction))
  })

  it('окремий платник платить і комісію', async () => {
    const payer = await generateKeyPairSigner()
    const plan = await buildCreatePlanTransaction({
      terms: bare(),
      merchant,
      payer,
      tokenMint: MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      lifetime: LIFETIME,
      now: NOW,
    })
    expect(plan.message.feePayer.address).toBe(payer.address)
    expect(Object.keys(plan.transaction.signatures).sort()).toEqual(
      [merchant.address, payer.address].sort(),
    )
  })
})

describe('перевіряються власні входи, а не стан мережі', () => {
  const check = (terms: Partial<PlanTerms>) => () => assertPlanTerms({ ...bare(), ...terms }, NOW)

  it('сума нуль і сума понад u64 не проходять', () => {
    expect(check({ amount: 0n })).toThrow(PlanAmountError)
    expect(check({ amount: -1n })).toThrow(PlanAmountError)
    expect(check({ amount: U64_MAX + 1n })).toThrow(PlanAmountError)
    expect(check({ amount: U64_MAX })).not.toThrow()
  })

  it('період — лише ціле додатне число годин', () => {
    expect(check({ periodHours: 0 })).toThrow(PlanPeriodError)
    expect(check({ periodHours: -24 })).toThrow(PlanPeriodError)
    expect(check({ periodHours: 1.5 })).toThrow(PlanPeriodError)
    expect(check({ periodHours: Number.NaN })).toThrow(PlanPeriodError)
    expect(check({ periodHours: 1 })).not.toThrow()
  })

  it('planId не влазить у u64 — відмова до деривації', () => {
    expect(check({ planId: U64_MAX + 1n })).toThrow(PlanIdError)
    expect(check({ planId: -1n })).toThrow(PlanIdError)
    expect(check({ planId: 0n })).not.toThrow()
  })

  it('дата кінця в минулому не проходить, у майбутньому — проходить', () => {
    expect(check({ endsAt: '2026-09-21T11:59:59.000Z' })).toThrow(PlanEndError)
    expect(check({ endsAt: '2026-09-21T12:00:00.000Z' })).toThrow(PlanEndError)
    expect(check({ endsAt: '2026-09-21T12:00:01.000Z' })).not.toThrow()
    expect(check({ endsAt: 'next tuesday' })).toThrow(RangeError)
  })

  it('перелік отримувачів: непорожній, до чотирьох, без повторів і нульової адреси', () => {
    expect(check({ destinations: [] })).toThrow(PlanListError)
    expect(check({ destinations: [] })).toThrow(/InvalidNumDestinations/)
    expect(
      check({ destinations: [merchant.address, OTHER_WALLET, THIRD_WALLET, SOMEWHERE, MINT] }),
    ).toThrow(/at most 4/)
    expect(check({ destinations: [merchant.address, merchant.address] })).toThrow(/twice/)
    expect(check({ destinations: [ZERO_ADDRESS] })).toThrow(/zero address/)
    expect(check({ destinations: ['not-an-address'] })).toThrow()
  })

  it('перелік тягачів — ті самі правила, і порожній теж не проходить', () => {
    expect(check({ pullers: [] })).toThrow(PlanListError)
    expect(check({ pullers: [] })).toThrow(/at least one puller/)
    expect(check({ pullers: [OTHER_WALLET, OTHER_WALLET] })).toThrow(/pullers lists the same/)
  })

  it('metadataUri міряється байтами, а не символами', () => {
    expect(check({ metadataUri: 'a'.repeat(128) })).not.toThrow()
    expect(check({ metadataUri: 'a'.repeat(129) })).toThrow(PlanMetadataUriError)
    // 65 кириличних літер — 65 символів, але 130 байт.
    expect(check({ metadataUri: 'я'.repeat(65) })).toThrow(PlanMetadataUriError)
    expect(check({ metadataUri: 'я'.repeat(64) })).not.toThrow()
  })

  it('білдер перевіряє те саме, що й assertPlanTerms', async () => {
    await expect(build({ ...bare(), amount: 0n })).rejects.toThrow(PlanAmountError)
    await expect(build({ ...bare(), pullers: [] })).rejects.toThrow(PlanListError)
  })
})

/** Акаунт плану так, як його віддає `getAccountInfo` з `encoding: 'base64'`. */
function encodeAccount(plan: PlanArgs, owner: Address = PROGRAM_ADDRESS) {
  const bytes = getPlanEncoder().encode(plan)
  return { owner, data: [getBase64Decoder().decode(bytes), 'base64'] as const }
}

type StoredAccount = ReturnType<typeof encodeAccount>

function planReader(accounts: Record<string, StoredAccount | null>): PlanReaderRpc {
  return {
    getAccountInfo: (address) => ({
      send: async () => ({ value: accounts[address] ?? null }),
    }),
  }
}

function storedPlan(overrides: Partial<PlanArgs['data']> = {}, status = PlanStatus.Active) {
  return {
    discriminator: AccountDiscriminator.Plan,
    owner: merchant.address,
    bump: 254,
    status,
    data: {
      planId: PLAN_ID,
      mint: MINT,
      terms: { amount: AMOUNT, periodHours: BigInt(PERIOD_HOURS), createdAt: 1_758_456_000n },
      endTs: 0n,
      destinations: pad([merchant.address]),
      pullers: pad([merchant.address]),
      metadataUri: '',
      ...overrides,
    },
  } satisfies PlanArgs
}

describe('readPlan — план так, як його зберігає мережа', () => {
  it('порожні поля повертаються порожніми, а не нулями чи адресами-заповнювачами', async () => {
    const snapshot = await readPlan(
      planReader({ [SOMEWHERE]: encodeAccount(storedPlan()) }),
      SOMEWHERE,
    )
    expect(snapshot.endsAt).toBeNull()
    expect(snapshot.metadataUri).toBe('')
    expect(snapshot.destinations).toEqual([merchant.address])
    expect(snapshot.pullers).toEqual([merchant.address])
    expect(snapshot.createdAt).toBe('2025-09-21T12:00:00.000Z')
    expect(snapshot.status).toBe('active')
  })

  it('статус sunset читається як sunset', async () => {
    const reader = planReader({
      [SOMEWHERE]: encodeAccount(storedPlan({ endTs: NEXT_YEAR_SECONDS }, PlanStatus.Sunset)),
    })
    const snapshot = await readPlan(reader, SOMEWHERE)
    expect(snapshot.status).toBe('sunset')
    expect(snapshot.endsAt).toBe(NEXT_YEAR)
  })

  it('акаунта немає — це названа відмова, не порожній план', async () => {
    await expect(readPlan(planReader({}), SOMEWHERE)).rejects.toThrow(PlanNotFoundError)
  })

  it('чужий акаунт потрібної довжини планом не стає', async () => {
    const foreign = planReader({ [SOMEWHERE]: encodeAccount(storedPlan(), OTHER_WALLET) })
    await expect(readPlan(foreign, SOMEWHERE)).rejects.toThrow(NotAPlanError)
    await expect(readPlan(foreign, SOMEWHERE)).rejects.toThrow(/belongs to/)
  })

  it('не той дискримінатор — не план, навіть при правильному власнику', async () => {
    const reader = planReader({
      [SOMEWHERE]: encodeAccount({ ...storedPlan(), discriminator: AccountDiscriminator.Plan + 1 }),
    })
    await expect(readPlan(reader, SOMEWHERE)).rejects.toThrow(/discriminator/)
  })

  it('не той розмір — не план', async () => {
    const short = encodeAccount(storedPlan())
    const reader = planReader({
      [SOMEWHERE]: { ...short, data: [short.data[0].slice(0, -8), 'base64'] as const },
    })
    await expect(readPlan(reader, SOMEWHERE)).rejects.toThrow(/bytes/)
  })
})

type SentTransaction = { wire: string; skipPreflight: boolean | undefined }

function chargeRpc(behaviour: {
  send?: () => Promise<void>
  statuses: (readonly ({ err: unknown; slot: bigint } | null)[])[]
}): ChargeRpc & { sent: SentTransaction[]; statusCalls: number } {
  const statuses = [...behaviour.statuses]
  const rpc = {
    sent: [] as SentTransaction[],
    statusCalls: 0,
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1n } }),
    }),
    sendTransaction: (wire: string, config: { skipPreflight?: boolean }) => ({
      send: async () => {
        rpc.sent.push({ wire, skipPreflight: config.skipPreflight })
        if (behaviour.send !== undefined) await behaviour.send()
        return 'sig' as Signature
      },
    }),
    getSignatureStatuses: () => ({
      send: async () => {
        rpc.statusCalls += 1
        const next = statuses.shift()
        return { value: (next ?? [null]).map((status) => (status === null ? null : status)) }
      },
    }),
  }
  return rpc as unknown as ChargeRpc & { sent: SentTransaction[]; statusCalls: number }
}

const input = () => ({
  terms: bare(),
  merchant,
  tokenMint: MINT,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
  now: NOW,
})

const noSleep = { sleep: async () => {}, pollAttempts: 3 }

describe('createPlan — вердикт дає мережа', () => {
  it('порожня помилка в статусі означає створення, і адреса плану відома', async () => {
    const rpc = chargeRpc({ statuses: [[{ err: null, slot: 100n }]] })
    const verdict = await createPlan(rpc, input(), noSleep)
    expect(verdict.outcome).toBe('created')
    if (verdict.outcome !== 'created') throw new Error('unreachable')
    expect(verdict.pda).toBe(await findPlanAddress({ owner: merchant.address, planId: PLAN_ID }))
    expect(verdict.slot).toBe(100n)
  })

  it('за замовчуванням передполіт увімкнено — навпаки до списання', async () => {
    const rpc = chargeRpc({ statuses: [[{ err: null, slot: 1n }]] })
    await createPlan(rpc, input(), noSleep)
    expect(rpc.sent[0]?.skipPreflight).toBe(false)
  })

  it('відмова вузла на передпольоті — остаточна: мережу не питають', async () => {
    // Так kit і повертає її з devnet: код програми — у `cause`, не в повідомленні.
    const rpc = chargeRpc({
      send: async () => {
        throw new Error('Transaction simulation failed', {
          cause: new Error('Custom program error: #518 (instruction #1)'),
        })
      },
      statuses: [],
    })
    const verdict = await createPlan(rpc, input(), noSleep)
    expect(verdict.outcome).toBe('not-sent')
    if (verdict.outcome !== 'not-sent') throw new Error('unreachable')
    expect(verdict.detail).toMatch(/preflight/)
    expect(verdict.detail).toMatch(/#518/)
    expect(verdict.signature).not.toBeNull()
    expect(rpc.statusCalls).toBe(0)
  })

  it('без передпольоту помилка надсилання не є вердиктом, поки мережа мовчить', async () => {
    const rpc = chargeRpc({
      send: async () => {
        throw new Error('connection reset')
      },
      statuses: [[{ err: null, slot: 7n }]],
    })
    const verdict = await createPlan(rpc, input(), { ...noSleep, skipPreflight: true })
    expect(verdict.outcome).toBe('created')
    expect(rpc.statusCalls).toBe(1)
  })

  it('помилка програми означає відмову, і код названо', async () => {
    const rpc = chargeRpc({
      statuses: [[{ err: { InstructionError: [0n, { Custom: 500n }] }, slot: 9n }]],
    })
    const verdict = await createPlan(rpc, input(), { ...noSleep, skipPreflight: true })
    expect(verdict.outcome).toBe('rejected')
    if (verdict.outcome !== 'rejected') throw new Error('unreachable')
    expect(verdict.programErrorCode).toBe(500)
  })

  it('мовчання мережі — це «невідомо», не успіх і не відмова', async () => {
    const rpc = chargeRpc({ statuses: [[null], [null], [null]] })
    const verdict = await createPlan(rpc, input(), noSleep)
    expect(verdict.outcome).toBe('unknown')
  })

  it('невалідні умови — спроби не було, і мережу не турбували', async () => {
    const rpc = chargeRpc({ statuses: [] })
    const verdict = await createPlan(rpc, { ...input(), terms: { ...bare(), amount: 0n } }, noSleep)
    expect(verdict.outcome).toBe('not-sent')
    if (verdict.outcome !== 'not-sent') throw new Error('unreachable')
    expect(verdict.detail).toMatch(/PlanAmountError/)
    expect(rpc.sent).toHaveLength(0)
  })
})

describe('describe*', () => {
  it('вердикти називаються прямо', () => {
    expect(
      describeCreatePlanVerdict({
        outcome: 'created',
        pda: SOMEWHERE,
        signature: 'sig' as Signature,
        slot: 5n,
      }),
    ).toMatch(/^CREATED {7}slot 5/)
    expect(
      describeCreatePlanVerdict({
        outcome: 'rejected',
        pda: SOMEWHERE,
        signature: 'sig' as Signature,
        slot: 5n,
        error: { InstructionError: [0n, { Custom: 509n }] },
        programErrorCode: 509,
      }),
    ).toMatch(/program error 509/)
    expect(
      describeCreatePlanVerdict({ outcome: 'not-sent', pda: null, signature: null, detail: 'x' }),
    ).toBe('NOT SENT      x')
  })

  it('знімок плану друкує «never» і «(none)» замість нулів і порожніх рядків', () => {
    const text = describePlan({
      pda: SOMEWHERE,
      owner: merchant.address,
      status: 'active',
      planId: PLAN_ID,
      mint: MINT,
      amount: AMOUNT,
      periodHours: PERIOD_HOURS,
      createdAt: null,
      endsAt: null,
      destinations: [merchant.address],
      pullers: [merchant.address],
      metadataUri: '',
    })
    expect(text).toContain('ends:         never')
    expect(text).toContain('metadata:     (none)')
    expect(text).toContain('created:      not stamped')
    expect(text).toContain('period:       720 h')
  })
})

describe('PlanReaderRpc', () => {
  it('справжній клієнт мережі відповідає типу читача плану', () => {
    const client = createChainClient({
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      usdcMint: MINT,
    })
    const reader: PlanReaderRpc = client.rpc
    const sender: ChargeRpc = client.rpc
    expect(typeof reader.getAccountInfo).toBe('function')
    expect(typeof sender.sendTransaction).toBe('function')
  })
})
