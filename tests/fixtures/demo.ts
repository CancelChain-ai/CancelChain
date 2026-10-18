import { readFile, writeFile } from 'node:fs/promises'
import { chainConfigFromEnv, createChainClient } from '@cancelchain/chain'
import { merchantSimConfigFromEnv } from '@cancelchain/merchant-sim'
import { demoSnapshotSchema } from '@cancelchain/shared/snapshot'
import type { Signature } from '@solana/kit'
import { DEFAULT_API_URL } from '../perf/config.js'
import { captureDemo } from './demo/scenario.js'
import { stepMismatches } from './demo/verify.js'

/**
 * `pnpm --filter @cancelchain/e2e demo capture|verify` — the recorded demo for a
 * show on an unstable devnet (`T058`).
 *
 * `capture` runs the scenario on devnet and writes what the deployed API
 * answered to `fixtures/demo-snapshot.json`, which `apps/web` replays with
 * `VITE_DATA_SOURCE=snapshot`. `verify` asks the network about every recorded
 * transaction — the check before a show, and it needs no key.
 */

const SNAPSHOT_FILE = new URL('./demo-snapshot.json', import.meta.url)

const USAGE = `demo <command>

  capture   run the scenario on devnet and record it
            env: MERCHANT_SIM_KEYPAIR_PATH, SOLANA_*, USDC_MINT (devnet USDC),
                 DEMO_API_URL (default ${DEFAULT_API_URL})
  verify    check every recorded transaction against the network
            env: SOLANA_*, USDC_MINT
`

async function capture(): Promise<void> {
  const apiUrl = (process.env.DEMO_API_URL || DEFAULT_API_URL).replace(/\/+$/, '')
  const snapshot = await captureDemo({ merchant: merchantSimConfigFromEnv(process.env), apiUrl })
  // Parsed before it is written: the file the app replays never holds what the schema refuses.
  const checked = demoSnapshotSchema.parse(snapshot)
  await writeFile(SNAPSHOT_FILE, `${JSON.stringify(checked, null, 2)}\n`, 'utf8')
  process.stdout.write(`\nwritten ${SNAPSHOT_FILE.pathname}\n`)
}

async function verify(): Promise<boolean> {
  const snapshot = demoSnapshotSchema.parse(JSON.parse(await readFile(SNAPSHOT_FILE, 'utf8')))
  const config = chainConfigFromEnv(process.env)
  if (config.cluster !== snapshot.cluster) {
    throw new Error(`the recording is on ${snapshot.cluster}, SOLANA_CLUSTER is ${config.cluster}`)
  }
  const { rpc } = createChainClient(config)
  const { value } = await rpc
    .getSignatureStatuses(
      snapshot.steps.map((step) => step.signature as Signature),
      { searchTransactionHistory: true },
    )
    .send()
  const mismatches = stepMismatches(snapshot.steps, value)

  process.stdout.write(`recorded ${snapshot.recordedAt} through ${snapshot.apiUrl}\n\n`)
  for (const step of snapshot.steps) {
    process.stdout.write(`${step.outcome.padEnd(10)} ${step.label}\n           ${step.signature}\n`)
  }
  if (mismatches.length === 0) {
    process.stdout.write(
      `\nall ${snapshot.steps.length} transactions are on ${snapshot.cluster} as recorded\n`,
    )
    return true
  }
  process.stdout.write(`\n${mismatches.join('\n')}\n`)
  return false
}

async function main(): Promise<number> {
  const [command] = process.argv.slice(2)
  if (command === 'capture') {
    await capture()
    return 0
  }
  if (command === 'verify') return (await verify()) ? 0 : 1
  process.stdout.write(USAGE)
  return command === undefined || command === '--help' ? 0 : 2
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  },
)
