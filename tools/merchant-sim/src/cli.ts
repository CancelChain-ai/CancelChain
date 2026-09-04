#!/usr/bin/env tsx
import { merchantSimConfigFromEnv } from './config.js'
import { createMerchantSim, describeMerchant } from './merchant.js'

/**
 * CLI тестового мерчанта. Поки що одна команда — `whoami`: вона доводить, що
 * ключ читається, мережа відповідає і це не mainnet. Списання за дозволом
 * (`charge`), створення плану (`plan`) і повний сценарій демо стають сюди
 * наступними задачами.
 */

const USAGE = `merchant-sim <command>

Commands:
  whoami    Show the merchant address, the cluster and its genesis hash.

Not implemented yet: charge (a pull against an allowance), plan (create a plan),
demo (the full reproducible scenario).

Environment:
  SOLANA_CLUSTER              devnet | testnet | localnet — never mainnet-beta
  SOLANA_RPC_URL              node URL
  USDC_MINT                   settlement mint
  MERCHANT_SIM_KEYPAIR_PATH   path to a *.keypair.json outside the repository
`

/** Лампорти → SOL для показу. Точність тут не потрібна, це діагностика. */
function formatSol(lamports: bigint): string {
  return (Number(lamports) / 1_000_000_000).toFixed(4)
}

async function whoami(): Promise<void> {
  const config = merchantSimConfigFromEnv(process.env)
  const merchant = await createMerchantSim(config)
  const { value: lamports } = await merchant.chain.rpc.getBalance(merchant.address).send()
  process.stdout.write(`${describeMerchant(merchant)}\nbalance:      ${formatSol(lamports)} SOL\n`)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'whoami') {
    await whoami()
    return
  }
  process.stdout.write(USAGE)
  // Невідома команда — не те саме, що прохання про довідку.
  if (command !== undefined && command !== '--help' && command !== '-h') {
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  // Назва помилки несе причину (MainnetForbiddenError, KeypairFileError), і
  // саме вона потрібна на екрані. Стек — ні: у ньому шлях до файлу з ключем.
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
