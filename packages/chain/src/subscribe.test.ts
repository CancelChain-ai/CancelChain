import type { Address, Instruction } from '@solana/kit'
import { createNoopSigner, getBase64Decoder } from '@solana/kit'
import {
  AccountDiscriminator,
  getRevokeSubscriptionAuthorityOverlayInstructionAsync,
  getSubscriptionAuthorityEncoder,
  identifySubscriptionsInstruction,
  parseInitSubscriptionAuthorityInstruction,
  parseSubscribeInstruction,
  SubscriptionsInstruction,
  UNKNOWN_INIT_ID,
} from '@solana/subscriptions'
import { beforeAll, describe, expect, it } from 'vitest'
import { PROGRAM_ADDRESS } from './client.js'
import { buildGrantInstruction } from './grant.js'
import { findPlan, findSubscription, findSubscriptionAuthority } from './pda.js'
import type { PlanReaderRpc } from './plan.js'
import {
  buildSubscribeInstruction,
  buildSubscribeInstructions,
  findAssociatedTokenAccount,
  MintNotFoundError,
  NotAnAuthorityError,
  readSubscribeBounds,
  readSubscriberState,
  readSubscriptionAuthority,
  SubscribeBoundsError,
  SubscribeInitIdMismatchError,
  SubscribeMissingCreatedAtError,
  type SubscribePlan,
  SubscribePlanAddressError,
  SubscribePlanClosedError,
  subscribeBoundsAsPlanTerms,
} from './subscribe.js'

const MERCHANT = 'FGHMNoGvR5zP9K5Cs4XrwZhQnAxNrFEQYH3TK22fBkKF' as Address
const SUBSCRIBER = '4DYhzGx6zWLmFDCBLJfCyRpTBnJnbfLqzHz7BvUJBFHU' as Address
const SPONSOR = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' as Address
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
const USER_ATA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH' as Address

const PLAN_ID = 1_758_456_000_000n
const AMOUNT = 9_990_000n
const PERIOD_HOURS = 720
const CREATED_AT = '2026-09-21T10:00:00.000Z'
const CREATED_AT_SECONDS = 1_789_984_800n
const INIT_ID = 4_211_337n
const NOW = new Date('2026-09-26T12:00:00.000Z')

const subscriber = createNoopSigner(SUBSCRIBER)
const sponsor = createNoopSigner(SPONSOR)

let PLAN: SubscribePlan

beforeAll(async () => {
  const { address } = await findPlan({ owner: MERCHANT, planId: PLAN_ID })
  PLAN = {
    pda: address,
    owner: MERCHANT,
    planId: PLAN_ID,
    mint: MINT,
    amount: AMOUNT,
    periodHours: PERIOD_HOURS,
    createdAt: CREATED_AT,
    status: 'active',
    endsAt: null,
  }
})

type Parsable = Parameters<typeof parseSubscribeInstruction>[0]
const parsable = (instruction: Instruction) => instruction as Parsable

const subscribe = (extra: Partial<Parameters<typeof buildSubscribeInstruction>[0]> = {}) =>
  buildSubscribeInstruction({
    plan: PLAN,
    subscriber,
    authorityInitId: INIT_ID,
    now: NOW,
    ...extra,
  })

describe('round-trip: encode → decode → equality', () => {
  it('every field of the subscribe data comes back as it went in, the bump included', async () => {
    const parsed = parseSubscribeInstruction(parsable(await subscribe()))
    const { bump } = await findPlan({ owner: MERCHANT, planId: PLAN_ID })
    expect(parsed.data.subscribeData).toEqual({
      planId: PLAN_ID,
      planBump: bump,
      expectedMint: MINT,
      expectedAmount: AMOUNT,
      expectedPeriodHours: BigInt(PERIOD_HOURS),
      expectedCreatedAt: CREATED_AT_SECONDS,
      expectedSubscriptionAuthorityInitId: INIT_ID,
    })
  })

  it('the accounts are the ones the program derives', async () => {
    const parsed = parseSubscribeInstruction(parsable(await subscribe()))
    const authority = await findSubscriptionAuthority({ user: SUBSCRIBER, tokenMint: MINT })
    const subscription = await findSubscription({ planPda: PLAN.pda, subscriber: SUBSCRIBER })
    expect(parsed.accounts.subscriber.address).toBe(SUBSCRIBER)
    expect(parsed.accounts.merchant.address).toBe(MERCHANT)
    expect(parsed.accounts.planPda.address).toBe(PLAN.pda)
    expect(parsed.accounts.subscriptionAuthorityPda.address).toBe(authority.address)
    expect(parsed.accounts.subscriptionPda.address).toBe(subscription.address)
    expect(parsed.programAddress).toBe(PROGRAM_ADDRESS)
  })

  it('without a payer there is no payer account: the subscriber pays, and nobody else is named', async () => {
    const parsed = parseSubscribeInstruction(parsable(await subscribe()))
    expect(parsed.accounts.payer).toBeUndefined()
    const sponsored = parseSubscribeInstruction(parsable(await subscribe({ payer: sponsor })))
    expect(sponsored.accounts.payer?.address).toBe(SPONSOR)
  })

  it("'same-transaction' goes out as the SDK sentinel, not as zero", async () => {
    const [init, sub] = await buildSubscribeInstructions({
      plan: PLAN,
      subscriber,
      authorityInitId: 'same-transaction',
      initAuthority: { tokenProgram: TOKEN_PROGRAM, userAta: USER_ATA },
      now: NOW,
    })
    if (init === undefined || sub === undefined) throw new Error('expected two instructions')
    expect(identifySubscriptionsInstruction(parsable(init))).toBe(
      SubscriptionsInstruction.InitSubscriptionAuthority,
    )
    const initParsed = parseInitSubscriptionAuthorityInstruction(
      init as Parameters<typeof parseInitSubscriptionAuthorityInstruction>[0],
    )
    expect(initParsed.accounts.owner.address).toBe(SUBSCRIBER)
    expect(initParsed.accounts.tokenMint.address).toBe(MINT)
    expect(initParsed.accounts.userAta.address).toBe(USER_ATA)
    expect(
      parseSubscribeInstruction(parsable(sub)).data.subscribeData
        .expectedSubscriptionAuthorityInitId,
    ).toBe(UNKNOWN_INIT_ID)
  })

  it('the creation time survives chain seconds → ISO → chain seconds exactly', async () => {
    const bounds = readSubscribeBounds([await subscribe()])
    expect(bounds.createdAt).toBe(CREATED_AT_SECONDS)
    expect(subscribeBoundsAsPlanTerms(bounds).createdAt).toBe(CREATED_AT)
  })
})

describe('readSubscribeBounds — what the screen shows is read out of the instructions', () => {
  it('reads the terms, the parties and the new account', async () => {
    const bounds = readSubscribeBounds([await subscribe()])
    const subscription = await findSubscription({ planPda: PLAN.pda, subscriber: SUBSCRIBER })
    expect(bounds).toEqual({
      plan: PLAN.pda,
      merchant: MERCHANT,
      subscriber: SUBSCRIBER,
      subscription: subscription.address,
      planId: PLAN_ID,
      mint: MINT,
      amount: AMOUNT,
      periodHours: BigInt(PERIOD_HOURS),
      createdAt: CREATED_AT_SECONDS,
      authorityInitId: INIT_ID,
      initsAuthority: false,
    })
  })

  it('names an authority created in the same transaction', async () => {
    const bounds = readSubscribeBounds(
      await buildSubscribeInstructions({
        plan: PLAN,
        subscriber,
        authorityInitId: 'same-transaction',
        initAuthority: { tokenProgram: TOKEN_PROGRAM, userAta: USER_ATA },
        now: NOW,
      }),
    )
    expect(bounds.initsAuthority).toBe(true)
    expect(bounds.authorityInitId).toBe('same-transaction')
  })

  it('converts to the catalog shape: seconds, ISO, decimal string', async () => {
    expect(subscribeBoundsAsPlanTerms(readSubscribeBounds([await subscribe()]))).toEqual({
      mint: MINT,
      amount: '9990000',
      periodSeconds: PERIOD_HOURS * 3600,
      createdAt: CREATED_AT,
    })
  })

  it('refuses a list with no subscribe', () => {
    expect(() => readSubscribeBounds([])).toThrow(SubscribeBoundsError)
  })

  it('refuses two subscribes: a summary of the first would hide the second', async () => {
    const one = await subscribe()
    expect(() => readSubscribeBounds([one, one])).toThrow(SubscribeBoundsError)
  })

  it('refuses any other instruction of the program riding along', async () => {
    const grant = await buildGrantInstruction({
      bounds: { kind: 'fixed', delegatee: MERCHANT, capAmount: 1n, expiresAt: null },
      delegator: subscriber,
      tokenMint: MINT,
      nonce: 0n,
      authorityInitId: INIT_ID,
      now: NOW,
    })
    const sub = await subscribe()
    expect(() => readSubscribeBounds([sub, grant])).toThrow(SubscribeBoundsError)
  })

  it('refuses an instruction of another program', async () => {
    const sub = await subscribe()
    const foreign = { ...sub, programAddress: TOKEN_PROGRAM }
    expect(() => readSubscribeBounds([foreign])).toThrow(SubscribeBoundsError)
  })

  it('refuses an authority init after the subscribe', async () => {
    const [init, sub] = await buildSubscribeInstructions({
      plan: PLAN,
      subscriber,
      authorityInitId: 'same-transaction',
      initAuthority: { tokenProgram: TOKEN_PROGRAM, userAta: USER_ATA },
      now: NOW,
    })
    if (init === undefined || sub === undefined) throw new Error('expected two instructions')
    expect(() => readSubscribeBounds([sub, init])).toThrow(SubscribeBoundsError)
  })

  it('refuses a sentinel initId without the init instruction', async () => {
    const [, sub] = await buildSubscribeInstructions({
      plan: PLAN,
      subscriber,
      authorityInitId: 'same-transaction',
      initAuthority: { tokenProgram: TOKEN_PROGRAM, userAta: USER_ATA },
      now: NOW,
    })
    if (sub === undefined) throw new Error('expected a subscribe instruction')
    expect(() => readSubscribeBounds([sub])).toThrow(SubscribeBoundsError)
  })
})

describe('refusals before building', () => {
  it('a snapshot whose address does not match its owner and planId', async () => {
    await expect(subscribe({ plan: { ...PLAN, planId: PLAN_ID + 1n } })).rejects.toThrow(
      SubscribePlanAddressError,
    )
  })

  it('a plan being wound down', async () => {
    await expect(subscribe({ plan: { ...PLAN, status: 'sunset' } })).rejects.toThrow(
      SubscribePlanClosedError,
    )
  })

  it('a plan that has already ended', async () => {
    await expect(
      subscribe({ plan: { ...PLAN, endsAt: '2026-09-26T11:59:59.000Z' } }),
    ).rejects.toThrow(SubscribePlanClosedError)
  })

  it('a plan that ends later is still open', async () => {
    await expect(
      subscribe({ plan: { ...PLAN, endsAt: '2027-01-01T00:00:00.000Z' } }),
    ).resolves.toBeDefined()
  })

  it('a plan without a creation time', async () => {
    await expect(subscribe({ plan: { ...PLAN, createdAt: null } })).rejects.toThrow(
      SubscribeMissingCreatedAtError,
    )
  })

  it('an init instruction with a concrete initId, and the sentinel without one', async () => {
    await expect(
      buildSubscribeInstructions({
        plan: PLAN,
        subscriber,
        authorityInitId: INIT_ID,
        initAuthority: { tokenProgram: TOKEN_PROGRAM, userAta: USER_ATA },
        now: NOW,
      }),
    ).rejects.toThrow(SubscribeInitIdMismatchError)
    await expect(
      buildSubscribeInstructions({
        plan: PLAN,
        subscriber,
        authorityInitId: 'same-transaction',
        now: NOW,
      }),
    ).rejects.toThrow(SubscribeInitIdMismatchError)
  })
})

describe('findAssociatedTokenAccount', () => {
  it('derives the same account the SDK derives for the authority', async () => {
    const revoke = await getRevokeSubscriptionAuthorityOverlayInstructionAsync({
      tokenMint: MINT,
      user: subscriber,
      tokenProgram: TOKEN_PROGRAM,
    } as Parameters<typeof getRevokeSubscriptionAuthorityOverlayInstructionAsync>[0])
    const ours = await findAssociatedTokenAccount({
      owner: SUBSCRIBER,
      mint: MINT,
      tokenProgram: TOKEN_PROGRAM,
    })
    expect(revoke.accounts?.map((account) => account.address)).toContain(ours)
  })
})

describe('readSubscriptionAuthority', () => {
  const encodeAuthority = (initId: bigint, owner: Address = PROGRAM_ADDRESS) => ({
    owner,
    data: [
      getBase64Decoder().decode(
        getSubscriptionAuthorityEncoder().encode({
          discriminator: AccountDiscriminator.SubscriptionAuthority,
          user: SUBSCRIBER,
          tokenMint: MINT,
          payer: SUBSCRIBER,
          bump: 255,
          initId,
        }),
      ),
      'base64',
    ] as const,
  })

  const rpcWith = (account: ReturnType<typeof encodeAuthority> | null): PlanReaderRpc => ({
    getAccountInfo: () => ({ send: async () => ({ value: account }) }),
  })

  it('no account — no authority yet, and the address it will get', async () => {
    const { address } = await findSubscriptionAuthority({ user: SUBSCRIBER, tokenMint: MINT })
    expect(
      await readSubscriptionAuthority(rpcWith(null), { user: SUBSCRIBER, tokenMint: MINT }),
    ).toEqual({ address, initId: null })
  })

  it('reads initId back as it was stored', async () => {
    const state = await readSubscriptionAuthority(rpcWith(encodeAuthority(INIT_ID)), {
      user: SUBSCRIBER,
      tokenMint: MINT,
    })
    expect(state.initId).toBe(INIT_ID)
  })

  it('refuses an account owned by another program', async () => {
    await expect(
      readSubscriptionAuthority(rpcWith(encodeAuthority(INIT_ID, TOKEN_PROGRAM)), {
        user: SUBSCRIBER,
        tokenMint: MINT,
      }),
    ).rejects.toThrow(NotAnAuthorityError)
  })
})

describe('readSubscriberState', () => {
  it('reads the mint program, no authority yet, and a free subscription address', async () => {
    const subscription = await findSubscription({ planPda: PLAN.pda, subscriber: SUBSCRIBER })
    const authority = await findSubscriptionAuthority({ user: SUBSCRIBER, tokenMint: MINT })
    const rpc: PlanReaderRpc = {
      getAccountInfo: (address) => ({
        send: async () => ({
          value: address === MINT ? { owner: TOKEN_PROGRAM, data: ['', 'base64'] as const } : null,
        }),
      }),
    }
    const tokenAccount = await findAssociatedTokenAccount({
      owner: SUBSCRIBER,
      mint: MINT,
      tokenProgram: TOKEN_PROGRAM,
    })
    expect(
      await readSubscriberState(rpc, { subscriber: SUBSCRIBER, planPda: PLAN.pda, mint: MINT }),
    ).toEqual({
      address: SUBSCRIBER,
      authority: authority.address,
      authorityInitId: null,
      tokenProgram: TOKEN_PROGRAM,
      tokenAccount,
      tokenAccountExists: false,
      subscription: subscription.address,
      subscribed: false,
    })
  })

  it('an account at the subscription address means already subscribed', async () => {
    const subscription = await findSubscription({ planPda: PLAN.pda, subscriber: SUBSCRIBER })
    const rpc: PlanReaderRpc = {
      getAccountInfo: (address) => ({
        send: async () => ({
          value:
            address === MINT || address === subscription.address
              ? { owner: TOKEN_PROGRAM, data: ['', 'base64'] as const }
              : null,
        }),
      }),
    }
    const state = await readSubscriberState(rpc, {
      subscriber: SUBSCRIBER,
      planPda: PLAN.pda,
      mint: MINT,
    })
    expect(state.subscribed).toBe(true)
  })

  it('a missing mint is named, not read as "no token program"', async () => {
    const rpc: PlanReaderRpc = {
      getAccountInfo: () => ({ send: async () => ({ value: null }) }),
    }
    await expect(
      readSubscriberState(rpc, { subscriber: SUBSCRIBER, planPda: PLAN.pda, mint: MINT }),
    ).rejects.toThrow(MintNotFoundError)
  })
})
