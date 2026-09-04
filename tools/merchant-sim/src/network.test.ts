import { address } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { MainnetForbiddenError } from './config.js'
import { describeMerchant } from './merchant.js'
import { assertNotMainnet, type GenesisHashRpc, MAINNET_GENESIS_HASH } from './network.js'

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

function rpcReturning(genesisHash: string): GenesisHashRpc {
  return { getGenesisHash: () => ({ send: async () => genesisHash }) }
}

describe('assertNotMainnet', () => {
  it('mainnet за genesis hash зупиняється, навіть коли в .env написано devnet', async () => {
    // Назва кластера — наша заява; genesis hash — властивість самої мережі.
    await expect(assertNotMainnet(rpcReturning(MAINNET_GENESIS_HASH))).rejects.toThrow(
      MainnetForbiddenError,
    )
  })

  it('у повідомленні видно, що саме побачив вузол', async () => {
    await expect(assertNotMainnet(rpcReturning(MAINNET_GENESIS_HASH))).rejects.toThrow(
      new RegExp(MAINNET_GENESIS_HASH),
    )
  })

  it('devnet проходить і повертає свій хеш', async () => {
    await expect(assertNotMainnet(rpcReturning(DEVNET_GENESIS_HASH))).resolves.toBe(
      DEVNET_GENESIS_HASH,
    )
  })

  it('незнайомий хеш проходить — у локального валідатора він свій на кожен запуск', async () => {
    const local = '3sVdVfhBRnbCq6MRQ8eLTQFrTh1w7Vh3Xu6uzp6NfCcy'
    await expect(assertNotMainnet(rpcReturning(local))).resolves.toBe(local)
  })
})

describe('describeMerchant', () => {
  it('показує кластер, хеш і адресу — і нічого більше', () => {
    const text = describeMerchant({
      cluster: 'devnet',
      genesisHash: DEVNET_GENESIS_HASH,
      address: address('De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44'),
    })
    expect(text.split('\n')).toHaveLength(3)
    expect(text).toContain('De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44')
    expect(text).toContain(DEVNET_GENESIS_HASH)
  })
})
