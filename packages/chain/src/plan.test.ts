import type { Address } from '@solana/kit'
import { generateKeyPairSigner, getBase64Decoder } from '@solana/kit'
import {
  AccountDiscriminator,
  getPlanEncoder,
  type PlanArgs,
  PlanStatus,
  ZERO_ADDRESS,
} from '@solana/subscriptions'
import { beforeAll, describe, expect, it } from 'vitest'
import { createChainClient, PROGRAM_ADDRESS } from './client.js'
import { NotAPlanError, PlanNotFoundError, type PlanReaderRpc, readPlan } from './plan.js'

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const OTHER_WALLET = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq' as Address
const SOMEWHERE = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH' as Address

const PLAN_ID = 1_758_456_000_000n
const AMOUNT = 9_990_000n
const PERIOD_HOURS = 720
const NEXT_YEAR = '2027-09-21T12:00:00.000Z'
const NEXT_YEAR_SECONDS = 1_821_528_000n

let merchant: Address

beforeAll(async () => {
  merchant = (await generateKeyPairSigner()).address
})

const pad = (wallets: readonly string[]): Address[] =>
  Array.from({ length: 4 }, (_, index) => (wallets[index] ?? ZERO_ADDRESS) as Address)

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
    owner: merchant,
    bump: 254,
    status,
    data: {
      planId: PLAN_ID,
      mint: MINT,
      terms: { amount: AMOUNT, periodHours: BigInt(PERIOD_HOURS), createdAt: 1_758_456_000n },
      endTs: 0n,
      destinations: pad([merchant]),
      pullers: pad([merchant]),
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
    expect(snapshot.destinations).toEqual([merchant])
    expect(snapshot.pullers).toEqual([merchant])
    expect(snapshot.createdAt).toBe('2025-09-21T12:00:00.000Z')
    expect(snapshot.status).toBe('active')
  })

  it('усе, що піде в офчейн-рядок, читається з мережі, крім назви', async () => {
    const snapshot = await readPlan(
      planReader({ [SOMEWHERE]: encodeAccount(storedPlan()) }),
      SOMEWHERE,
    )
    expect(snapshot.owner).toBe(merchant)
    expect(snapshot.planId).toBe(PLAN_ID)
    expect(snapshot.amount).toBe(AMOUNT)
    expect(snapshot.periodHours).toBe(PERIOD_HOURS)
    expect(snapshot.mint).toBe(MINT)
    // Назви в акаунті немає взагалі — її тримає `plans` (`T035`).
    expect(snapshot).not.toHaveProperty('name')
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

describe('PlanReaderRpc', () => {
  it('справжній клієнт мережі відповідає типу читача плану', () => {
    const client = createChainClient({
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      usdcMint: MINT,
    })
    const reader: PlanReaderRpc = client.rpc
    expect(typeof reader.getAccountInfo).toBe('function')
  })
})
