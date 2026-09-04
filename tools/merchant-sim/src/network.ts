import { MainnetForbiddenError } from './config.js'

/**
 * Друга перевірка на mainnet — уже не за нашою назвою кластера, а за самою
 * мережею.
 *
 * `SOLANA_CLUSTER=devnet` — це наша заява, а `SOLANA_RPC_URL` може вести куди
 * завгодно: переплутаний ключ провайдера чи скопійований з іншого проєкту рядок
 * дають devnet-напис на екрані й mainnet під ним. Genesis hash — властивість
 * мережі, підмінити його написом у `.env` не можна.
 */

/** Загальновідомий genesis hash mainnet-beta. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

/**
 * Мінімальна форма клієнта, потрібна для перевірки. Структурна, а не
 * `Rpc<SolanaRpcApi>`: так її можна перевірити без мережі, а справжній клієнт
 * kit підходить сюди за побудовою.
 */
export type GenesisHashRpc = {
  getGenesisHash(): { send(): Promise<string> }
}

/**
 * Свідомо перевіряється **лише** mainnet. Список «дозволених» genesis hash
 * означав би, що локальний валідатор — у нього хеш свій на кожен запуск — не
 * пройшов би перевірку, і правило довелося б обходити прапорцем.
 */
export async function assertNotMainnet(rpc: GenesisHashRpc): Promise<string> {
  const genesisHash = await rpc.getGenesisHash().send()
  if (genesisHash === MAINNET_GENESIS_HASH) {
    throw new MainnetForbiddenError(`the RPC node reports the mainnet genesis hash ${genesisHash}`)
  }
  return genesisHash
}
