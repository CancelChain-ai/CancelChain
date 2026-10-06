import { PerfConfigError, perfConfigFromEnv } from './config.js'
import { sc003 } from './sc003.js'
import { sc006 } from './sc006.js'
import { sc008 } from './sc008.js'
import { sc009 } from './sc009.js'
import { seed } from './seed.js'

/**
 * `pnpm --filter @cancelchain/e2e perf <command>` — the `T047` runs, one at a time.
 *
 * Each command works against the deployed stand and prints its verdict; raw
 * samples go to `PERF_OUT_DIR`, outside the repository.
 */

const USAGE = `perf <command>

  seed     Bring the measured wallet to 100 permissions and wait until the API lists them.
  sc003    The full list of 100 on screen: p95 < 3 s.
  sc008    The dashboard's first screen on WebPageTest 3G: < 2 s, every sample.
  sc006    A rejected charge in the card's feed: < 30 s, every sample.
  sc009    A permission revoked elsewhere leaves the open list: 0 cases > 15 s.

Environment: SOLANA_CLUSTER, SOLANA_RPC_URL (a keyed node), USDC_MINT,
MERCHANT_SIM_KEYPAIR_PATH, PERF_OWNER_KEYPAIR_PATH; optional PERF_APP_URL, PERF_API_URL,
PERF_AUTH_DOMAIN, PERF_CHROME_PATH, PERF_OUT_DIR, PERF_SAMPLES.
`

/** `PERF_SAMPLES`, or the run's own default. Fewer than the default is allowed for a dry run. */
function samples(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.PERF_SAMPLES
  if (raw === undefined || raw === '') return undefined
  if (!/^[1-9]\d*$/.test(raw))
    throw new PerfConfigError(`PERF_SAMPLES must be a positive integer, got "${raw}"`)
  return Number(raw)
}

const commands: Record<string, (env: NodeJS.ProcessEnv) => Promise<void>> = {
  seed: (env) => seed(perfConfigFromEnv(env)),
  sc003: (env) => sc003(perfConfigFromEnv(env), samples(env)),
  sc006: (env) => sc006(perfConfigFromEnv(env), samples(env)),
  sc008: (env) => sc008(perfConfigFromEnv(env), samples(env)),
  sc009: (env) => sc009(perfConfigFromEnv(env), samples(env)),
}

const name = process.argv[2]
const command = name === undefined ? undefined : commands[name]
if (command === undefined) {
  process.stderr.write(USAGE)
  process.exitCode = 2
} else {
  try {
    await command(process.env)
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
