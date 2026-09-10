import { type MerchantSimConfig, merchantSimConfigFromEnv } from '@cancelchain/merchant-sim'

/**
 * Оточення прогону `T028`.
 *
 * Прогін не запускається сам собою: без повного оточення набір тестів
 * **пропускається з названою причиною**, а не падає. Причина в тому, що
 * `pnpm gate` має лишатися зеленим на машині без ключів і без мережі, а
 * мовчазний пропуск — це той самий зелений колір, що й вимір, тільки без виміру.
 *
 * Ключі беруться тільки з файлів поза репозиторієм: перевірки на це живуть у
 * `merchant-sim` (`config.ts`, `keypair.ts`) і тут не дублюються.
 */

/**
 * Нижня межа з самих критеріїв: `SC-001` і `SC-004` вимагають **≥200** спроб.
 * Менше не приймається навіть на прохання — прогін на п'яти спробах дав би
 * зелений рядок у таблиці M1, за яким не стоїть нічого.
 */
export const MIN_ATTEMPTS = 200

/** За замовчуванням даємо втричі більше надсилань, ніж потрібно спроб. */
const SENDS_PER_ATTEMPT = 3

/** Пауза між надсиланнями. Публічний devnet-вузол віддає 429 без неї. */
const DEFAULT_DELAY_MS = 250

export type E2eConfig = {
  merchant: MerchantSimConfig
  /** Дозвіл, за яким іде прогін. */
  allowancePda: string
  /** Скільки розсуджених спроб потрібно набрати. */
  attempts: number
  /** Стеля надсилань — рятує від нескінченного циклу на rate limit. */
  maxSends: number
  delayMs: number
  /**
   * Ключ **власника** дозволу. Відкликання підписує власник, не мерчант, тож
   * без цього ключа стенд відкликати не може: тоді дозвіл відкликають руками в
   * гаманці, а стенд лише звіряє, що акаунта в мережі вже немає.
   */
  ownerKeypairPath: string | null
  /** Сума однієї спроби в базових одиницях. */
  chargeAmount: bigint
}

export type E2eSetup = { ready: true; config: E2eConfig } | { ready: false; reason: string }

function positiveBigInt(raw: string, name: string): bigint {
  if (!/^\d+$/.test(raw))
    throw new Error(`${name} must be a whole number of base units, got "${raw}"`)
  const value = BigInt(raw)
  if (value <= 0n) throw new Error(`${name} must be positive, got ${value}`)
  return value
}

function positiveInt(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, got "${raw}"`)
  return Number(raw)
}

/**
 * Читання оточення. Помилка налаштування перетворюється на причину пропуску, а
 * не на червоний тест: не налаштований прогін — це не зламаний прогін.
 */
export function e2eConfigFromEnv(env: Record<string, string | undefined>): E2eSetup {
  const allowancePda = env.E2E_ALLOWANCE_PDA
  if (allowancePda === undefined || allowancePda === '') {
    return {
      ready: false,
      reason:
        'E2E_ALLOWANCE_PDA is not set. The run needs one live allowance on devnet that the ' +
        'merchant key may pull from; without it there is nothing to measure SC-001 against',
    }
  }

  let merchant: MerchantSimConfig
  try {
    merchant = merchantSimConfigFromEnv(env)
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return { ready: false, reason: detail }
  }

  const rawAmount = env.E2E_CHARGE_AMOUNT
  if (rawAmount === undefined || rawAmount === '') {
    return {
      ready: false,
      reason:
        'E2E_CHARGE_AMOUNT is not set. There is no sensible default: the amount is in base units ' +
        'of the mint, and a guessed one would be rejected for the wrong reason',
    }
  }

  try {
    const attempts =
      env.E2E_ATTEMPTS === undefined ? MIN_ATTEMPTS : positiveInt(env.E2E_ATTEMPTS, 'E2E_ATTEMPTS')
    if (attempts < MIN_ATTEMPTS) {
      return {
        ready: false,
        reason: `E2E_ATTEMPTS is ${attempts}, but SC-001 and SC-004 are written as "0 out of at least ${MIN_ATTEMPTS}"`,
      }
    }
    const ownerKeypairPath = env.E2E_OWNER_KEYPAIR_PATH
    return {
      ready: true,
      config: {
        allowancePda,
        attempts,
        chargeAmount: positiveBigInt(rawAmount, 'E2E_CHARGE_AMOUNT'),
        delayMs:
          env.E2E_DELAY_MS === undefined
            ? DEFAULT_DELAY_MS
            : positiveInt(env.E2E_DELAY_MS, 'E2E_DELAY_MS'),
        maxSends:
          env.E2E_MAX_SENDS === undefined
            ? attempts * SENDS_PER_ATTEMPT
            : positiveInt(env.E2E_MAX_SENDS, 'E2E_MAX_SENDS'),
        merchant,
        ownerKeypairPath:
          ownerKeypairPath === undefined || ownerKeypairPath === '' ? null : ownerKeypairPath,
      },
    }
  } catch (error) {
    return { ready: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
