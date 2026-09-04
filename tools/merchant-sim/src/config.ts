import { type ChainConfig, type Cluster, chainConfigFromEnv } from '@cancelchain/chain'
import { z } from 'zod'

/**
 * Тестовий мерчант (`FR-023`) — єдине місце в продукті, де взагалі є приватний
 * ключ. Тому правила навколо нього жорсткіші за зручність:
 *
 * 1. Ключ береться **тільки** з файлу, шлях до якого лежить в оточенні;
 * 2. ім'я файлу мусить збігатися з патерном `.gitignore` — інакше помилковий
 *    `git add` затягнув би його в коміт;
 * 3. mainnet заборонений двічі — за назвою кластера тут і за genesis hash
 *    самої мережі при старті (`assertNotMainnet`).
 */

/** Патерн із `.gitignore`. Ім'я файлу — частина захисту, а не косметика. */
export const KEYPAIR_FILE_SUFFIX = '.keypair.json'

/**
 * Кластери, у яких тестовому мерчанту дозволено працювати. `mainnet-beta` тут
 * немає й не буде: жоден `SC-*` його не потребує, а ключ, що підписує списання,
 * на mainnet підписував би справжні гроші.
 */
export const ALLOWED_CLUSTERS = ['devnet', 'testnet', 'localnet'] as const
export type AllowedCluster = (typeof ALLOWED_CLUSTERS)[number]

export class MainnetForbiddenError extends Error {
  constructor(detail: string) {
    super(
      `merchant-sim refuses to run against mainnet (${detail}). It signs charges with a real ` +
        'private key; on mainnet those would be real money. There is no opt-in flag by design.',
    )
    this.name = 'MainnetForbiddenError'
  }
}

export class KeypairPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KeypairPathError'
  }
}

const keypairPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.endsWith(KEYPAIR_FILE_SUFFIX),
    `keypair file name must end with "${KEYPAIR_FILE_SUFFIX}" — that is the pattern .gitignore covers`,
  )

export const merchantSimConfigSchema = z.object({
  keypairPath: keypairPathSchema,
  cluster: z.enum(ALLOWED_CLUSTERS),
})

export type MerchantSimConfig = z.infer<typeof merchantSimConfigSchema> & {
  chain: ChainConfig
}

/** Звужує кластер до дозволеного, називаючи mainnet окремою помилкою. */
export function assertAllowedCluster(cluster: Cluster): asserts cluster is AllowedCluster {
  if (cluster === 'mainnet-beta') throw new MainnetForbiddenError('SOLANA_CLUSTER=mainnet-beta')
}

export function merchantSimConfigFromEnv(
  env: Record<string, string | undefined>,
): MerchantSimConfig {
  const chain = chainConfigFromEnv(env)
  assertAllowedCluster(chain.cluster)
  const keypairPath = env.MERCHANT_SIM_KEYPAIR_PATH
  if (keypairPath === undefined || keypairPath === '') {
    throw new KeypairPathError(
      'MERCHANT_SIM_KEYPAIR_PATH is not set. The devnet key lives in a file outside the ' +
        'repository; there is no built-in key and no default path.',
    )
  }
  const parsed = merchantSimConfigSchema.safeParse({ keypairPath, cluster: chain.cluster })
  if (!parsed.success) {
    // Дамп ZodError у консолі CLI — це шум замість причини; тут вона одна.
    throw new KeypairPathError(parsed.error.issues.map((issue) => issue.message).join('; '))
  }
  return { ...parsed.data, chain }
}
