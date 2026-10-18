import {
  buildGrantInstruction,
  buildInitAuthorityInstruction,
  buildRevokeTransaction,
  findGrantedAllowance,
  type ReadAllowance,
  readAllowance,
  toAddress,
  toBlockhash,
} from '@cancelchain/chain'
import {
  attemptCharge,
  type ChargeVerdict,
  chargeTargetFromAllowance,
  createMerchantSim,
  type MerchantSim,
  type MerchantSimConfig,
  programErrorCodeOf,
  resolveTokenProgram,
  runtimeErrorLabelOf,
} from '@cancelchain/merchant-sim'
import {
  DEMO_SNAPSHOT_VERSION,
  type DemoSnapshot,
  type SnapshotStage,
  type SnapshotStep,
} from '@cancelchain/shared/snapshot'
import { type Address, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit'
import { SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT } from '@solana/subscriptions'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from '@solana-program/token'
import {
  authorityInitId,
  fundOwner,
  log,
  sendAndConfirm,
  signAndSendCompiled,
  sleep,
} from '../../perf/chain.js'
import {
  type GetJson,
  getJson,
  recordStage,
  type StageExpectation,
  type StagePaths,
  stagePaths,
  UnsettledAnswerError,
  unmetExpectations,
} from './record.js'

/**
 * The demo scenario, run on devnet and recorded through the deployed API (`T058`).
 *
 * Two permissions in devnet USDC from a wallet made for this run; the merchant
 * (`merchant-sim`) tries to charge one over its ceiling and is refused; the
 * owner cancels the other; the merchant tries to charge the cancelled one and is
 * refused by the protocol. The API's answers are recorded before and after the
 * cancellation, and so are the signatures of every transaction.
 *
 * The owner is new on every run, so the list holds the scenario's permissions
 * and nothing else. Its key lives in this process only: nothing it signed has to
 * be signed again, and the recording never needs it.
 *
 * There is no successful charge: no wallet of this project holds devnet USDC,
 * and the faucet is a captcha. The show's claim — a cancelled permission cannot
 * be charged — does not rest on one.
 */

export type DemoConfig = {
  merchant: MerchantSimConfig
  apiUrl: string
}

const USDC = 1_000_000n
const DAY_SECONDS = 86_400
/** A year: nothing in the recording expires before it is shown. */
const EXPIRES_IN_MS = 365 * 24 * 60 * 60 * 1000

/** Rent for the token account, the authority and two permissions, plus fees. */
const OWNER_LAMPORTS = 30_000_000n
/** What the last send of the run costs the owner. */
const FEE_LAMPORTS = 5_000n

/** How long the API may take to show a stage — the indexer and the list cache lag the chain. */
const STAGE_TIMEOUT_MS = 3 * 60_000
/** A stage is ~7 requests; at this pace the API's limit of 60 a minute is never reached. */
const STAGE_POLL_MS = 15_000
const WAKE_TIMEOUT_MS = 3 * 60_000

/** The refusal after cancelling: the account is closed, so the system program owns it (`T028`). */
const CLOSED_ACCOUNT = 'InvalidAccountOwner'

const KEPT = { label: 'Kept', cap: 25n * USDC, periodSeconds: 7 * DAY_SECONDS }
const CANCELLED = { label: 'Cancelled', cap: 15n * USDC, periodSeconds: 30 * DAY_SECONDS }

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScenarioError'
  }
}

type Run = {
  merchant: MerchantSim
  owner: KeyPairSigner
  mint: Address
  tokenProgram: Address
  ownerAta: Address
  initId: bigint | null
  nonce: bigint
  steps: SnapshotStep[]
}

/** The API sleeps on Render Free: the first request wakes it, and may take a minute. */
async function wake(apiUrl: string, get: GetJson): Promise<void> {
  const deadline = Date.now() + WAKE_TIMEOUT_MS
  for (;;) {
    try {
      if ((await get(`${apiUrl}/health`)).status === 200) return
    } catch {
      // Asleep or starting: the platform answers with an error page until it is up.
    }
    if (Date.now() > deadline) throw new ScenarioError(`${apiUrl} did not wake up in 3 minutes`)
    await sleep(5_000)
  }
}

async function grant(
  run: Run,
  bounds: { cap: bigint; periodSeconds: number },
  label: string,
): Promise<Address> {
  const nonce = run.nonce
  run.nonce += 1n
  const build = async (initId: bigint | 'same-transaction') =>
    buildGrantInstruction({
      authorityInitId: initId,
      bounds: {
        kind: 'recurring',
        capAmount: bounds.cap,
        delegatee: run.merchant.address,
        expiresAt: new Date(Date.now() + EXPIRES_IN_MS).toISOString(),
        periodSeconds: bounds.periodSeconds,
        startsAt: null,
      },
      delegator: run.owner,
      nonce,
      tokenMint: run.mint,
    })
  // The first grant creates the owner's authority in the same transaction.
  const instructions =
    run.initId === null
      ? [
          await buildInitAuthorityInstruction({
            owner: run.owner,
            tokenMint: run.mint,
            tokenProgram: run.tokenProgram,
            userAta: run.ownerAta,
          }),
          await build('same-transaction'),
        ]
      : [await build(run.initId)]
  const landed = await sendAndConfirm(run.merchant.chain.rpc, run.owner, instructions, label)
  run.steps.push({
    stage: 'before',
    label,
    signer: 'owner',
    signature: landed.signature,
    outcome: 'confirmed',
    refusal: null,
  })
  log(`${label.padEnd(40)} ${landed.signature}`)
  run.initId ??= await authorityInitId(run.merchant.chain.rpc, run.owner.address, run.mint)

  const { address } = await findGrantedAllowance({
    delegatee: run.merchant.address,
    delegator: run.owner.address,
    nonce,
    tokenMint: run.mint,
  })
  return address
}

async function read(run: Run, pda: Address): Promise<ReadAllowance | null> {
  const { allowance } = await readAllowance(run.merchant.chain, { pda })
  return allowance
}

/** A charge that has to be refused, and for the reason the show names. */
async function refusedCharge(
  run: Run,
  target: ReadAllowance,
  amount: bigint,
  stage: string,
  label: string,
  expected: { code: number } | { runtime: string },
): Promise<void> {
  const verdict: ChargeVerdict = await attemptCharge(run.merchant.chain.rpc, {
    allowance: chargeTargetFromAllowance(target),
    amount,
    merchant: run.merchant.signer,
    tokenProgram: run.tokenProgram,
  })
  if (verdict.outcome !== 'rejected') {
    throw new ScenarioError(
      `${label}: expected the network to refuse the charge, got ${verdict.outcome} ` +
        `(${verdict.signature ?? 'no signature'})`,
    )
  }
  const code = programErrorCodeOf(verdict.error)
  const runtime = runtimeErrorLabelOf(verdict.error)
  const matches = 'code' in expected ? code === expected.code : runtime === expected.runtime
  if (!matches) {
    throw new ScenarioError(
      `${label}: refused, but for another reason than the show names — ` +
        `${JSON.stringify(verdict.error, (_key, value) => (typeof value === 'bigint' ? Number(value) : value))} ` +
        `(${verdict.signature})`,
    )
  }
  const refusal =
    'code' in expected
      ? `AmountExceedsPeriodLimit (program error ${expected.code})`
      : `${expected.runtime} — the permission's account is closed`
  run.steps.push({
    stage,
    label,
    signer: 'merchant',
    signature: verdict.signature,
    outcome: 'refused',
    refusal,
  })
  log(`${label.padEnd(40)} ${verdict.signature} refused: ${refusal}`)
}

async function revoke(run: Run, target: ReadAllowance, label: string): Promise<void> {
  const { value } = await run.merchant.chain.rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send()
  const transaction = buildRevokeTransaction({
    allowance: target,
    authority: run.owner.address,
    lifetime: {
      blockhash: toBlockhash(value.blockhash),
      lastValidBlockHeight: value.lastValidBlockHeight,
    },
  })
  // The bytes a wallet would have signed in the browser (`T026`), signed by the owner's key.
  const landed = await signAndSendCompiled(
    run.merchant.chain.rpc,
    transaction.transaction,
    run.owner,
    label,
  )
  run.steps.push({
    stage: 'after',
    label,
    signer: 'owner',
    signature: landed.signature,
    outcome: 'confirmed',
    refusal: null,
  })
  log(`${label.padEnd(40)} ${landed.signature}`)
  // Confirmation is the account gone, not the signature returned (`T026`).
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await read(run, toAddress(target.pda))) === null) return
    await sleep(1_000)
  }
  throw new ScenarioError(`${label}: sent, but ${target.pda} is still on the network after 30 s`)
}

async function recordWhenReady(
  apiUrl: string,
  paths: StagePaths,
  expectation: StageExpectation,
  get: GetJson,
): Promise<{ responses: SnapshotStage['responses']; recordedAt: string }> {
  const deadline = Date.now() + STAGE_TIMEOUT_MS
  for (;;) {
    const recordedAt = new Date().toISOString()
    let unmet: string[]
    try {
      const responses = await recordStage(apiUrl, paths, get)
      unmet = unmetExpectations(responses, paths, expectation)
      if (unmet.length === 0) return { responses, recordedAt }
    } catch (error) {
      if (!(error instanceof UnsettledAnswerError)) throw error
      unmet = [error.message]
    }
    if (Date.now() > deadline) {
      throw new ScenarioError(`the API did not catch up in 3 minutes: ${unmet.join('; ')}`)
    }
    log(`waiting for the API: ${unmet.join('; ')}`)
    await sleep(STAGE_POLL_MS)
  }
}

/** What is left of the owner's SOL goes back to the merchant; the rent stays in the accounts. */
async function returnLeftover(run: Run): Promise<void> {
  const { rpc } = run.merchant.chain
  const { value: balance } = await rpc.getBalance(run.owner.address).send()
  if (balance <= FEE_LAMPORTS) return
  try {
    await sendAndConfirm(
      rpc,
      run.owner,
      [
        getTransferSolInstruction({
          amount: balance - FEE_LAMPORTS,
          destination: run.merchant.address,
          source: run.owner,
        }),
      ],
      'leftover returned',
    )
  } catch (error) {
    // Not part of the recording: a lost refund costs devnet SOL, not the show.
    log(`leftover not returned: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function captureDemo(
  config: DemoConfig,
  get: GetJson = getJson,
): Promise<DemoSnapshot> {
  const merchant = await createMerchantSim(config.merchant)
  if (merchant.cluster !== 'devnet') {
    throw new ScenarioError(`the demo is recorded on devnet, not on ${merchant.cluster}`)
  }
  const { rpc } = merchant.chain
  const mint = toAddress(config.merchant.chain.usdcMint)
  const tokenProgram = await resolveTokenProgram(rpc, mint)
  const owner = await generateKeyPairSigner()
  const [ownerAta] = await findAssociatedTokenPda({ mint, owner: owner.address, tokenProgram })
  log(`merchant ${merchant.address}  owner ${owner.address} (new)  mint ${mint}`)
  log(`api ${config.apiUrl}`)

  await wake(config.apiUrl, get)
  await fundOwner(merchant, owner.address, OWNER_LAMPORTS, OWNER_LAMPORTS)
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

  const run: Run = {
    merchant,
    owner,
    mint,
    tokenProgram,
    ownerAta,
    initId: null,
    nonce: BigInt(Date.now()) * 1_000n,
    steps: [],
  }

  try {
    const cancelled = await grant(run, CANCELLED, 'Permission granted: 15 USDC every 30 days')
    const kept = await grant(run, KEPT, 'Permission granted: 25 USDC every 7 days')
    const cancelledTarget = await read(run, cancelled)
    const keptTarget = await read(run, kept)
    if (cancelledTarget === null || keptTarget === null) {
      throw new ScenarioError('a permission granted a moment ago is not on the network')
    }

    await refusedCharge(
      run,
      keptTarget,
      KEPT.cap + 1n,
      'before',
      'Merchant charges 25.000001 USDC — over the ceiling',
      { code: SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT },
    )

    const paths = stagePaths(owner.address, [cancelled, kept])
    const before = await recordWhenReady(
      config.apiUrl,
      paths,
      {
        listed: [cancelled, kept],
        cancelled: [],
        feeds: { [cancelled]: ['created'], [kept]: ['created', 'rejected'] },
      },
      get,
    )
    log('stage "before" recorded')

    await revoke(run, cancelledTarget, 'Owner cancels the 15 USDC permission')
    // A snapshot of the target taken before the cancellation: the closed account cannot be read (`T028`).
    await refusedCharge(
      run,
      cancelledTarget,
      USDC,
      'after',
      'Merchant charges 1 USDC on the cancelled permission',
      { runtime: CLOSED_ACCOUNT },
    )

    const after = await recordWhenReady(
      config.apiUrl,
      paths,
      {
        listed: [kept],
        cancelled: [cancelled],
        feeds: { [cancelled]: ['created', 'revoked', 'rejected'] },
      },
      get,
    )
    log('stage "after" recorded')

    return {
      version: DEMO_SNAPSHOT_VERSION,
      cluster: 'devnet',
      recordedAt: after.recordedAt,
      apiUrl: config.apiUrl,
      owner: owner.address,
      merchant: merchant.address,
      mint,
      steps: run.steps,
      stages: [
        {
          id: 'before',
          title: 'Before cancelling',
          summary:
            'The wallet has granted two permissions to the merchant. The merchant tried to ' +
            'charge one of them over its ceiling, and the program refused.',
          recordedAt: before.recordedAt,
          responses: before.responses,
        },
        {
          id: 'after',
          title: 'After cancelling',
          summary:
            'The owner cancelled the 15 USDC permission with one signature. The merchant then ' +
            'tried to charge it, and the protocol refused: the account is closed.',
          recordedAt: after.recordedAt,
          responses: after.responses,
        },
      ],
    }
  } finally {
    await returnLeftover(run)
  }
}
