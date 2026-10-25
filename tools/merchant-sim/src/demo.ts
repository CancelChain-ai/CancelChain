import { generateKeyPairSync } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  buildGrantInstruction,
  buildInitAuthorityInstruction,
  findGrantedAllowance,
  type ReadAllowance,
  readAllowance,
  readAllowances,
  toAddress,
} from '@cancelchain/chain'
import { addressSchema } from '@cancelchain/shared'
import {
  type Address,
  generateKeyPairSigner,
  getBase58Decoder,
  type KeyPairSigner,
} from '@solana/kit'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token'
import { z } from 'zod'
import { merchantSignIn, namePlan } from './catalog.js'
import {
  attemptCharge,
  type ChargeVerdict,
  chargeTargetFromFields,
  describeVerdict,
  resolveTokenProgram,
} from './charge.js'
import {
  KEYPAIR_FILE_SUFFIX,
  KeypairPathError,
  type MerchantSimConfig,
  merchantSimConfigFromEnv,
} from './config.js'
import { KeypairFileError, loadMerchantSigner, parseKeypairBytes } from './keypair.js'
import { createMerchantSim, type MerchantSim } from './merchant.js'
import { createPlan } from './plan.js'
import { authorityInitId, fundOwner, sendAndConfirm, sleep } from './send.js'

/**
 * The demo, reproducible with one command (`T056`, `FR-023`).
 *
 * `prepare` builds, off camera, the world the show needs and can be run again
 * at any time: what is already there is kept, only what is missing is made.
 *
 *   A  a recurring permission to merchant-sim — the one the owner cancels in the
 *      browser, with the owner's own signature, and `charge` tries afterwards;
 *   B  a recurring permission to a second recipient — so the list holds more
 *      than one; nobody touches it;
 *   P  a fresh plan by merchant-sim, named in the catalog — the subscribe link.
 *
 * The owner is a second devnet key in a file (decision 2026-10-25): the
 * permissions are granted before the show, so something has to sign them, and
 * the wallet in the browser has to be that same owner. It takes the merchant
 * key's locks: a `*.keypair.json` name, and no mainnet by name or by genesis.
 *
 * There is no successful charge: devnet USDC is not obtainable (Circle's faucet
 * answers 403 "Lockout"), so every card reads 0 used. The show's claim — a
 * cancelled permission cannot be charged — does not rest on one.
 */

export const DEFAULT_APP_URL = 'https://cancelchain-ai.github.io/CancelChain/app/'
export const DEFAULT_API_URL = 'https://cancelchain-api.onrender.com'

export const PLAN_NAME = 'Paperlight Monthly'
const USDC = 1_000_000n
export const A_CAP = 9_990_000n
export const B_CAP = 4_500_000n
export const PLAN_AMOUNT = 7_990_000n
const DAY_SECONDS = 86_400
/** A year: nothing prepared expires before it is shown. */
const EXPIRES_IN_MS = 365 * DAY_SECONDS * 1000
const OWNER_AT_LEAST = 100_000_000n // 0.1 SOL
const OWNER_TOP_UP_TO = 150_000_000n

export type DemoConfig = {
  merchant: MerchantSimConfig
  ownerKeypairPath: string
  /** What `prepare` made, so the next run keeps it. No key in it. */
  statePath: string
  appUrl: string
  apiUrl: string
  /** The API's `AUTH_DOMAIN`: the merchant signs in for it to name the plan. */
  authDomain: string
}

export class DemoConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DemoConfigError'
  }
}

function urlFrom(raw: string | undefined, fallback: string, name: string): string {
  const value = raw === undefined || raw === '' ? fallback : raw
  if (!URL.canParse(value)) throw new DemoConfigError(`${name} is not a URL: "${value}"`)
  return value
}

export function demoConfigFromEnv(env: Record<string, string | undefined>): DemoConfig {
  const merchant = merchantSimConfigFromEnv(env)
  const ownerKeypairPath = env.DEMO_OWNER_KEYPAIR_PATH
  if (ownerKeypairPath === undefined || ownerKeypairPath === '') {
    throw new KeypairPathError(
      'DEMO_OWNER_KEYPAIR_PATH is not set: the file of the demo owner key, outside the ' +
        'repository. `demo prepare` creates it when it does not exist yet.',
    )
  }
  if (!ownerKeypairPath.endsWith(KEYPAIR_FILE_SUFFIX)) {
    throw new KeypairPathError(
      `DEMO_OWNER_KEYPAIR_PATH must end with "${KEYPAIR_FILE_SUFFIX}" — that is the pattern .gitignore covers`,
    )
  }
  if (resolve(ownerKeypairPath) === resolve(merchant.keypairPath)) {
    throw new KeypairPathError(
      'DEMO_OWNER_KEYPAIR_PATH names the merchant key: the owner would grant permissions to itself',
    )
  }
  const appUrl = urlFrom(env.DEMO_APP_URL, DEFAULT_APP_URL, 'DEMO_APP_URL')
  const apiUrl = urlFrom(env.DEMO_API_URL, DEFAULT_API_URL, 'DEMO_API_URL').replace(/\/+$/, '')
  return {
    merchant,
    ownerKeypairPath,
    statePath:
      env.DEMO_STATE_PATH === undefined || env.DEMO_STATE_PATH === ''
        ? `${ownerKeypairPath.slice(0, -KEYPAIR_FILE_SUFFIX.length)}.demo.json`
        : env.DEMO_STATE_PATH,
    appUrl,
    apiUrl,
    authDomain:
      env.DEMO_AUTH_DOMAIN === undefined || env.DEMO_AUTH_DOMAIN === ''
        ? new URL(appUrl).host
        : env.DEMO_AUTH_DOMAIN,
  }
}

export const demoStateSchema = z.object({
  owner: addressSchema,
  /** B's recipient. Only its address matters: nobody charges B. */
  secondRecipient: addressSchema,
  a: addressSchema.nullable(),
  b: addressSchema.nullable(),
  plan: addressSchema.nullable(),
  planNamed: z.boolean(),
})

export type DemoState = z.infer<typeof demoStateSchema>

/**
 * The stored state, or `null` when there is none for this owner. A file written
 * for another owner key is not this owner's world, and a damaged one is no world:
 * both start over rather than fail, since `prepare` rebuilds whatever is missing.
 */
export function parseDemoState(contents: string | null, owner: string): DemoState | null {
  if (contents === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(contents)
  } catch {
    return null
  }
  const parsed = demoStateSchema.safeParse(raw)
  if (!parsed.success || parsed.data.owner !== owner) return null
  return parsed.data
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** A fresh ed25519 key as the 64 bytes `solana-keygen` writes: the seed, then the public key. */
export function newKeypairBytes(): Uint8Array {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  if (jwk.d === undefined || jwk.x === undefined) throw new Error('ed25519 key without d or x')
  return Uint8Array.from([...Buffer.from(jwk.d, 'base64url'), ...Buffer.from(jwk.x, 'base64url')])
}

/** Writes a new owner key unless the file exists. `wx`: an existing key is never overwritten. */
async function ensureOwnerKey(path: string): Promise<boolean> {
  try {
    await writeFile(path, JSON.stringify([...newKeypairBytes()]), { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw new KeypairFileError(`cannot write the owner key at ${path}`, { cause: error })
  }
}

/** The owner key as one base58 string — what a wallet's "Import private key" takes. */
export function ownerKeyBase58(contents: string): string {
  return getBase58Decoder().decode(parseKeypairBytes(contents))
}

export async function readOwnerKeyBase58(config: DemoConfig): Promise<string> {
  const contents = await readText(config.ownerKeypairPath)
  if (contents === null) {
    throw new KeypairFileError(`no owner key at ${config.ownerKeypairPath} — run \`demo prepare\``)
  }
  return ownerKeyBase58(contents)
}

type Held = Pick<ReadAllowance, 'pda' | 'kind' | 'delegate' | 'status' | 'planPda'>

/** The active recurring permission to `delegate`, preferring the one already on record. */
export function liveRecurring(
  held: readonly Held[],
  delegate: string,
  recorded: string | null,
): string | null {
  const live = held.filter(
    (entry) =>
      entry.kind === 'recurring' && entry.delegate === delegate && entry.status === 'active',
  )
  return (live.find((entry) => entry.pda === recorded) ?? live[0])?.pda ?? null
}

/**
 * A new plan is needed when there is none, or when the owner has subscribed to
 * it: a subscription stays on the list after it is cancelled (`T037a`), so the
 * next show would open a plan the wallet already holds.
 */
export function planIsSpent(held: readonly Held[], plan: string | null): boolean {
  return (
    plan === null || held.some((entry) => entry.kind === 'subscription' && entry.planPda === plan)
  )
}

export const usdc = (raw: bigint | string): string => {
  const amount = BigInt(raw)
  return `${amount / USDC}.${String(amount % USDC)
    .padStart(6, '0')
    .slice(0, 2)}`
}

export const subscribeLink = (appUrl: string, plan: string): string => `${appUrl}?plan=${plan}`
export const cardLink = (appUrl: string, pda: string): string => `${appUrl}?allowance=${pda}`

export function explorerUrl(cluster: MerchantSim['cluster'], signature: string): string {
  if (cluster === 'localnet') return `local validator — no public explorer (${signature})`
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`
}

type World = {
  config: DemoConfig
  merchant: MerchantSim
  owner: KeyPairSigner
  mint: Address
  tokenProgram: Address
}

async function openWorld(config: DemoConfig): Promise<World> {
  const merchant = await createMerchantSim(config.merchant)
  const owner = await loadMerchantSigner(config.ownerKeypairPath)
  const mint = toAddress(merchant.chain.usdcMint)
  const tokenProgram = await resolveTokenProgram(merchant.chain.rpc, mint)
  return { config, merchant, owner, mint, tokenProgram }
}

async function held(world: World): Promise<ReadAllowance[]> {
  return (await readAllowances(world.merchant.chain, { owner: world.owner.address })).allowances
}

async function grant(
  world: World,
  delegatee: Address,
  capAmount: bigint,
  periodDays: number,
  label: string,
  print: (line: string) => void,
): Promise<Address> {
  const { rpc } = world.merchant.chain
  const initId = await authorityInitId(rpc, world.owner.address, world.mint)
  const nonce = BigInt(Date.now()) * 1_000n
  const instruction = await buildGrantInstruction({
    authorityInitId: initId ?? 'same-transaction',
    bounds: {
      kind: 'recurring',
      capAmount,
      delegatee,
      expiresAt: new Date(Date.now() + EXPIRES_IN_MS).toISOString(),
      periodSeconds: periodDays * DAY_SECONDS,
      startsAt: null,
    },
    delegator: world.owner,
    nonce,
    tokenMint: world.mint,
  })
  const [userAta] = await findAssociatedTokenPda({
    mint: world.mint,
    owner: world.owner.address,
    tokenProgram: world.tokenProgram,
  })
  const init =
    initId === null
      ? [
          await buildInitAuthorityInstruction({
            owner: world.owner,
            tokenMint: world.mint,
            tokenProgram: world.tokenProgram,
            userAta,
          }),
        ]
      : []
  const landed = await sendAndConfirm(rpc, world.owner, [...init, instruction], label)
  const { address } = await findGrantedAllowance({
    delegator: world.owner.address,
    delegatee,
    tokenMint: world.mint,
    nonce,
  })
  print(`${label}: granted ${address}  (tx ${landed.signature})`)
  return address
}

/** Render Free sleeps: the first request after a quiet hour waits for a cold start. */
async function wakeApi(apiUrl: string, print: (line: string) => void): Promise<void> {
  const deadline = Date.now() + 180_000
  for (;;) {
    try {
      if ((await fetch(`${apiUrl}/health`)).status === 200) return
    } catch {
      // asleep or starting
    }
    if (Date.now() > deadline) throw new Error(`${apiUrl} did not wake up in 3 minutes`)
    print(`waiting for ${apiUrl} to wake up…`)
    await sleep(10_000)
  }
}

export async function prepareDemo(
  config: DemoConfig,
  print: (line: string) => void,
): Promise<void> {
  if (await ensureOwnerKey(config.ownerKeypairPath)) {
    print(`new owner key ${config.ownerKeypairPath}`)
  }
  const world = await openWorld(config)
  const { merchant, owner } = world
  const { rpc } = merchant.chain
  const state: DemoState = parseDemoState(await readText(config.statePath), owner.address) ?? {
    owner: owner.address,
    secondRecipient: (await generateKeyPairSigner()).address,
    a: null,
    b: null,
    plan: null,
    planNamed: false,
  }
  const save = () => writeFile(config.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  print(`owner ${owner.address}  merchant ${merchant.address}  (${merchant.cluster})`)

  await fundOwner(merchant, owner.address, OWNER_AT_LEAST, OWNER_TOP_UP_TO)

  // Without the owner's token account the subscribe screen refuses the plan (`T062`).
  const [ownerAta] = await findAssociatedTokenPda({
    mint: world.mint,
    owner: owner.address,
    tokenProgram: world.tokenProgram,
  })
  if ((await rpc.getAccountInfo(ownerAta, { encoding: 'base64' }).send()).value === null) {
    await sendAndConfirm(
      rpc,
      owner,
      [
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          mint: world.mint,
          owner: owner.address,
          payer: owner,
          tokenProgram: world.tokenProgram,
        }),
      ],
      'owner token account',
    )
    print(`owner token account ${ownerAta}`)
  }

  // Saved after every step: a run cut short keeps what already landed.
  let list = await held(world)
  state.a =
    liveRecurring(list, merchant.address, state.a) ??
    (await grant(world, merchant.address, A_CAP, 30, 'A', print))
  await save()
  const second = toAddress(state.secondRecipient)
  state.b =
    liveRecurring(list, second, state.b) ?? (await grant(world, second, B_CAP, 7, 'B', print))
  await save()

  list = await held(world)
  if (planIsSpent(list, state.plan)) {
    const verdict = await createPlan(rpc, {
      merchant: merchant.signer,
      terms: {
        amount: PLAN_AMOUNT,
        destinations: [merchant.address],
        endsAt: null,
        metadataUri: '',
        periodHours: 720,
        planId: BigInt(Date.now()),
        pullers: [merchant.address],
      },
      tokenMint: world.mint,
      tokenProgram: world.tokenProgram,
    })
    if (verdict.outcome !== 'created')
      throw new Error(`the plan was not created: ${verdict.outcome}`)
    state.plan = verdict.pda
    state.planNamed = false
    await save()
    print(`plan ${verdict.pda}`)
  }
  if (!state.planNamed && state.plan !== null) {
    await wakeApi(config.apiUrl, print)
    const { token } = await merchantSignIn(config.apiUrl, config.authDomain, merchant.signer)
    await namePlan(config.apiUrl, token, state.plan, PLAN_NAME)
    state.planNamed = true
    await save()
    print(`plan named "${PLAN_NAME}" in ${config.apiUrl}`)
  }
  print('')
  await printStatus(world, state, print)
}

async function printStatus(
  world: World,
  state: DemoState | null,
  print: (line: string) => void,
): Promise<void> {
  const list = await held(world)
  const label = (entry: ReadAllowance) =>
    entry.pda === state?.a
      ? 'A'
      : entry.pda === state?.b
        ? 'B'
        : entry.planPda !== null && entry.planPda === state?.plan
          ? 'P'
          : '·'
  print(`owner ${world.owner.address} — ${list.length} permission(s) on chain`)
  for (const entry of list) {
    print(
      `  ${label(entry)} ${entry.kind.padEnd(12)} ${entry.status.padEnd(9)} up to ${usdc(entry.capAmount)} USDC  ${entry.pda}`,
    )
  }
  const { value: lamports } = await world.merchant.chain.rpc.getBalance(world.owner.address).send()
  print(`owner SOL ${(Number(lamports) / 1e9).toFixed(3)}`)
  const { appUrl } = world.config
  if (state === null) {
    print('nothing prepared for this owner — run `demo prepare`')
    return
  }
  if (state.plan !== null) {
    print(
      `subscribe link: ${subscribeLink(appUrl, state.plan)}${state.planNamed ? '' : '  (not named yet)'}`,
    )
  }
  if (state.a !== null) print(`card of A:      ${cardLink(appUrl, state.a)}`)
}

export async function demoStatus(config: DemoConfig, print: (line: string) => void): Promise<void> {
  const world = await openWorld(config)
  await printStatus(
    world,
    parseDemoState(await readText(config.statePath), world.owner.address),
    print,
  )
}

/**
 * merchant-sim tries to pull A's whole ceiling — after the owner has cancelled
 * A in the browser. While A is still on chain nothing is sent: with no USDC in
 * the wallet the token program would refuse it, and that refusal proves nothing
 * about the cancellation.
 */
export async function chargeDemo(
  config: DemoConfig,
  print: (line: string) => void,
): Promise<ChargeVerdict | null> {
  const world = await openWorld(config)
  const state = parseDemoState(await readText(config.statePath), world.owner.address)
  if (state === null || state.a === null) {
    throw new Error('A is not prepared for this owner — run `demo prepare`')
  }
  const { merchant } = world
  const { allowance } = await readAllowance(merchant.chain, { pda: toAddress(state.a) })
  if (allowance !== null) {
    print(
      `A is still on chain (status ${allowance.status}) — cancel it in the browser first:\n  ${cardLink(config.appUrl, state.a)}`,
    )
    return null
  }
  const target = chargeTargetFromFields(state.a, {
    kind: 'recurring',
    owner: world.owner.address,
    mint: world.mint,
    delegate: merchant.address,
  })
  print(`A ${state.a}: no account — charging ${usdc(A_CAP)} USDC against a cancelled permission`)
  const verdict = await attemptCharge(merchant.chain.rpc, {
    allowance: target,
    amount: A_CAP,
    merchant: merchant.signer,
    tokenProgram: world.tokenProgram,
  })
  print(describeVerdict(verdict))
  if (verdict.signature !== null)
    print(`explorer:     ${explorerUrl(merchant.cluster, verdict.signature)}`)
  return verdict
}
