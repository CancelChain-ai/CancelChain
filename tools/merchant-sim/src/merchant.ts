import { type ChainClient, createChainClient } from '@cancelchain/chain'
import type { Address, KeyPairSigner } from '@solana/kit'
import type { AllowedCluster, MerchantSimConfig } from './config.js'
import { loadMerchantSigner } from './keypair.js'
import { assertNotMainnet } from './network.js'

/**
 * Тестовий мерчант: підписувач + клієнт мережі. Списання (`T027`), створення
 * плану (`T034`) і сценарій демо (`T056`) стануть на цей каркас.
 *
 * Роль мерчанта в усіх показах грає саме він, і жоден `SC-*` не доводить, що
 * справжні мерчанти згодні приймати оплату так само — це називається вголос
 * при кожному показі: межа мока і справжнього проходить саме тут.
 */
export type MerchantSim = {
  cluster: AllowedCluster
  address: Address
  signer: KeyPairSigner
  chain: ChainClient
  /** Хеш, за яким перевірено, що це не mainnet. */
  genesisHash: string
}

export async function createMerchantSim(config: MerchantSimConfig): Promise<MerchantSim> {
  // `createChainClient` відмовляє mainnet без явного дозволу; прапорця сюди не
  // передаємо ніколи — це третій замок після назви кластера й genesis hash.
  const chain = createChainClient(config.chain)
  const signer = await loadMerchantSigner(config.keypairPath)
  const genesisHash = await assertNotMainnet(chain.rpc)
  return {
    cluster: config.cluster,
    address: signer.address,
    signer,
    chain,
    genesisHash,
  }
}

/**
 * Рядок для CLI. Приватної частини ключа тут немає й бути не може: підписувач
 * тримає непритягуваний `CryptoKey`, а назовні віддає лише адресу.
 */
export function describeMerchant(merchant: Omit<MerchantSim, 'signer' | 'chain'>): string {
  return [
    `cluster:      ${merchant.cluster}`,
    `genesis:      ${merchant.genesisHash}`,
    `merchant:     ${merchant.address}`,
  ].join('\n')
}
