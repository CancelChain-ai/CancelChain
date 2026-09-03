import { addressSchema } from '@cancelchain/shared'
import type {
  Address,
  Rpc,
  RpcSubscriptions,
  SolanaRpcApi,
  SolanaRpcSubscriptionsApi,
} from '@solana/kit'
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit'
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from '@solana/subscriptions'
import { z } from 'zod'

/**
 * Адреса Subscriptions Delegation Program. Береться **з SDK**, а не переписується
 * рядком: збіг із чужою програмою — це те, що не має права розійтися при оновленні
 * пакета, і константа з `@solana/subscriptions` розійтися не може за побудовою.
 */
export const PROGRAM_ADDRESS = SUBSCRIPTIONS_PROGRAM_ADDRESS

export const CLUSTERS = ['devnet', 'testnet', 'mainnet-beta', 'localnet'] as const
export type Cluster = (typeof CLUSTERS)[number]

function hasProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const httpUrlSchema = z
  .string()
  .refine((value) => hasProtocol(value, ['http:', 'https:']), 'expected an http(s) URL')

const wsUrlSchema = z
  .string()
  .refine((value) => hasProtocol(value, ['ws:', 'wss:']), 'expected a ws(s) URL')

/**
 * Оточення вузла мережі. `wsUrl` необов'язковий: провайдери віддають той самий
 * хост під обома протоколами, і виводити його з `rpcUrl` дешевше, ніж тримати
 * дві змінні, що мовчки розходяться. Явно заданий — має бути саме `ws`/`wss`:
 * покласти сюди `https://` — найчастіша помилка конфігурації, а падає вона аж
 * при першій підписці, тобто далеко від причини.
 */
export const chainConfigSchema = z.object({
  cluster: z.enum(CLUSTERS),
  rpcUrl: httpUrlSchema,
  wsUrl: wsUrlSchema.optional(),
  usdcMint: addressSchema,
})

export type ChainConfig = z.infer<typeof chainConfigSchema>

/** `https://host` → `wss://host`. Порт, шлях і query (ключ API) зберігаються. */
export function deriveWsUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export type ChainClient = {
  cluster: Cluster
  /** Тільки читання. Сервер не має гаманця й нічого не підписує — `FR-016`, `FR-017`. */
  rpc: Rpc<SolanaRpcApi>
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>
  programAddress: Address
  usdcMint: Address
}

export type CreateChainClientOptions = {
  /**
   * Знімає заборону на mainnet. За замовчуванням `false`, і це не перестраховка:
   * увесь продукт розроблявся на devnet, жоден `SC-*` mainnet не потребує, а
   * помилково залишений у `.env` mainnet-URL спрямував би читання на справжні
   * гроші **мовчки** — розбіжності в інтерфейсі не було б, дані просто були б чужі.
   */
  allowMainnet?: boolean
}

export class MainnetNotAllowedError extends Error {
  constructor() {
    super(
      'cluster is "mainnet-beta"; pass { allowMainnet: true } to opt in explicitly. ' +
        'CancelChain runs on devnet — no success criterion requires mainnet.',
    )
    this.name = 'MainnetNotAllowedError'
  }
}

/**
 * Read-only клієнт мережі: `rpc` для запитів і `rpcSubscriptions` для
 * `logsSubscribe` індексатора.
 *
 * Плагіна `subscriptionsProgram()` тут навмисно немає. Його вимоги —
 * `ClientWithTransactionPlanning & ClientWithTransactionSending`, тобто клієнт,
 * що вміє **надсилати** транзакції; це прямо суперечить правилу «сервер не має
 * гаманця». Усі потрібні нам читання (`fetchDelegationsByDelegator`,
 * `fetchPlansForOwner`, `fetch*FromSeeds`) приймають звичайний `Rpc<…>` окремим
 * аргументом — перевірено по типах `@solana/subscriptions@0.5.0`.
 */
export function createChainClient(
  input: ChainConfig,
  options: CreateChainClientOptions = {},
): ChainClient {
  const config = chainConfigSchema.parse(input)
  if (config.cluster === 'mainnet-beta' && options.allowMainnet !== true) {
    throw new MainnetNotAllowedError()
  }
  const wsUrl = config.wsUrl ?? deriveWsUrl(config.rpcUrl)
  return {
    cluster: config.cluster,
    rpc: createSolanaRpc(config.rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl),
    programAddress: PROGRAM_ADDRESS,
    usdcMint: config.usdcMint as Address,
  }
}

/**
 * Читання конфігурації з оточення. Приймає будь-яку мапу рядків, а не лише
 * `process.env`, — інакше пакет не можна було б перевірити без глобального стану.
 */
export function chainConfigFromEnv(env: Record<string, string | undefined>): ChainConfig {
  return chainConfigSchema.parse({
    cluster: env.SOLANA_CLUSTER,
    rpcUrl: env.SOLANA_RPC_URL,
    wsUrl: env.SOLANA_WS_URL,
    usdcMint: env.USDC_MINT,
  })
}
