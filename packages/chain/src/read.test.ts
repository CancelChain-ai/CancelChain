import type { Address, Base64EncodedBytes, ReadonlyUint8Array, Slot } from '@solana/kit'
import { getBase64Decoder, lamports } from '@solana/kit'
import {
  AccountDiscriminator,
  DELEGATOR_OFFSET,
  type FixedDelegationArgs,
  getFixedDelegationEncoder,
  getPlanEncoder,
  getRecurringDelegationEncoder,
  getSubscriptionDelegationEncoder,
  type HeaderArgs,
  PLAN_SIZE,
  type PlanArgs,
  type PlanDataArgs,
  type RawProgramAccount,
  type RecurringDelegationArgs,
  type SubscriptionDelegationArgs,
  ZERO_ADDRESS,
} from '@solana/subscriptions'
import { describe, expect, it } from 'vitest'
import { createChainClient, PROGRAM_ADDRESS } from './client.js'
import { findSubscription } from './pda.js'
import { type AllowanceReader, type ProgramAccountsRpc, readAllowances } from './read.js'

const OWNER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const MERCHANT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
const PAYER = 'SysvarC1ock11111111111111111111111111111111' as Address
const AUTHORITY = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq' as Address
const MINT_A = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address
const MINT_B = 'So11111111111111111111111111111111111111112' as Address
const PLAN_A = 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe' as Address
const PLAN_B = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' as Address
const FIXED_PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH' as Address
const RECURRING_PDA = 'Stake11111111111111111111111111111111111111' as Address
const JUNK_PDA = 'Vote111111111111111111111111111111111111111' as Address
const NOT_THE_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' as Address

const NOW = new Date('2026-09-02T00:00:00.000Z')
const NOW_TS = BigInt(Math.floor(NOW.getTime() / 1000))
const SLOT = 412_345_678n as Slot

/** Адреса підписки не вигадується: її дає та сама деривація, що й у мережі. */
const SUB_PDA = (await findSubscription({ planPda: PLAN_A, subscriber: OWNER })).address
const OTHER_SUB_PDA = (await findSubscription({ planPda: PLAN_B, subscriber: OWNER })).address

function header(
  discriminator: AccountDiscriminator,
  overrides: Partial<HeaderArgs> = {},
): HeaderArgs {
  return {
    discriminator,
    version: 1,
    bump: 254,
    delegator: OWNER,
    delegatee: MERCHANT,
    payer: PAYER,
    initId: 7n,
    ...overrides,
  }
}

const FIXED: FixedDelegationArgs = {
  header: header(AccountDiscriminator.FixedDelegation),
  subscriptionAuthority: AUTHORITY,
  mint: MINT_A,
  amount: 25_000_000n,
  expiryTs: NOW_TS + 86_400n,
}

const RECURRING: RecurringDelegationArgs = {
  header: header(AccountDiscriminator.RecurringDelegation),
  subscriptionAuthority: AUTHORITY,
  mint: MINT_B,
  currentPeriodStartTs: NOW_TS - 86_400n,
  periodLengthS: 2_592_000n,
  expiryTs: 0n,
  amountPerPeriod: 12_000_000n,
  amountPulledInPeriod: 3_000_000n,
}

/**
 * У підписки в полі `delegatee` лежить **адреса плану**, а не гаманець
 * мерчанта. Це поведінка справжніх акаунтів devnet, і саме на неї спирається
 * пряме читання плану.
 */
const SUBSCRIPTION: SubscriptionDelegationArgs = {
  header: header(AccountDiscriminator.SubscriptionDelegation, { delegatee: PLAN_A }),
  terms: { amount: 11_500_000n, periodHours: 720n, createdAt: NOW_TS - 172_800n },
  amountPulledInPeriod: 1_000_000n,
  currentPeriodStartTs: NOW_TS - 86_400n,
  expiresAtTs: 0n,
}

type PlanOverrides = Omit<Partial<PlanArgs>, 'data'> & { data?: Partial<PlanDataArgs> }

function plan(overrides: PlanOverrides = {}, mint: Address = MINT_A): PlanArgs {
  return {
    discriminator: AccountDiscriminator.Plan,
    owner: MERCHANT,
    bump: 253,
    status: 0,
    ...overrides,
    data: {
      planId: 1n,
      mint,
      terms: { amount: 11_500_000n, periodHours: 720n, createdAt: NOW_TS - 172_800n },
      endTs: 0n,
      destinations: [MERCHANT, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS],
      pullers: [MERCHANT, ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS],
      metadataUri: 'https://example.invalid/plan',
      ...overrides.data,
    },
  }
}

const encodeFixed = (args: FixedDelegationArgs) => getFixedDelegationEncoder().encode(args)
const encodeRecurring = (args: RecurringDelegationArgs) =>
  getRecurringDelegationEncoder().encode(args)
const encodeSubscription = (args: SubscriptionDelegationArgs) =>
  getSubscriptionDelegationEncoder().encode(args)
const encodePlan = (args: PlanArgs) => getPlanEncoder().encode(args)

function account(
  pubkey: Address,
  data: ReadonlyUint8Array,
  owner: Address = PROGRAM_ADDRESS,
): RawProgramAccount {
  return {
    pubkey,
    account: {
      data: [getBase64Decoder().decode(data) as Base64EncodedBytes, 'base64'],
      executable: false,
      lamports: lamports(2_039_280n),
      owner,
      space: BigInt(data.length),
    },
  }
}

const fixedAccount = () => account(FIXED_PDA, encodeFixed(FIXED))
const recurringAccount = () => account(RECURRING_PDA, encodeRecurring(RECURRING))
const subscriptionAccount = (overrides: Partial<HeaderArgs> = {}) =>
  account(
    SUB_PDA,
    encodeSubscription({
      ...SUBSCRIPTION,
      header: header(AccountDiscriminator.SubscriptionDelegation, {
        delegatee: PLAN_A,
        ...overrides,
      }),
    }),
  )
const planA = () => account(PLAN_A, encodePlan(plan()))
/** Справжній план того ж мерчанта — але **не** план цієї підписки. */
const planB = () => account(PLAN_B, encodePlan(plan({ data: { planId: 2n } }, MINT_B)))

type ProgramAccountsConfig = Parameters<ProgramAccountsRpc['getProgramAccounts']>[1]
type Call =
  | { kind: 'program'; program: Address; config: ProgramAccountsConfig }
  | { kind: 'multiple'; addresses: readonly Address[] }

type World = {
  /** Що віддасть запит по дозволах власника. */
  delegations?: RawProgramAccount[]
  /** Що лежить у мережі за конкретними адресами (`getMultipleAccounts`). */
  atAddress?: RawProgramAccount[]
  /** Що віддасть повний прохід по планах. */
  allPlans?: RawProgramAccount[]
}

/**
 * RPC, який відповідає за змістом запиту, а не за порядком викликів: інакше
 * тест на «другий прохід не запускається» перевіряв би чергу, а не поведінку.
 */
function fakeRpc(world: World, slot: Slot = SLOT) {
  const calls: Call[] = []
  const byAddress = new Map((world.atAddress ?? []).map((raw) => [raw.pubkey, raw]))
  const rpc: ProgramAccountsRpc = {
    getProgramAccounts(program, config) {
      calls.push({ kind: 'program', program, config })
      const plans = (config.filters ?? []).some((filter) => 'dataSize' in filter)
      const value = plans ? (world.allPlans ?? []) : (world.delegations ?? [])
      return { send: async () => ({ context: { slot }, value }) }
    },
    getMultipleAccounts(addresses) {
      calls.push({ kind: 'multiple', addresses })
      const value = addresses.map((address) => byAddress.get(address)?.account ?? null)
      return { send: async () => ({ context: { slot }, value }) }
    },
  }
  const reader: AllowanceReader = { rpc, programAddress: PROGRAM_ADDRESS, usdcMint: MINT_A }
  return { reader, calls }
}

const read = (reader: AllowanceReader, options: { fullPlanScan?: boolean } = {}) =>
  readAllowances(reader, { owner: OWNER, now: NOW, ...options })

describe('AllowanceReader', () => {
  it('справжній клієнт мережі відповідає типу читача', () => {
    const client = createChainClient({
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      usdcMint: MINT_A,
    })
    const reader: AllowanceReader = client
    expect(reader.programAddress).toBe(PROGRAM_ADDRESS)
    expect(reader.usdcMint).toBe(MINT_A)
    expect(typeof reader.rpc.getProgramAccounts).toBe('function')
    expect(typeof reader.rpc.getMultipleAccounts).toBe('function')
  })
})

describe('запит по дозволах — FR-006', () => {
  it('фільтрує лише за власником і нічим більше', async () => {
    const { reader, calls } = fakeRpc({ delegations: [fixedAccount()] })
    await read(reader)

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.kind).toBe('program')
    if (call?.kind !== 'program') return
    expect(call.program).toBe(PROGRAM_ADDRESS)
    expect(call.config.encoding).toBe('base64')
    expect(call.config.withContext).toBe(true)
    expect(call.config.filters).toEqual([
      { memcmp: { bytes: OWNER, encoding: 'base58', offset: BigInt(DELEGATOR_OFFSET) } },
    ])
  })

  /**
   * Найдорожча помилка цієї задачі виглядала б як звуження запиту: фільтр за
   * мерчантом, міном або розміром акаунта сховав би дозволи, видані не нашим
   * інтерфейсом, — і список перестав би бути повним, не ставши порожнім.
   */
  it('не звужує запит ані за делегатом, ані за міном, ані за розміром', async () => {
    const { reader, calls } = fakeRpc({ delegations: [fixedAccount()] })
    await read(reader)

    const call = calls[0]
    const filters = call?.kind === 'program' ? (call.config.filters ?? []) : []
    expect(filters).toHaveLength(1)
    expect(filters.some((filter) => 'dataSize' in filter)).toBe(false)
  })

  it('не питає планів, коли підписок немає', async () => {
    const { reader, calls } = fakeRpc({ delegations: [fixedAccount(), recurringAccount()] })
    const result = await read(reader)

    expect(calls).toHaveLength(1)
    expect(result.allowances).toHaveLength(2)
  })

  it('порожній гаманець — порожній список без помилок', async () => {
    const { reader, calls } = fakeRpc({})
    const result = await read(reader)

    expect(result.allowances).toEqual([])
    expect(result.unreadable).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('передає commitment у запит, коли його задано', async () => {
    const { reader, calls } = fakeRpc({})
    await readAllowances(reader, { owner: OWNER, now: NOW, commitment: 'finalized' })

    const call = calls[0]
    expect(call?.kind === 'program' && call.config.commitment).toBe('finalized')
  })
})

describe('усі три типи дозволу в одному списку', () => {
  it('fixed, recurring і subscription читаються разом', async () => {
    const { reader } = fakeRpc({
      delegations: [fixedAccount(), recurringAccount(), subscriptionAccount()],
      atAddress: [planA()],
    })
    const result = await read(reader)

    expect(result.unreadable).toEqual([])
    expect(result.allowances.map((allowance) => allowance.kind).sort()).toEqual([
      'fixed',
      'recurring',
      'subscription',
    ])
  })

  it('слот і мітка свіжості спільні для всього списку', async () => {
    const { reader } = fakeRpc({ delegations: [fixedAccount(), recurringAccount()] })
    const result = await read(reader)

    expect(result.slot).toBe(412_345_678)
    expect(result.syncedAt).toBe(NOW.toISOString())
    for (const allowance of result.allowances) {
      expect(allowance.lastSlot).toBe(412_345_678)
      expect(allowance.syncedAt).toBe(NOW.toISOString())
    }
  })

  it('слот поза безпечним цілим не ріжеться мовчки', async () => {
    const { reader } = fakeRpc({}, (2n ** 64n - 1n) as Slot)
    await expect(read(reader)).rejects.toThrow(RangeError)
  })

  /** Порядок мережі не визначений: вхід відсортований навпаки, вихід — за адресою. */
  it('список відсортовано за адресою, а не за порядком мережі', async () => {
    const accounts = [fixedAccount(), recurringAccount(), subscriptionAccount()]
    const { reader } = fakeRpc({
      delegations: [...accounts].sort((a, b) => (a.pubkey < b.pubkey ? 1 : -1)),
      atAddress: [planA()],
    })
    const result = await read(reader)

    expect(result.allowances.map((allowance) => allowance.pda)).toEqual(
      [FIXED_PDA, RECURRING_PDA, SUB_PDA].sort(),
    )
  })
})

describe('план для підписки — другий запит', () => {
  it('мін і planPda приходять із плану, бо в акаунті підписки їх немає', async () => {
    const { reader, calls } = fakeRpc({
      delegations: [subscriptionAccount()],
      atAddress: [planA()],
    })
    const result = await read(reader)

    expect(calls).toHaveLength(2)
    const allowance = result.allowances[0]
    expect(allowance?.kind).toBe('subscription')
    expect(allowance?.mint).toBe(MINT_A)
    expect(allowance?.planPda).toBe(PLAN_A)
    expect(allowance?.capAmount).toBe('11500000')
    expect(allowance?.periodSeconds).toBe(720 * 3600)
  })

  /** Пряме посилання: план читається за адресою із заголовка, без перебору. */
  it('план береться за адресою з `delegatee`, одним getMultipleAccounts', async () => {
    const { reader, calls } = fakeRpc({
      delegations: [subscriptionAccount()],
      atAddress: [planA()],
    })
    await read(reader)

    expect(calls[1]).toEqual({ kind: 'multiple', addresses: [PLAN_A] })
  })

  it('однакові плани не питаються двічі', async () => {
    const { reader, calls } = fakeRpc({
      delegations: [subscriptionAccount(), subscriptionAccount()],
      atAddress: [planA()],
    })
    await read(reader)

    expect(calls[1]).toEqual({ kind: 'multiple', addresses: [PLAN_A] })
  })

  /**
   * Головна перевірка задачі: посилання із заголовка веде на справжній план —
   * але **чужий**. Деривація його відкидає, і замість чужого міну спрацьовує
   * прохід по всіх планах, який знаходить правильний.
   */
  it('план не з тієї підписки відкидається деривацією, а не приймається', async () => {
    const world: World = {
      delegations: [subscriptionAccount({ delegatee: PLAN_B })],
      atAddress: [planB()],
      allPlans: [planB(), planA()],
    }
    const { reader, calls } = fakeRpc(world)
    const result = await read(reader)

    expect(result.allowances[0]?.planPda).toBe(PLAN_A)
    expect(result.allowances[0]?.mint).toBe(MINT_A)
    expect(calls).toHaveLength(3)
    expect(OTHER_SUB_PDA).not.toBe(SUB_PDA)
  })

  it('без повного проходу чужий план дає названу відмову, а не чужий мін', async () => {
    const { reader } = fakeRpc({
      delegations: [subscriptionAccount({ delegatee: PLAN_B })],
      atAddress: [planB()],
      allPlans: [planA()],
    })
    const result = await read(reader, { fullPlanScan: false })

    expect(result.allowances).toEqual([])
    expect(result.unreadable).toEqual([
      { address: SUB_PDA, reason: 'plan', detail: expect.stringContaining('needs its plan') },
    ])
  })

  it('повного проходу не роблять, коли план знайдено за посиланням', async () => {
    const { reader, calls } = fakeRpc({
      delegations: [subscriptionAccount()],
      atAddress: [planA()],
      allPlans: [planA()],
    })
    await read(reader)

    expect(calls.filter((call) => call.kind === 'program')).toHaveLength(1)
  })

  it('решта списку ціла, коли план однієї підписки не знайшовся', async () => {
    const { reader } = fakeRpc({ delegations: [subscriptionAccount(), fixedAccount()] })
    const result = await read(reader)

    expect(result.allowances.map((allowance) => allowance.pda)).toEqual([FIXED_PDA])
    expect(result.unreadable[0]).toMatchObject({ address: SUB_PDA, reason: 'plan' })
  })

  it('акаунт чужої програми за адресою плану не приймається за план', async () => {
    const { reader } = fakeRpc({
      delegations: [subscriptionAccount()],
      atAddress: [account(PLAN_A, encodePlan(plan()), NOT_THE_PROGRAM)],
    })
    const result = await read(reader, { fullPlanScan: false })

    expect(result.allowances).toEqual([])
    expect(result.unreadable[0]?.reason).toBe('plan')
  })

  it('акаунт потрібного розміру, але не план, теж не приймається', async () => {
    const { reader } = fakeRpc({
      delegations: [subscriptionAccount()],
      atAddress: [account(PLAN_A, new Uint8Array(PLAN_SIZE))],
    })
    const result = await read(reader, { fullPlanScan: false })

    expect(result.allowances).toEqual([])
    expect(result.unreadable[0]?.reason).toBe('plan')
  })
})

describe('нечитаний акаунт не коротшає список мовчки', () => {
  const junk = () => {
    const data = new Uint8Array(187)
    data[0] = 9
    return data
  }

  it('невідомий дискримінатор названий, решта списку ціла', async () => {
    const { reader } = fakeRpc({ delegations: [account(JUNK_PDA, junk()), fixedAccount()] })
    const result = await read(reader)

    expect(result.allowances.map((allowance) => allowance.pda)).toEqual([FIXED_PDA])
    expect(result.unreadable).toEqual([
      {
        address: JUNK_PDA,
        reason: 'discriminator',
        detail: expect.stringContaining('discriminator'),
      },
    ])
  })

  it('обрізаний акаунт — причина «length»', async () => {
    const truncated = (encodeFixed(FIXED) as Uint8Array).slice(0, 100)
    const { reader } = fakeRpc({ delegations: [account(JUNK_PDA, truncated), fixedAccount()] })
    const result = await read(reader)

    expect(result.unreadable[0]).toMatchObject({ address: JUNK_PDA, reason: 'length' })
    expect(result.allowances).toHaveLength(1)
  })

  it('порожні дані — причина «empty»', async () => {
    const { reader } = fakeRpc({
      delegations: [account(JUNK_PDA, new Uint8Array(0)), fixedAccount()],
    })
    const result = await read(reader)

    expect(result.unreadable[0]).toMatchObject({ address: JUNK_PDA, reason: 'empty' })
    expect(result.allowances).toHaveLength(1)
  })

  it('чужа версія акаунта — причина «version», поля не читаються', async () => {
    const other = encodeFixed({
      ...FIXED,
      header: header(AccountDiscriminator.FixedDelegation, { version: 2 }),
    })
    const { reader } = fakeRpc({ delegations: [account(JUNK_PDA, other), fixedAccount()] })
    const result = await read(reader)

    expect(result.unreadable[0]).toMatchObject({ address: JUNK_PDA, reason: 'version' })
    expect(result.unreadable[0]?.detail).toContain('account version 2')
    expect(result.allowances).toHaveLength(1)
  })

  it('значення поля поза моделлю — причина «fields»', async () => {
    const zeroPeriod = encodeRecurring({ ...RECURRING, periodLengthS: 0n })
    const { reader } = fakeRpc({ delegations: [account(JUNK_PDA, zeroPeriod), fixedAccount()] })
    const result = await read(reader)

    expect(result.unreadable[0]).toMatchObject({ address: JUNK_PDA, reason: 'fields' })
    expect(result.allowances).toHaveLength(1)
  })

  it('перелік нечитаних теж відсортовано за адресою', async () => {
    const { reader } = fakeRpc({
      delegations: [
        account(RECURRING_PDA, junk()),
        account(FIXED_PDA, junk()),
        account(JUNK_PDA, junk()),
      ],
    })
    const result = await read(reader)

    expect(result.unreadable.map((entry) => entry.address)).toEqual(
      [FIXED_PDA, RECURRING_PDA, JUNK_PDA].sort(),
    )
  })
})

describe('непідтримуваний актив — FR-020', () => {
  const supportedOf = (result: { allowances: { pda: string; assetSupported: boolean }[] }) =>
    Object.fromEntries(result.allowances.map((a) => [a.pda, a.assetSupported]))

  it('дозвіл у розрахунковому активі позначено підтримуваним', async () => {
    const { reader } = fakeRpc({ delegations: [fixedAccount()] })
    const result = await read(reader)

    expect(result.allowances[0]?.mint).toBe(MINT_A)
    expect(result.allowances[0]?.assetSupported).toBe(true)
  })

  /**
   * Ключове для `FR-020` разом із `FR-006`: чужий актив **не** зникає зі списку
   * і не їде в `unreadable`. Він показується — інакше зник би і єдиний спосіб
   * такий дозвіл скасувати.
   */
  it('дозвіл у чужому активі лишається в списку з позначкою', async () => {
    const { reader } = fakeRpc({ delegations: [recurringAccount()] })
    const result = await read(reader)

    expect(result.unreadable).toEqual([])
    expect(result.allowances).toHaveLength(1)
    expect(result.allowances[0]?.mint).toBe(MINT_B)
    expect(result.allowances[0]?.assetSupported).toBe(false)
  })

  it('позначка не коротшає список: змішаний гаманець віддає всі три дозволи', async () => {
    const { reader } = fakeRpc({
      delegations: [fixedAccount(), recurringAccount(), subscriptionAccount()],
      atAddress: [planA()],
    })
    const result = await read(reader)

    expect(result.allowances).toHaveLength(3)
    expect(supportedOf(result)).toEqual({
      [FIXED_PDA]: true,
      [RECURRING_PDA]: false,
      [SUB_PDA]: true,
    })
  })

  /** Для підписки актив приносить план, тож і позначка рахується з міну плану. */
  it('для підписки актив береться з плану, а не з акаунта підписки', async () => {
    const { reader } = fakeRpc({
      delegations: [subscriptionAccount({ delegatee: PLAN_B })],
      atAddress: [planB()],
      allPlans: [planB()],
    })
    const result = await read(reader, { fullPlanScan: false })
    expect(result.allowances).toEqual([])

    const other = fakeRpc({
      delegations: [
        account(
          OTHER_SUB_PDA,
          encodeSubscription({
            ...SUBSCRIPTION,
            header: header(AccountDiscriminator.SubscriptionDelegation, { delegatee: PLAN_B }),
          }),
        ),
      ],
      atAddress: [planB()],
    })
    const resolved = await read(other.reader)

    expect(resolved.allowances[0]?.planPda).toBe(PLAN_B)
    expect(resolved.allowances[0]?.mint).toBe(MINT_B)
    expect(resolved.allowances[0]?.assetSupported).toBe(false)
  })

  /**
   * Розрахунковий актив — конфігурація, не константа: на devnet це не той мін,
   * що на mainnet. Той самий дозвіл при іншому налаштуванні міняє позначку.
   */
  it('позначку задає розрахунковий актив із конфігурації', async () => {
    const { reader } = fakeRpc({ delegations: [recurringAccount()] })
    const asDevnet: AllowanceReader = { ...reader, usdcMint: MINT_B }

    expect((await read(reader)).allowances[0]?.assetSupported).toBe(false)
    expect((await read(asDevnet)).allowances[0]?.assetSupported).toBe(true)
  })

  it('нечитаний акаунт позначки не отримує — його активу ніхто не знає', async () => {
    const data = new Uint8Array(187)
    data[0] = 9
    const { reader } = fakeRpc({ delegations: [account(JUNK_PDA, data)] })
    const result = await read(reader)

    expect(result.allowances).toEqual([])
    expect(result.unreadable[0]).toEqual({
      address: JUNK_PDA,
      reason: 'discriminator',
      detail: expect.stringContaining('discriminator'),
    })
  })
})
