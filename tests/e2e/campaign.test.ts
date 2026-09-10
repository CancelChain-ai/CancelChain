import type { ChargeRpc, ChargeTarget } from '@cancelchain/merchant-sim'
import type { Address, Blockhash, Signature, TransactionSigner } from '@solana/kit'
import { generateKeyPairSigner } from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { beforeAll, describe, expect, it } from 'vitest'
import { describeTally, runCampaign } from './campaign.js'
import { e2eConfigFromEnv, MIN_ATTEMPTS } from './config.js'

/**
 * Модульні тести рушія прогону. Виконуються завжди, без мережі й без ключів:
 * рахунок спроб — це те, чим `SC-001` доводиться, і помилка в ньому дала б
 * зелений рядок у таблиці M1 без жодного виміру.
 */

const PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH' as Address
const OWNER = '4DYhzGx6zWLmFDCBLJfCyRpTBnJnbfLqzHz7BvUJBFHU' as Address
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash

let merchant: TransactionSigner

beforeAll(async () => {
  merchant = await generateKeyPairSigner()
})

/** Що мережа відповість на чергову спробу. */
type Outcome = 'charged' | 'unknown' | 'no-attempt' | { rejected: number | null }

/**
 * Підроблена мережа, що відповідає за сценарієм. Підміняється саме RPC, а не
 * `attemptCharge`: інакше перевірявся б не той шлях, яким прогін піде на devnet.
 */
function scriptedRpc(script: readonly Outcome[]): ChargeRpc {
  let index = -1
  const current = (): Outcome => script[Math.min(index, script.length - 1)] ?? 'unknown'
  return {
    getLatestBlockhash: () => ({
      send: async () => {
        index += 1
        if (current() === 'no-attempt') throw new Error('rpc down')
        return { value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1n } }
      },
    }),
    sendTransaction: () => ({ send: async () => 'sent' as Signature }),
    getSignatureStatuses: () => ({
      send: async () => {
        const outcome = current()
        if (outcome === 'charged') return { value: [{ err: null, slot: 1n }] }
        if (typeof outcome === 'object') {
          const err =
            outcome.rejected === null
              ? 'AccountInUse'
              : { InstructionError: [0, { Custom: outcome.rejected }] }
          return { value: [{ err, slot: 1n }] }
        }
        return { value: [null] }
      },
    }),
  }
}

const TARGET: ChargeTarget = {
  delegate: '' as Address,
  kind: 'fixed',
  mint: MINT,
  owner: OWNER,
  pda: PDA,
  planPda: null,
}

const run = (
  script: readonly Outcome[],
  options: { attempts?: number; maxSends?: number; stopOnCharge?: boolean } = {},
) =>
  runCampaign(
    scriptedRpc(script),
    {
      allowance: { ...TARGET, delegate: merchant.address },
      amount: 1_000n,
      merchant,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    },
    {
      attempts: options.attempts ?? 3,
      maxSends: options.maxSends ?? 50,
      sleep: async () => {},
      stopOnCharge: options.stopOnCharge ?? false,
      attemptOptions: { pollAttempts: 1, pollIntervalMs: 0, sleep: async () => {} },
    },
  )

describe('рахунок спроб', () => {
  it('набирає рівно стільки розсуджених спроб, скільки просили', async () => {
    const tally = await run([{ rejected: 111 }], { attempts: 5 })
    expect(tally.judged).toBe(5)
    expect(tally.rejected).toBe(5)
    expect(tally.sends).toBe(5)
  })

  it('мовчання мережі спробою не рахується — цикл іде далі', async () => {
    const tally = await run(['unknown', 'unknown', { rejected: 111 }], { attempts: 2 })
    expect(tally.unknown).toBe(2)
    expect(tally.judged).toBe(2)
    expect(tally.sends).toBe(4)
  })

  it('ненадіслана транзакція спробою не рахується', async () => {
    const tally = await run(['no-attempt', 'no-attempt', { rejected: 300 }], { attempts: 1 })
    expect(tally.noAttempt).toBe(2)
    expect(tally.judged).toBe(1)
  })

  it('стеля надсилань спиняє цикл, і недобір видно у звіті', async () => {
    const tally = await run(['unknown'], { attempts: 200, maxSends: 7 })
    expect(tally.sends).toBe(7)
    expect(tally.judged).toBe(0)
    expect(tally.judged).toBeLessThan(200)
  })

  it('успішне списання спиняє прогін, коли про це попросили', async () => {
    const tally = await run(['charged'], { attempts: 200, stopOnCharge: true })
    expect(tally.charged).toBe(1)
    expect(tally.sends).toBe(1)
    expect(tally.chargedSignatures).toHaveLength(1)
  })

  it('без stopOnCharge успіхи рахуються далі — це теж вимір', async () => {
    const tally = await run(['charged'], { attempts: 3 })
    expect(tally.charged).toBe(3)
  })

  it('коди помилок програми рахуються поіменно', async () => {
    const tally = await run([{ rejected: 300 }, { rejected: 300 }, { rejected: null }], {
      attempts: 3,
    })
    expect(tally.codes).toEqual({ '300': 2, none: 1 })
    expect(tally.sampleRejectedSignature).not.toBeNull()
  })
})

describe('describeTally', () => {
  it('показує й те, що не враховано — інакше нуль нічого не означає', async () => {
    const tally = await run(['unknown', { rejected: 300 }], { attempts: 1 })
    const text = describeTally(tally)
    expect(text).toContain('not counted')
    expect(text).toContain('unknown 1')
    expect(text).toContain('300×1')
  })
})

const ENV = {
  E2E_ALLOWANCE_PDA: PDA,
  E2E_CHARGE_AMOUNT: '1000000',
  MERCHANT_SIM_KEYPAIR_PATH: '/outside/repo/merchant-devnet.keypair.json',
  SOLANA_CLUSTER: 'devnet',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  USDC_MINT: MINT,
} as const

describe('оточення прогону', () => {
  it('повне оточення дає готову конфігурацію', () => {
    const setup = e2eConfigFromEnv({ ...ENV })
    expect(setup.ready).toBe(true)
    if (!setup.ready) return
    expect(setup.config.attempts).toBe(MIN_ATTEMPTS)
    expect(setup.config.ownerKeypairPath).toBeNull()
    expect(setup.config.chargeAmount).toBe(1_000_000n)
  })

  it('менше ніж ≥200 спроб не приймається навіть на прохання', () => {
    const setup = e2eConfigFromEnv({ ...ENV, E2E_ATTEMPTS: '5' })
    expect(setup.ready).toBe(false)
    if (setup.ready) return
    expect(setup.reason).toContain('at least 200')
  })

  it('без дозволу прогін пропускається з названою причиною, а не падає', () => {
    const { E2E_ALLOWANCE_PDA: _ignored, ...rest } = ENV
    const setup = e2eConfigFromEnv({ ...rest })
    expect(setup.ready).toBe(false)
    if (setup.ready) return
    expect(setup.reason).toContain('E2E_ALLOWANCE_PDA')
  })

  it('суму не вигадуємо за оператора', () => {
    const { E2E_CHARGE_AMOUNT: _ignored, ...rest } = ENV
    const setup = e2eConfigFromEnv({ ...rest })
    expect(setup.ready).toBe(false)
    if (setup.ready) return
    expect(setup.reason).toContain('E2E_CHARGE_AMOUNT')
  })

  it('mainnet не проходить сюди так само, як не проходить у merchant-sim', () => {
    const setup = e2eConfigFromEnv({ ...ENV, SOLANA_CLUSTER: 'mainnet-beta' })
    expect(setup.ready).toBe(false)
    if (setup.ready) return
    expect(setup.reason).toContain('MainnetForbiddenError')
  })

  it('ключ власника, коли заданий, приїжджає у конфігурацію', () => {
    const setup = e2eConfigFromEnv({
      ...ENV,
      E2E_OWNER_KEYPAIR_PATH: '/outside/repo/owner-devnet.keypair.json',
    })
    expect(setup.ready).toBe(true)
    if (!setup.ready) return
    expect(setup.config.ownerKeypairPath).toBe('/outside/repo/owner-devnet.keypair.json')
  })
})
