import { describe, expect, it } from 'vitest'
import {
  ALLOWED_CLUSTERS,
  assertAllowedCluster,
  KEYPAIR_FILE_SUFFIX,
  KeypairPathError,
  MainnetForbiddenError,
  merchantSimConfigFromEnv,
} from './config.js'

const ENV = {
  SOLANA_CLUSTER: 'devnet',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  MERCHANT_SIM_KEYPAIR_PATH: 'C:/keys/merchant-devnet.keypair.json',
} as const

describe('merchantSimConfigFromEnv', () => {
  it('збирає конфіг із оточення', () => {
    const config = merchantSimConfigFromEnv({ ...ENV })
    expect(config.cluster).toBe('devnet')
    expect(config.keypairPath).toBe(ENV.MERCHANT_SIM_KEYPAIR_PATH)
    expect(config.chain.rpcUrl).toBe(ENV.SOLANA_RPC_URL)
  })

  it('mainnet заборонений, і прапорця-винятку не існує', () => {
    expect(() => merchantSimConfigFromEnv({ ...ENV, SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(
      MainnetForbiddenError,
    )
  })

  it('шлях до ключа не має значення за замовчуванням — його не буває', () => {
    const { MERCHANT_SIM_KEYPAIR_PATH: _, ...withoutKey } = ENV
    expect(() => merchantSimConfigFromEnv({ ...withoutKey })).toThrow(KeypairPathError)
    expect(() => merchantSimConfigFromEnv({ ...ENV, MERCHANT_SIM_KEYPAIR_PATH: '' })).toThrow(
      KeypairPathError,
    )
  })

  it(`ім'я файлу мусить збігатися з патерном .gitignore (${KEYPAIR_FILE_SUFFIX})`, () => {
    // Інакше помилковий `git add` затягнув би ключ у коміт.
    expect(() =>
      merchantSimConfigFromEnv({ ...ENV, MERCHANT_SIM_KEYPAIR_PATH: 'C:/keys/id.json' }),
    ).toThrow(KeypairPathError)
    // Дамп ZodError у консолі — шум замість причини; назовні йде одне речення.
    expect(() =>
      merchantSimConfigFromEnv({ ...ENV, MERCHANT_SIM_KEYPAIR_PATH: 'C:/keys/id.json' }),
    ).toThrow(/keypair file name must end with/)
  })

  it('решта кластерів дозволена', () => {
    for (const cluster of ALLOWED_CLUSTERS) {
      expect(merchantSimConfigFromEnv({ ...ENV, SOLANA_CLUSTER: cluster }).cluster).toBe(cluster)
    }
  })

  it('mainnet-beta немає в переліку дозволених', () => {
    expect(ALLOWED_CLUSTERS).not.toContain('mainnet-beta')
  })
})

describe('assertAllowedCluster', () => {
  it('пропускає devnet і зупиняє mainnet-beta', () => {
    expect(() => assertAllowedCluster('devnet')).not.toThrow()
    expect(() => assertAllowedCluster('mainnet-beta')).toThrow(MainnetForbiddenError)
  })
})
