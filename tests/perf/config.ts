import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type MerchantSimConfig, merchantSimConfigFromEnv } from '@cancelchain/merchant-sim'

/**
 * Environment of the `T047` measurements against the deployed stand.
 *
 * Every run here sends real transactions or opens the real site, so nothing has a
 * silent default that could point it somewhere else: the stand's addresses are the
 * deployed ones unless named otherwise, and the keys come only from files outside
 * the repository (checked in `merchant-sim`).
 */

/** The deployed web app (Pages, `T046`). */
export const DEFAULT_APP_URL = 'https://cancelchain-ai.github.io/CancelChain/app/'

/** The deployed API with the indexer in its process (Render, `T046`). */
export const DEFAULT_API_URL = 'https://cancelchain-api.onrender.com'

/** The domain the API signs merchants in for (`AUTH_DOMAIN` in `render.yaml`). */
export const DEFAULT_AUTH_DOMAIN = 'cancelchain-ai.github.io'

/** Chrome stable as installed on Windows. Override with `PERF_CHROME_PATH` elsewhere. */
export const DEFAULT_CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/**
 * Public nodes the runs refuse to send through.
 *
 * Not politeness: the public devnet node answers 429 after about ten transactions,
 * and a client's own backoff then becomes part of every number measured — the run
 * would time its retries, not the product. The measurements need a keyed node.
 */
export const PUBLIC_RPC_HOSTS: readonly string[] = [
  'api.devnet.solana.com',
  'api.testnet.solana.com',
  'api.mainnet-beta.solana.com',
]

export class PerfConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PerfConfigError'
  }
}

export type PerfConfig = {
  merchant: MerchantSimConfig
  /** The wallet that holds the measured permissions. It signs grants and revocations. */
  ownerKeypairPath: string
  appUrl: string
  apiUrl: string
  authDomain: string
  chromePath: string
  /** Raw samples go here, outside the repository. */
  outDir: string
}

/** Throws when the node is a public one. The message names the host, never the key. */
export function assertKeyedRpc(rpcUrl: string): void {
  let host: string
  try {
    host = new URL(rpcUrl).host
  } catch {
    throw new PerfConfigError('SOLANA_RPC_URL is not a URL')
  }
  if (PUBLIC_RPC_HOSTS.includes(host)) {
    throw new PerfConfigError(
      `SOLANA_RPC_URL points at the public node ${host}. It rate-limits after about ten ` +
        'transactions, and its backoff would be measured instead of the product — use a keyed node',
    )
  }
}

function urlFrom(raw: string | undefined, fallback: string, name: string): string {
  const value = raw === undefined || raw === '' ? fallback : raw
  if (!URL.canParse(value)) throw new PerfConfigError(`${name} is not a URL: "${value}"`)
  return value
}

export function perfConfigFromEnv(env: Record<string, string | undefined>): PerfConfig {
  const merchant = merchantSimConfigFromEnv(env)
  assertKeyedRpc(merchant.chain.rpcUrl)

  const ownerKeypairPath = env.PERF_OWNER_KEYPAIR_PATH
  if (ownerKeypairPath === undefined || ownerKeypairPath === '') {
    throw new PerfConfigError(
      'PERF_OWNER_KEYPAIR_PATH is not set. The measured permissions are granted and revoked by ' +
        'their owner, and the merchant key cannot sign for it',
    )
  }

  return {
    merchant,
    ownerKeypairPath,
    appUrl: urlFrom(env.PERF_APP_URL, DEFAULT_APP_URL, 'PERF_APP_URL'),
    apiUrl: urlFrom(env.PERF_API_URL, DEFAULT_API_URL, 'PERF_API_URL').replace(/\/+$/, ''),
    authDomain:
      env.PERF_AUTH_DOMAIN === undefined || env.PERF_AUTH_DOMAIN === ''
        ? DEFAULT_AUTH_DOMAIN
        : env.PERF_AUTH_DOMAIN,
    chromePath:
      env.PERF_CHROME_PATH === undefined || env.PERF_CHROME_PATH === ''
        ? DEFAULT_CHROME_PATH
        : env.PERF_CHROME_PATH,
    outDir:
      env.PERF_OUT_DIR === undefined || env.PERF_OUT_DIR === ''
        ? join(tmpdir(), 'cancelchain-perf')
        : env.PERF_OUT_DIR,
  }
}
