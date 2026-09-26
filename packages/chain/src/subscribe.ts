import type { Address, Commitment, Instruction, TransactionSigner } from '@solana/kit'
import { getAddressEncoder, getBase64Encoder, getProgramDerivedAddress } from '@solana/kit'
import {
  AccountDiscriminator,
  getSubscribeOverlayInstructionAsync,
  getSubscriptionAuthorityDecoder,
  identifySubscriptionsInstruction,
  parseSubscribeInstruction,
  SubscriptionsInstruction,
  UNKNOWN_INIT_ID,
} from '@solana/subscriptions'
import { PROGRAM_ADDRESS, toAddress } from './client.js'
import { periodSecondsFromChainHours, timestampFromChain } from './decode.js'
import {
  type AuthorityInitId,
  buildInitAuthorityInstruction,
  type InitAuthorityInput,
  timestampToChain,
} from './grant.js'
import { findPlan, findSubscription, findSubscriptionAuthority } from './pda.js'
import type { PlanReaderRpc, PlanSnapshot } from './plan.js'

/**
 * Subscribing to a merchant's plan — `FR-008`, `T036`.
 *
 * Unlike a standalone grant (`grant.ts`), the subscriber does not choose the
 * bounds here: the plan does. What the subscriber signs is a **snapshot** of the
 * plan's terms — mint, amount per period, period in hours, and the plan's
 * creation time — carried inside the instruction as `expected*` fields. The
 * program compares them with the live plan and refuses the subscription with
 * `PlanTermsMismatch` if anything differs. That is what makes "the bounds shown
 * before signing are the bounds in the transaction" checkable: the screen reads
 * them back out of the instruction (`readSubscribeBounds`), not out of the plan
 * it was built from.
 *
 * `expectedCreatedAt` is the plan's identity, not a formality. A plan can be
 * deleted and re-created under the same address (same owner, same `planId`)
 * with different terms; the creation time is the only thing that tells the two
 * apart.
 *
 * Two things the subscriber sees on the screen are **not** in the instruction,
 * and the screen has to say so: who may pull (`pullers`) and when the plan ends
 * (`endTs`). Both can be changed by the merchant after the subscription exists
 * (`updatePlan`). Where the money may go (`destinations`) cannot be changed.
 */

/** The plan's terms as the instruction carries them. Amounts stay `bigint`. */
export type SubscribeTerms = {
  mint: Address
  amount: bigint
  periodHours: bigint
  /** Chain seconds. Never zero: a plan without a creation time is refused before building. */
  createdAt: bigint
}

export type SubscribePlan = Pick<
  PlanSnapshot,
  'pda' | 'owner' | 'planId' | 'mint' | 'amount' | 'periodHours' | 'createdAt' | 'status' | 'endsAt'
>

export type SubscribeInput = {
  plan: SubscribePlan
  subscriber: TransactionSigner
  authorityInitId: AuthorityInitId
  /** Who pays rent for the new accounts. Not set — the subscriber. */
  payer?: TransactionSigner
  /** The moment the plan's end date is checked against. Defaults to now. */
  now?: Date
  programAddress?: Address
}

export class SubscribePlanAddressError extends Error {
  constructor(
    readonly planPda: Address,
    readonly derived: Address,
  ) {
    super(
      `the plan snapshot says ${planPda}, but its owner and planId derive ${derived}; ` +
        'the instruction would point at a different plan than the one on the screen',
    )
    this.name = 'SubscribePlanAddressError'
  }
}

export class SubscribePlanClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubscribePlanClosedError'
  }
}

export class SubscribeMissingCreatedAtError extends Error {
  constructor(readonly planPda: Address) {
    super(
      `the plan ${planPda} carries no creation time; without it the subscription cannot pin ` +
        'which plan it agrees to, and the program would refuse it anyway',
    )
    this.name = 'SubscribeMissingCreatedAtError'
  }
}

/** The plan snapshot → the terms the instruction will carry. */
export function subscribeTermsFrom(plan: SubscribePlan): SubscribeTerms {
  if (plan.createdAt === null) throw new SubscribeMissingCreatedAtError(plan.pda)
  return {
    mint: plan.mint,
    amount: plan.amount,
    periodHours: BigInt(plan.periodHours),
    createdAt: timestampToChain(plan.createdAt),
  }
}

async function assertSubscribable(plan: SubscribePlan, now: Date): Promise<void> {
  const derived = await findPlan({ owner: plan.owner, planId: plan.planId })
  if (derived.address !== plan.pda) throw new SubscribePlanAddressError(plan.pda, derived.address)
  if (plan.status === 'sunset') {
    throw new SubscribePlanClosedError(
      `the plan ${plan.pda} is being wound down by its merchant and takes no new subscribers ` +
        '(the program answers PlanSunset)',
    )
  }
  if (plan.endsAt !== null && Date.parse(plan.endsAt) <= now.getTime()) {
    throw new SubscribePlanClosedError(
      `the plan ${plan.pda} ended on ${plan.endsAt} (the program answers PlanExpired)`,
    )
  }
}

/**
 * The subscribe instruction.
 *
 * Built through the SDK overlay, which derives the plan bump, the subscriber's
 * authority and the event accounts itself — the same derivations the program
 * checks. The `expected*` fields come from `subscribeTermsFrom` and nowhere
 * else, so there is exactly one path from a plan snapshot to the signed terms.
 */
export async function buildSubscribeInstruction(input: SubscribeInput): Promise<Instruction> {
  const { plan } = input
  await assertSubscribable(plan, input.now ?? new Date())
  const terms = subscribeTermsFrom(plan)
  return getSubscribeOverlayInstructionAsync({
    merchant: plan.owner,
    planId: plan.planId,
    subscriber: input.subscriber,
    tokenMint: terms.mint,
    expectedAmount: terms.amount,
    expectedPeriodHours: terms.periodHours,
    expectedCreatedAt: terms.createdAt,
    expectedSubscriptionAuthorityInitId:
      input.authorityInitId === 'same-transaction' ? UNKNOWN_INIT_ID : input.authorityInitId,
    programAddress: input.programAddress ?? PROGRAM_ADDRESS,
    ...(input.payer === undefined ? {} : { payer: input.payer }),
  })
}

export class SubscribeInitIdMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubscribeInitIdMismatchError'
  }
}

export type SubscribeInstructionsInput = SubscribeInput & {
  /**
   * Create the subscriber's authority for the plan's mint in the same
   * transaction. Needed exactly once per wallet and mint. The mint is not passed
   * here: it is the plan's, and a second place for it would allow an authority
   * in one mint and a subscription in another.
   */
  initAuthority?: Omit<InitAuthorityInput, 'owner' | 'payer' | 'programAddress' | 'tokenMint'>
}

/**
 * Every instruction the subscription transaction carries, in order.
 *
 * The same coupling rule as `buildGrantTransaction`: `'same-transaction'` without
 * an authority instruction would switch off the staleness guard for nothing, and
 * an authority instruction with a concrete `initId` expects an id that does not
 * exist yet.
 */
export async function buildSubscribeInstructions(
  input: SubscribeInstructionsInput,
): Promise<Instruction[]> {
  const bundlesInit = input.initAuthority !== undefined
  const sameTransaction = input.authorityInitId === 'same-transaction'
  if (bundlesInit && !sameTransaction) {
    throw new SubscribeInitIdMismatchError(
      'the authority is being initialised in this very transaction, so its initId does not exist ' +
        "yet; pass authorityInitId: 'same-transaction'",
    )
  }
  if (!bundlesInit && sameTransaction) {
    throw new SubscribeInitIdMismatchError(
      "authorityInitId is 'same-transaction', but no initSubscriptionAuthority instruction is " +
        'bundled; that would switch off the staleness guard for nothing',
    )
  }

  const instructions: Instruction[] = []
  if (input.initAuthority !== undefined) {
    instructions.push(
      await buildInitAuthorityInstruction({
        ...input.initAuthority,
        owner: input.subscriber,
        tokenMint: input.plan.mint,
        ...(input.payer === undefined ? {} : { payer: input.payer }),
        ...(input.programAddress === undefined ? {} : { programAddress: input.programAddress }),
      }),
    )
  }
  instructions.push(await buildSubscribeInstruction(input))
  return instructions
}

/**
 * What the transaction actually commits the subscriber to, read back **out of
 * the instructions**. This, and not the plan the instructions were built from,
 * is what the screen shows before the signature.
 */
export type SubscribeBounds = SubscribeTerms & {
  plan: Address
  merchant: Address
  subscriber: Address
  /** The subscription account the transaction creates — known before signing. */
  subscription: Address
  planId: bigint
  /** `'same-transaction'` — the authority is created by this transaction. */
  authorityInitId: AuthorityInitId
  initsAuthority: boolean
}

export class SubscribeBoundsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubscribeBoundsError'
  }
}

type Parsable = Parameters<typeof parseSubscribeInstruction>[0]

function parsable(instruction: Instruction): Parsable {
  if (instruction.accounts === undefined || instruction.data === undefined) {
    throw new SubscribeBoundsError('an instruction carries no accounts or no data')
  }
  return instruction as Parsable
}

/**
 * Decodes the terms out of the instructions.
 *
 * Refuses anything that is not exactly "optional authority init, then one
 * subscribe" for our program: a screen that summarised the first subscribe of
 * two, or an instruction of another program, would show bounds that are not
 * the whole of what gets signed.
 */
export function readSubscribeBounds(
  instructions: readonly Instruction[],
  programAddress: Address = PROGRAM_ADDRESS,
): SubscribeBounds {
  let initsAuthority = false
  let subscribe: ReturnType<typeof parseSubscribeInstruction> | null = null

  for (const instruction of instructions) {
    if (instruction.programAddress !== programAddress) {
      throw new SubscribeBoundsError(
        `an instruction targets ${instruction.programAddress}, not the subscriptions program`,
      )
    }
    const kind = identifySubscriptionsInstruction(parsable(instruction))
    if (kind === SubscriptionsInstruction.InitSubscriptionAuthority && subscribe === null) {
      if (initsAuthority) throw new SubscribeBoundsError('the authority is initialised twice')
      initsAuthority = true
      continue
    }
    if (kind === SubscriptionsInstruction.Subscribe && subscribe === null) {
      subscribe = parseSubscribeInstruction(parsable(instruction))
      continue
    }
    throw new SubscribeBoundsError(
      `unexpected instruction ${SubscriptionsInstruction[kind]} in a subscription transaction`,
    )
  }
  if (subscribe === null) throw new SubscribeBoundsError('there is no subscribe instruction')

  const data = subscribe.data.subscribeData
  const initId = data.expectedSubscriptionAuthorityInitId
  if (initsAuthority !== (initId === UNKNOWN_INIT_ID)) {
    throw new SubscribeBoundsError(
      'the authority init instruction and the expected initId disagree about whether the ' +
        'authority already exists',
    )
  }
  return {
    plan: subscribe.accounts.planPda.address,
    merchant: subscribe.accounts.merchant.address,
    subscriber: subscribe.accounts.subscriber.address,
    subscription: subscribe.accounts.subscriptionPda.address,
    planId: data.planId,
    mint: data.expectedMint,
    amount: data.expectedAmount,
    periodHours: data.expectedPeriodHours,
    createdAt: data.expectedCreatedAt,
    authorityInitId: initsAuthority ? 'same-transaction' : initId,
    initsAuthority,
  }
}

/**
 * The signed terms in the shape the catalog stores them (`Plan` in `shared`):
 * seconds instead of hours, ISO instead of chain seconds, amount as a decimal
 * string. The comparison with the merchant's catalog row happens in that shape.
 */
export function subscribeBoundsAsPlanTerms(bounds: SubscribeTerms): {
  mint: string
  amount: string
  periodSeconds: number
  createdAt: string
} {
  const createdAt = timestampFromChain(bounds.createdAt)
  if (createdAt === null) {
    throw new SubscribeBoundsError('the instruction pins no plan creation time')
  }
  return {
    mint: bounds.mint,
    amount: bounds.amount.toString(10),
    periodSeconds: periodSecondsFromChainHours(bounds.periodHours),
    createdAt,
  }
}

/** Where the subscription for a wallet and a plan lives. */
export async function findSubscriptionFor(seeds: {
  planPda: string
  subscriber: string
}): Promise<Address> {
  const { address } = await findSubscription({
    planPda: toAddress(seeds.planPda),
    subscriber: toAddress(seeds.subscriber),
  })
  return address
}

export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address

/**
 * The wallet's token account for a mint. Needed only when the authority is
 * created in the subscription transaction: the program approves the authority
 * as a delegate on this account.
 */
export async function findAssociatedTokenAccount(seeds: {
  owner: string
  mint: string
  tokenProgram: string
}): Promise<Address> {
  const encoder = getAddressEncoder()
  const [address] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [
      encoder.encode(toAddress(seeds.owner)),
      encoder.encode(toAddress(seeds.tokenProgram)),
      encoder.encode(toAddress(seeds.mint)),
    ],
  })
  return address
}

export class NotAnAuthorityError extends Error {
  constructor(
    readonly address: Address,
    detail: string,
  ) {
    super(`the account at ${address} is not a subscription authority: ${detail}`)
    this.name = 'NotAnAuthorityError'
  }
}

export type SubscriptionAuthorityState = {
  address: Address
  /** `null` — there is no authority yet, and the subscription has to create one. */
  initId: bigint | null
}

const AUTHORITY_SIZE = getSubscriptionAuthorityDecoder().fixedSize

/**
 * The wallet's authority for a mint, if it exists. Its `initId` goes into the
 * subscribe instruction as the staleness guard (`AuthorityInitId` in `grant.ts`).
 *
 * The same three checks as `readPlan` — owner, discriminator, size — for the
 * same reason: a decoder fed foreign bytes of the right length answers with
 * plausible numbers, not with an error.
 */
export async function readSubscriptionAuthority(
  rpc: PlanReaderRpc,
  seeds: { user: string; tokenMint: string },
  options: { commitment?: Commitment; programAddress?: Address } = {},
): Promise<SubscriptionAuthorityState> {
  const programAddress = options.programAddress ?? PROGRAM_ADDRESS
  const { address } = await findSubscriptionAuthority({
    user: toAddress(seeds.user),
    tokenMint: toAddress(seeds.tokenMint),
  })
  const { value } = await rpc
    .getAccountInfo(address, {
      encoding: 'base64',
      ...(options.commitment === undefined ? {} : { commitment: options.commitment }),
    })
    .send()
  if (value === null) return { address, initId: null }
  if (value.owner !== programAddress) {
    throw new NotAnAuthorityError(address, `it belongs to ${value.owner}, not to the program`)
  }
  const bytes = getBase64Encoder().encode(value.data[0])
  if (bytes.length !== AUTHORITY_SIZE) {
    throw new NotAnAuthorityError(
      address,
      `it holds ${bytes.length} bytes, an authority holds ${AUTHORITY_SIZE}`,
    )
  }
  if (bytes[0] !== AccountDiscriminator.SubscriptionAuthority) {
    throw new NotAnAuthorityError(
      address,
      `its discriminator is ${bytes[0]}, an authority's is ${AccountDiscriminator.SubscriptionAuthority}`,
    )
  }
  return { address, initId: getSubscriptionAuthorityDecoder().decode(bytes).initId }
}

export class MintNotFoundError extends Error {
  constructor(readonly mint: Address) {
    super(`there is no account at the plan's mint ${mint}`)
    this.name = 'MintNotFoundError'
  }
}

export type SubscriberState = {
  address: Address
  authority: Address
  authorityInitId: bigint | null
  tokenProgram: Address
  /** The wallet's token account for the plan's mint. */
  tokenAccount: Address
  /**
   * Creating the authority needs this account to exist; without it the program
   * answers `InvalidTokenSplTokenAccountData` (110), which says nothing to a person.
   */
  tokenAccountExists: boolean
  subscription: Address
  subscribed: boolean
}

/**
 * The subscriber's side of a subscription, read from the chain: the authority
 * and its `initId`, the mint's token program and the wallet's token account
 * (both needed to create the authority), and whether a subscription account
 * already sits at the address this one would take. Each of them goes into — or
 * stops — the transaction the screen builds.
 */
export async function readSubscriberState(
  rpc: PlanReaderRpc,
  seeds: { subscriber: string; planPda: string; mint: string },
  options: { commitment?: Commitment; programAddress?: Address } = {},
): Promise<SubscriberState> {
  const programAddress = options.programAddress ?? PROGRAM_ADDRESS
  const config = {
    encoding: 'base64' as const,
    ...(options.commitment === undefined ? {} : { commitment: options.commitment }),
  }
  const subscription = await findSubscriptionFor({
    planPda: seeds.planPda,
    subscriber: seeds.subscriber,
  })
  const mint = toAddress(seeds.mint)
  const [authority, mintAccount, subscriptionAccount] = await Promise.all([
    readSubscriptionAuthority(
      rpc,
      { user: seeds.subscriber, tokenMint: seeds.mint },
      { ...options, programAddress },
    ),
    rpc.getAccountInfo(mint, config).send(),
    rpc.getAccountInfo(subscription, config).send(),
  ])
  if (mintAccount.value === null) throw new MintNotFoundError(mint)
  const tokenProgram = mintAccount.value.owner
  const tokenAccount = await findAssociatedTokenAccount({
    owner: seeds.subscriber,
    mint,
    tokenProgram,
  })
  const tokenAccountInfo = await rpc.getAccountInfo(tokenAccount, config).send()
  return {
    address: toAddress(seeds.subscriber),
    authority: authority.address,
    authorityInitId: authority.initId,
    tokenProgram,
    tokenAccount,
    tokenAccountExists: tokenAccountInfo.value !== null,
    subscription,
    // Any account there blocks the subscription, whoever owns it: the program
    // cannot create an account at an address that is already taken.
    subscribed: subscriptionAccount.value !== null,
  }
}
