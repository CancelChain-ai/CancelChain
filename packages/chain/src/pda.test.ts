import type { Address } from '@solana/kit'
import { getAddressEncoder, getProgramDerivedAddress, getUtf8Encoder } from '@solana/kit'
import {
  DELEGATION_SEED,
  findFixedDelegationPda,
  findRecurringDelegationPda,
  PLAN_SEED,
  SUBSCRIPTION_AUTHORITY_SEED,
  SUBSCRIPTION_SEED,
} from '@solana/subscriptions'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ADDRESS } from './client.js'
import { findDelegation, findPlan, findSubscription, findSubscriptionAuthority } from './pda.js'

/**
 * Входи фіксовані навмисно: адреси PDA нижче — золоті значення, а не «те, що
 * порахувалося цього разу». Якщо оновлення `@solana/subscriptions` змінить сід
 * або порядок сідів, тест впаде тут, а не на devnet при першому скасуванні.
 */
const USER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' as Address
const OWNER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
const SUBSCRIBER = 'SysvarC1ock11111111111111111111111111111111' as Address
const PLAN_ID = 42n

const GOLDEN = {
  subscriptionAuthority: '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq',
  plan: 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe',
  subscription: '3amcyam5KhjbWJLAMNPiAwpYPcV1atWSppEZK1ABoWBR',
  delegation: '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH',
} as const

/** u64 little-endian, зібраний вручну — щоб порядок байтів перевірявся, а не успадковувався. */
function u64LittleEndian(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8)
  let rest = value
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return bytes
}

const utf8 = getUtf8Encoder()
const addr = getAddressEncoder()

describe('сіди програми', () => {
  it('збігаються з тими, що записані в PLAN.md → Архітектура', () => {
    expect(SUBSCRIPTION_AUTHORITY_SEED).toBe('SubscriptionAuthority')
    expect(PLAN_SEED).toBe('plan')
    expect(SUBSCRIPTION_SEED).toBe('subscription')
  })

  it('дозвіл поза планом має власний префікс, у PLAN.md не записаний', () => {
    expect(DELEGATION_SEED).toBe('delegation')
  })
})

describe('findSubscriptionAuthority', () => {
  it('дає зафіксовану адресу', async () => {
    const pda = await findSubscriptionAuthority({ user: USER, tokenMint: MINT })
    expect(pda.address).toBe(GOLDEN.subscriptionAuthority)
    expect(pda.bump).toBeGreaterThanOrEqual(0)
    expect(pda.bump).toBeLessThanOrEqual(255)
  })

  it('збігається з незалежно зібраним переліком сідів', async () => {
    const [expected] = await getProgramDerivedAddress({
      programAddress: PROGRAM_ADDRESS,
      seeds: [utf8.encode('SubscriptionAuthority'), addr.encode(USER), addr.encode(MINT)],
    })
    const pda = await findSubscriptionAuthority({ user: USER, tokenMint: MINT })
    expect(pda.address).toBe(expected)
  })

  it('розрізняє міни: один користувач в іншому активі — інша адреса', async () => {
    const other = await findSubscriptionAuthority({ user: USER, tokenMint: OWNER })
    expect(other.address).not.toBe(GOLDEN.subscriptionAuthority)
  })

  it('порядок сідів не симетричний: user і mint не взаємозамінні', async () => {
    const swapped = await findSubscriptionAuthority({ user: MINT, tokenMint: USER })
    expect(swapped.address).not.toBe(GOLDEN.subscriptionAuthority)
  })
})

describe('findPlan', () => {
  it('дає зафіксовану адресу', async () => {
    const pda = await findPlan({ owner: OWNER, planId: PLAN_ID })
    expect(pda.address).toBe(GOLDEN.plan)
  })

  it('кодує planId як u64 little-endian', async () => {
    const [expected] = await getProgramDerivedAddress({
      programAddress: PROGRAM_ADDRESS,
      seeds: [utf8.encode('plan'), addr.encode(OWNER), u64LittleEndian(PLAN_ID)],
    })
    const pda = await findPlan({ owner: OWNER, planId: PLAN_ID })
    expect(pda.address).toBe(expected)
  })

  it('number і bigint з тим самим значенням дають ту саму адресу', async () => {
    const asNumber = await findPlan({ owner: OWNER, planId: 42 })
    const asBigInt = await findPlan({ owner: OWNER, planId: 42n })
    expect(asNumber.address).toBe(asBigInt.address)
  })

  it('розрізняє planId понад 2^32 — тобто старші байти не втрачаються', async () => {
    const low = await findPlan({ owner: OWNER, planId: 1n })
    const high = await findPlan({ owner: OWNER, planId: 1n << 32n })
    expect(low.address).not.toBe(high.address)
  })

  it('приймає межі діапазону u64', async () => {
    await expect(findPlan({ owner: OWNER, planId: 0n })).resolves.toBeDefined()
    await expect(
      findPlan({ owner: OWNER, planId: 18_446_744_073_709_551_615n }),
    ).resolves.toBeDefined()
  })

  it('відхиляє planId поза u64 і дробовий', async () => {
    await expect(findPlan({ owner: OWNER, planId: -1n })).rejects.toThrow(/does not fit in u64/)
    await expect(findPlan({ owner: OWNER, planId: 18_446_744_073_709_551_616n })).rejects.toThrow(
      /does not fit in u64/,
    )
    await expect(findPlan({ owner: OWNER, planId: 1.5 })).rejects.toThrow(/whole number/)
  })
})

describe('findSubscription', () => {
  it('дає зафіксовану адресу', async () => {
    const pda = await findSubscription({ planPda: GOLDEN.plan as Address, subscriber: SUBSCRIBER })
    expect(pda.address).toBe(GOLDEN.subscription)
  })

  it('збігається з незалежно зібраним переліком сідів', async () => {
    const [expected] = await getProgramDerivedAddress({
      programAddress: PROGRAM_ADDRESS,
      seeds: [
        utf8.encode('subscription'),
        addr.encode(GOLDEN.plan as Address),
        addr.encode(SUBSCRIBER),
      ],
    })
    const pda = await findSubscription({ planPda: GOLDEN.plan as Address, subscriber: SUBSCRIBER })
    expect(pda.address).toBe(expected)
  })

  it("прив'язана до плану: той самий підписник в іншому плані — інша адреса", async () => {
    const other = await findSubscription({ planPda: OWNER, subscriber: SUBSCRIBER })
    expect(other.address).not.toBe(GOLDEN.subscription)
  })
})

describe('findDelegation', () => {
  it('дає зафіксовану адресу', async () => {
    const pda = await findDelegation({
      subscriptionAuthority: GOLDEN.subscriptionAuthority as Address,
      delegator: USER,
      delegatee: OWNER,
      nonce: 0n,
    })
    expect(pda.address).toBe(GOLDEN.delegation)
  })

  it('збігається з незалежно зібраним переліком сідів, nonce — u64 LE', async () => {
    const [expected] = await getProgramDerivedAddress({
      programAddress: PROGRAM_ADDRESS,
      seeds: [
        utf8.encode('delegation'),
        addr.encode(GOLDEN.subscriptionAuthority as Address),
        addr.encode(USER),
        addr.encode(OWNER),
        u64LittleEndian(0n),
      ],
    })
    const pda = await findDelegation({
      subscriptionAuthority: GOLDEN.subscriptionAuthority as Address,
      delegator: USER,
      delegatee: OWNER,
      nonce: 0n,
    })
    expect(pda.address).toBe(expected)
  })

  it('nonce розводить кілька дозволів однієї пари «гаманець ↔ мерчант»', async () => {
    const seeds = {
      subscriptionAuthority: GOLDEN.subscriptionAuthority as Address,
      delegator: USER,
      delegatee: OWNER,
    }
    const first = await findDelegation({ ...seeds, nonce: 0n })
    const second = await findDelegation({ ...seeds, nonce: 1n })
    expect(first.address).not.toBe(second.address)
  })

  it('відхиляє nonce поза u64', async () => {
    await expect(
      findDelegation({
        subscriptionAuthority: GOLDEN.subscriptionAuthority as Address,
        delegator: USER,
        delegatee: OWNER,
        nonce: -1n,
      }),
    ).rejects.toThrow(/does not fit in u64/)
  })

  /**
   * Не курйоз, а обмеження, на яке спираються `T015` і `T019`: тип дозволу
   * не читається з адреси. Якщо SDK колись розведе ці деривації, тест впаде —
   * і це саме те, про що треба дізнатися одразу.
   */
  it('фіксований і періодичний дозволи мають ОДНАКОВУ адресу', async () => {
    const seeds = {
      subscriptionAuthority: GOLDEN.subscriptionAuthority as Address,
      delegator: USER,
      delegatee: OWNER,
      nonce: 7n,
    }
    const [recurring] = await findRecurringDelegationPda(seeds)
    const [fixed] = await findFixedDelegationPda(seeds)
    expect(recurring).toBe(fixed)
  })
})

describe('усі чотири деривації', () => {
  it('дають різні адреси на однакових входах', async () => {
    const addresses = new Set(Object.values(GOLDEN))
    expect(addresses.size).toBe(4)
  })

  it('детерміновані — повторний виклик дає той самий результат', async () => {
    const first = await findSubscriptionAuthority({ user: USER, tokenMint: MINT })
    const second = await findSubscriptionAuthority({ user: USER, tokenMint: MINT })
    expect(first).toEqual(second)
  })
})
