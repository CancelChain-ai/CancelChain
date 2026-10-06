import {
  buildGrantInstruction,
  buildInitAuthorityInstruction,
  buildSubscribeInstructions,
  readAllowances,
  readPlan,
  toAddress,
} from '@cancelchain/chain'
import {
  createMerchantSim,
  createPlan,
  loadMerchantSigner,
  type MerchantSim,
  resolveTokenProgram,
} from '@cancelchain/merchant-sim'
import type { Address, Instruction, KeyPairSigner } from '@solana/kit'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token'
import {
  authorityInitId,
  fundOwner,
  log,
  merchantSignIn,
  namePlan,
  sendAndConfirm,
  sleep,
} from './chain.js'
import {
  capAmount,
  countKinds,
  type KindCounts,
  missing,
  planAmount,
  planName,
  recurringPeriod,
  TARGET,
  TARGET_TOTAL,
} from './composition.js'
import type { PerfConfig } from './config.js'

/**
 * Brings the measured wallet to exactly `TARGET` — 100 permissions — and waits
 * until the deployed API lists all of them (`T047`).
 *
 * Idempotent: it counts what the chain holds and grants only what is missing, so
 * it is also the top-up after `SC-009`, which revokes some of them.
 *
 * Roles stay apart: `merchant-sim` is the merchant — it funds the owner, creates
 * the plans and names them; the owner's key signs only what an owner signs, the
 * grants and subscriptions. Every permission is in devnet USDC, the settlement
 * asset, so each card counts towards the header total like a real one would.
 *
 * Transactions go one at a time, each waiting for its confirmation: a burst would
 * hit the node's send limit, and the indexer under test would see it as a burst.
 */

/** Rent for ~100 accounts plus fees, with room for a top-up after revocations. */
const OWNER_MIN_LAMPORTS = 400_000_000n
const OWNER_TOP_UP_LAMPORTS = 700_000_000n

/** A year: no permission may expire in the middle of a measurement. */
const EXPIRES_IN_MS = 365 * 24 * 60 * 60 * 1000

/** Between sends — under the keyed node's send limit with margin. */
const PACE_MS = 500

/** How long the API may take to list the last grant before the seed calls it a failure. */
const INDEX_TIMEOUT_MS = 5 * 60_000

type Context = {
  config: PerfConfig
  merchant: MerchantSim
  owner: KeyPairSigner
  mint: Address
  tokenProgram: Address
  ownerAta: Address
  /** `null` until the first grant creates the authority in its own transaction. */
  initId: bigint | null
  nonce: bigint
}

/** Grants carry the authority's creation the first time, and its `initId` after. */
async function withAuthority(
  context: Context,
  build: (initId: bigint | 'same-transaction') => Promise<Instruction[]>,
): Promise<Instruction[]> {
  if (context.initId !== null) return build(context.initId)
  const init = await buildInitAuthorityInstruction({
    owner: context.owner,
    tokenMint: context.mint,
    tokenProgram: context.tokenProgram,
    userAta: context.ownerAta,
  })
  return [init, ...(await build('same-transaction'))]
}

async function afterSend(context: Context): Promise<void> {
  if (context.initId === null) {
    context.initId = await authorityInitId(
      context.merchant.chain.rpc,
      context.owner.address,
      context.mint,
    )
  }
  await sleep(PACE_MS)
}

async function grantDelegation(
  context: Context,
  kind: 'recurring' | 'fixed',
  index: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + EXPIRES_IN_MS).toISOString()
  const delegatee = context.merchant.address
  const nonce = context.nonce
  context.nonce += 1n
  const instructions = await withAuthority(context, async (initId) => [
    await buildGrantInstruction({
      authorityInitId: initId,
      bounds:
        kind === 'recurring'
          ? {
              kind,
              capAmount: capAmount(index),
              delegatee,
              expiresAt,
              periodSeconds: recurringPeriod(index),
              startsAt: null,
            }
          : { kind, capAmount: capAmount(index), delegatee, expiresAt },
      delegator: context.owner,
      nonce,
      tokenMint: context.mint,
    }),
  ])
  const landed = await sendAndConfirm(
    context.merchant.chain.rpc,
    context.owner,
    instructions,
    `${kind} #${index}`,
  )
  log(`${kind.padEnd(12)} #${index} ${landed.signature}`)
  await afterSend(context)
}

async function grantSubscription(context: Context, index: number, token: string): Promise<void> {
  const { rpc } = context.merchant.chain
  const verdict = await createPlan(rpc, {
    merchant: context.merchant.signer,
    terms: {
      amount: planAmount(index),
      destinations: [context.merchant.address],
      endsAt: null,
      metadataUri: '',
      periodHours: 720,
      planId: BigInt(Date.now()) * 1_000n + BigInt(index),
      pullers: [context.merchant.address],
    },
    tokenMint: context.mint,
    tokenProgram: context.tokenProgram,
  })
  if (verdict.outcome !== 'created') {
    throw new Error(`plan #${index} was not created: ${JSON.stringify(verdict, bigintJson)}`)
  }
  await namePlan(context.config.apiUrl, token, verdict.pda, planName(index))
  const plan = await readPlan(rpc, verdict.pda)
  // The subscribe builder bundles the authority's creation itself.
  const instructions = await buildSubscribeInstructions(
    context.initId === null
      ? {
          authorityInitId: 'same-transaction',
          initAuthority: { tokenProgram: context.tokenProgram, userAta: context.ownerAta },
          plan,
          subscriber: context.owner,
        }
      : { authorityInitId: context.initId, plan, subscriber: context.owner },
  )
  const landed = await sendAndConfirm(rpc, context.owner, instructions, `subscription #${index}`)
  log(`subscription #${index} ${planName(index)} ${landed.signature}`)
  await afterSend(context)
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

async function chainCounts(context: Context): Promise<KindCounts> {
  const read = await readAllowances(context.merchant.chain, { owner: context.owner.address })
  if (read.unreadable.length > 0) {
    throw new Error(
      `${read.unreadable.length} of the owner's accounts are unreadable; the count would be wrong`,
    )
  }
  return countKinds(read.allowances.map((allowance) => allowance.kind))
}

/** Waits until the deployed API lists exactly the target — the indexer has caught up. */
async function waitListed(config: PerfConfig, owner: Address): Promise<number> {
  const started = Date.now()
  let count = -1
  while (Date.now() - started < INDEX_TIMEOUT_MS) {
    const response = await fetch(`${config.apiUrl}/v1/allowances?owner=${owner}`)
    if (response.ok) {
      const body = (await response.json()) as { items: unknown[] }
      count = body.items.length
      if (count === TARGET_TOTAL) return Date.now() - started
    }
    await sleep(5_000)
  }
  throw new Error(`the API lists ${count} permissions, not ${TARGET_TOTAL}, after the timeout`)
}

export async function seed(config: PerfConfig): Promise<void> {
  const merchant = await createMerchantSim(config.merchant)
  const owner = await loadMerchantSigner(config.ownerKeypairPath)
  const mint = toAddress(config.merchant.chain.usdcMint)
  const { rpc } = merchant.chain
  const tokenProgram = await resolveTokenProgram(rpc, mint)
  const [ownerAta] = await findAssociatedTokenPda({ mint, owner: owner.address, tokenProgram })

  log(`merchant ${merchant.address}  owner ${owner.address}  mint ${mint}`)
  const balance = await fundOwner(
    merchant,
    owner.address,
    OWNER_MIN_LAMPORTS,
    OWNER_TOP_UP_LAMPORTS,
  )
  log(`owner balance ${(Number(balance) / 1e9).toFixed(3)} SOL`)

  // The authority is created over the owner's token account, so the account
  // comes first. Idempotent; no USDC is needed to grant.
  await sendAndConfirm(
    rpc,
    owner,
    [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        mint,
        owner: owner.address,
        payer: owner,
      }),
    ],
    'owner token account',
  )

  const context: Context = {
    config,
    initId: await authorityInitId(rpc, owner.address, mint),
    merchant,
    mint,
    nonce: BigInt(Date.now()) * 1_000n,
    owner,
    ownerAta,
    tokenProgram,
  }

  const current = await chainCounts(context)
  const need = missing(current)
  log(
    `on chain: ${JSON.stringify(current)}; target ${JSON.stringify(TARGET)}; granting ${JSON.stringify(need)}`,
  )

  if (need.subscription > 0) {
    const { token } = await merchantSignIn(config.apiUrl, config.authDomain, merchant.signer)
    for (let i = 0; i < need.subscription; i += 1) {
      await grantSubscription(context, current.subscription + i, token)
    }
  }
  for (let i = 0; i < need.recurring; i += 1) {
    await grantDelegation(context, 'recurring', current.recurring + i)
  }
  for (let i = 0; i < need.fixed; i += 1) {
    await grantDelegation(context, 'fixed', current.fixed + i)
  }

  const after = await chainCounts(context)
  log(`on chain now: ${JSON.stringify(after)}`)
  const waited = await waitListed(config, owner.address)
  log(`the API lists all ${TARGET_TOTAL} (${Math.round(waited / 1000)} s after the last grant)`)
}
