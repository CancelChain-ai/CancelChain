#!/usr/bin/env tsx
import { readAllowance, toAddress } from '@cancelchain/chain'
import {
  attemptCharge,
  type ChargeTarget,
  type ChargeTargetFields,
  chargeTarget,
  describeVerdict,
  resolveTokenProgram,
} from './charge.js'
import { merchantSimConfigFromEnv } from './config.js'
import { createMerchantSim, describeMerchant, type MerchantSim } from './merchant.js'

/**
 * CLI тестового мерчанта. Дві команди: `whoami` доводить, що ключ читається,
 * мережа відповідає і це не mainnet; `charge` робить спробу списання за
 * дозволом — у тому числі за вже відкликаним.
 *
 * Тут лише розбір аргументів і друк. Усі рішення про те, за чим списувати й що
 * означає відповідь мережі, живуть у `charge.ts` — інакше їх не було б чим
 * перевірити, крім запуску процесу.
 *
 * Створення плану (`T034`) і повний сценарій демо (`T056`) стають сюди далі.
 */

const USAGE = `merchant-sim <command>

Commands:
  whoami                        Show the merchant address, the cluster and its genesis hash.
  charge <allowancePda> --amount <units> [target flags]
                                Attempt one pull against an allowance and report what the
                                network answered. Always sends: the protocol is the judge.

Charge flags:
  --amount <units>              Base units of the mint (u64), not display units. Required.
  --receiver-ata <address>      Where to credit. Default: the merchant's ATA for that mint.
  --preflight                   Simulate on the node first. Off by default: a doomed attempt
                                must land on chain, otherwise there is no signature to link.

Target flags — needed only once the allowance account is gone, which is what a revoked
allowance is. While the account exists the target is read from the network, and a flag that
disagrees with it is an error rather than an override:
  --kind fixed|recurring|subscription
  --owner <address>             The wallet the allowance was granted from.
  --mint <address>              The settlement mint.
  --delegate <address>          fixed/recurring: the merchant wallet the allowance names.
  --plan <address>              subscription: the plan account.

Not implemented yet: plan (create a plan), demo (the full reproducible scenario).

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

class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

type Flags = Map<string, string | true>

/**
 * Розбір `--ключ значення` і `--прапорець`. Свій, а не бібліотека: аргументів
 * тут одиниці, а зайва залежність у пакеті, який тримає приватний ключ, — це
 * зайвий чужий код поруч із ним.
 */
function parseFlags(argv: readonly string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = []
  const flags: Flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(name, true)
      continue
    }
    flags.set(name, next)
    index += 1
  }
  return { positional, flags }
}

function flagValue(flags: Flags, name: string): string | undefined {
  const value = flags.get(name)
  if (value === true) throw new UsageError(`--${name} needs a value`)
  return value
}

function targetFields(flags: Flags): ChargeTargetFields {
  const fields: ChargeTargetFields = {}
  for (const name of ['kind', 'owner', 'mint', 'delegate', 'plan'] as const) {
    const value = flagValue(flags, name)
    if (value !== undefined) fields[name] = value
  }
  return fields
}

function parseAmount(raw: string | undefined): bigint {
  if (raw === undefined)
    throw new UsageError('--amount is required: how much to pull, in base units')
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`--amount must be a whole number of base units, got "${raw}"`)
  }
  return BigInt(raw)
}

/** Команда, якою цю саму спробу повторюють після скасування дозволу. */
function repeatCommand(target: ChargeTarget, amount: bigint): string {
  const tail =
    target.kind === 'subscription'
      ? `--plan ${target.planPda ?? ''}`
      : `--delegate ${target.delegate}`
  return (
    `merchant-sim charge ${target.pda} --amount ${amount} --kind ${target.kind} ` +
    `--owner ${target.owner} --mint ${target.mint} ${tail}`
  )
}

function explorerUrl(merchant: MerchantSim, signature: string): string {
  if (merchant.cluster === 'localnet') return `local validator — no public explorer (${signature})`
  return `https://explorer.solana.com/tx/${signature}?cluster=${merchant.cluster}`
}

async function whoami(): Promise<void> {
  const config = merchantSimConfigFromEnv(process.env)
  const merchant = await createMerchantSim(config)
  const { value: lamports } = await merchant.chain.rpc.getBalance(merchant.address).send()
  process.stdout.write(`${describeMerchant(merchant)}\nbalance:      ${formatSol(lamports)} SOL\n`)
}

/**
 * Спроба списання.
 *
 * Порядок навмисний: мережа питається **лише** про те, з яких акаунтів складати
 * транзакцію. Далі транзакція йде в мережу незалежно від того, що читання
 * показало, — рішення «дозволено чи ні» ухвалює програма (`FR-004`). Тому
 * «дозволу немає» тут не зупиняє команду, а лише вимагає назвати мішень
 * прапорцями.
 */
async function charge(argv: readonly string[]): Promise<void> {
  const { positional, flags } = parseFlags(argv)
  const pda = positional[0]
  if (pda === undefined) throw new UsageError('charge needs the allowance address')
  const amount = parseAmount(flagValue(flags, 'amount'))

  const merchant = await createMerchantSim(merchantSimConfigFromEnv(process.env))
  const { allowance } = await readAllowance(merchant.chain, { pda: toAddress(pda) })
  const target = chargeTarget(allowance, pda, targetFields(flags))
  const tokenProgram = await resolveTokenProgram(merchant.chain.rpc, toAddress(target.mint))

  const onChain =
    allowance === null
      ? 'no account — charging a revoked or closed allowance'
      : `yes, status ${allowance.status}`
  process.stdout.write(
    `${[
      describeMerchant(merchant),
      `allowance:    ${target.pda}`,
      `on chain:     ${onChain}`,
      `kind:         ${target.kind}`,
      `owner:        ${target.owner}`,
      `mint:         ${target.mint}  (token program ${tokenProgram})`,
      `amount:       ${amount} base units`,
      '',
    ].join('\n')}\n`,
  )

  const receiverAta = flagValue(flags, 'receiver-ata')
  const verdict = await attemptCharge(
    merchant.chain.rpc,
    {
      allowance: target,
      amount,
      merchant: merchant.signer,
      tokenProgram,
      ...(receiverAta === undefined ? {} : { receiverAta }),
    },
    { skipPreflight: flags.get('preflight') !== true },
  )

  const trailer =
    verdict.signature === null
      ? []
      : ['', `explorer:     ${explorerUrl(merchant, verdict.signature)}`]
  if (allowance !== null) {
    trailer.push('', 'repeat once the wallet revokes it:', `  ${repeatCommand(target, amount)}`)
  }
  process.stdout.write(`${describeVerdict(verdict)}${trailer.join('\n')}\n`)

  /*
   * Відхилена спроба — очікуваний результат сценарію, а не збій команди: після
   * скасування вона й **мусить** бути відхилена. Ненульовий код лишається за
   * випадком, коли спроби не сталося взагалі, — його не можна порахувати ані
   * успіхом, ані відмовою.
   */
  if (verdict.outcome === 'no-attempt') process.exitCode = 1
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'whoami') {
    await whoami()
    return
  }
  if (command === 'charge') {
    await charge(rest)
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
