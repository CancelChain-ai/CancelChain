import {
  buildRevokeTransaction,
  type ReadAllowance,
  readAllowance,
  toAddress,
  toBlockhash,
} from '@cancelchain/chain'
import {
  chargeTargetFromAllowance,
  createMerchantSim,
  loadMerchantSigner,
  type MerchantSim,
  resolveTokenProgram,
} from '@cancelchain/merchant-sim'
import type { Address } from '@solana/kit'
import { getBase64EncodedWireTransaction, signTransaction } from '@solana/kit'
import {
  SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_LIMIT,
  SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT,
} from '@solana/subscriptions'
import { beforeAll, describe, expect, it } from 'vitest'
import { describeTally, runCampaign } from './campaign.js'
import { e2eConfigFromEnv } from './config.js'

/**
 * `T028` — прогін на devnet: `SC-001` (після скасування 0 успішних списань на
 * ≥200 спроб) і `SC-004` (0 перевищень стелі за період на ≥200 спроб).
 *
 * ⚠️ **Два тести нижче залежать один від одного за станом мережі.** `SC-004`
 * міряє живий дозвіл, `SC-001` — той самий дозвіл після скасування, і порядок
 * зворотним бути не може: скасований дозвіл — це зниклий акаунт, у якого вже
 * немає ані стелі, ані періоду. Тому це один сценарій у двох кроках, а не два
 * незалежні тести, і саме тому вони живуть у `*.spec.ts`, а не в `*.test.ts`.
 *
 * ⚠️ **Прогін витрачає справжні devnet-кошти й пише в мережу.** Без повного
 * оточення він **пропускається з названою причиною** — див. `config.ts`.
 */

const setup = e2eConfigFromEnv(process.env)
const configured = setup.ready

/** 45 хвилин: 200 спроб × (пауза + підтвердження) на публічному вузлі. */
const CAMPAIGN_TIMEOUT_MS = 45 * 60_000

/**
 * Коди, якими програма відмовляє саме через стелю. Беруться з SDK, а не
 * переписуються числами: `SC-004` доводиться тільки тоді, коли відмова прийшла
 * **за стелю**. Двісті відмов через відсутній токен-акаунт виглядали б так
 * само зелено й не міряли б нічого.
 */
const CAP_ERROR_CODES = new Set([
  String(SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_LIMIT),
  String(SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT),
])

it('оточення прогону або повне, або причина названа', () => {
  // Єдиний тест, що виконується завжди: мовчазний пропуск і зелений вимір у
  // звіті виглядають однаково, тож причина має бути надрукована.
  if (!setup.ready) {
    process.stdout.write(`T028 skipped — ${setup.reason}\n`)
  }
  expect(setup.ready || setup.reason.length > 0).toBe(true)
})

describe.skipIf(!configured)('T028 — SC-001 і SC-004 на devnet', () => {
  let merchant: MerchantSim
  let allowance: ReadAllowance
  let tokenProgram: Address

  async function readTarget(): Promise<ReadAllowance | null> {
    if (!setup.ready) throw new Error('unreachable: the suite is skipped without a config')
    const { allowance: found } = await readAllowance(merchant.chain, {
      pda: toAddress(setup.config.allowancePda),
    })
    return found
  }

  beforeAll(async () => {
    if (!setup.ready) return
    merchant = await createMerchantSim(setup.config.merchant)
    const found = await readTarget()
    if (found === null) {
      throw new Error(
        `allowance ${setup.config.allowancePda} does not exist on ${merchant.cluster}. ` +
          'SC-004 needs a live allowance: it measures the ceiling, and a closed account has none',
      )
    }
    allowance = found
    tokenProgram = await resolveTokenProgram(merchant.chain.rpc, toAddress(allowance.mint))
    process.stdout.write(
      [
        `allowance:    ${allowance.pda}`,
        `kind:         ${allowance.kind}`,
        `owner:        ${allowance.owner}`,
        `cap / spent:  ${allowance.capAmount} / ${allowance.spentInPeriod}`,
        `merchant:     ${merchant.address}`,
        '',
      ].join('\n'),
    )
  }, 120_000)

  it(
    'SC-004: понад стелю — 0 перевищень на ≥200 спроб',
    async () => {
      if (!setup.ready) return
      const { config } = setup
      /*
       * Рівно на одну базову одиницю більше, ніж лишилося. Не «величезна сума»:
       * вимірюється **межа**, а не здоровий глузд програми, і надлишок у мільйон
       * відхилявся б навіть при зламаній перевірці межі.
       *
       * Для `fixed` «витрачено» мережа не зберігає (`decode.ts`), тож там
       * `capAmount` — це і є залишок.
       */
      const remaining =
        allowance.kind === 'fixed'
          ? BigInt(allowance.capAmount)
          : BigInt(allowance.capAmount) - BigInt(allowance.spentInPeriod)
      const overCap = remaining + 1n

      const tally = await runCampaign(
        merchant.chain.rpc,
        {
          allowance: chargeTargetFromAllowance(allowance),
          amount: overCap,
          merchant: merchant.signer,
          tokenProgram,
        },
        {
          attempts: config.attempts,
          delayMs: config.delayMs,
          maxSends: config.maxSends,
          stopOnCharge: true,
        },
      )
      process.stdout.write(
        `SC-004 (over cap by 1, amount ${overCap}):\n${describeTally(tally)}\n\n`,
      )

      expect(tally.charged, `successful charges over the ceiling: ${tally.chargedSignatures}`).toBe(
        0,
      )
      expect(tally.judged, 'attempts the network actually judged').toBeGreaterThanOrEqual(
        config.attempts,
      )
      /*
       * Відмова мусить бути **за стелю**. Інакше прогін зелений, а `SC-004` не
       * виміряний: двісті відмов через відсутній ATA дають той самий нуль.
       */
      const capRejections = Object.entries(tally.codes)
        .filter(([code]) => CAP_ERROR_CODES.has(code))
        .reduce((sum, [, count]) => sum + count, 0)
      expect(
        capRejections,
        `rejections carrying a ceiling error code; observed codes: ${JSON.stringify(tally.codes)}`,
      ).toBe(tally.rejected)

      const after = await readTarget()
      expect(after, 'the allowance must still exist after the over-cap run').not.toBeNull()
      if (after === null) return
      expect(BigInt(after.spentInPeriod)).toBeLessThanOrEqual(BigInt(after.capAmount))
      expect(after.spentInPeriod).toBe(allowance.spentInPeriod)
    },
    CAMPAIGN_TIMEOUT_MS,
  )

  it(
    'SC-001: після скасування — 0 успішних на ≥200 спроб',
    async () => {
      if (!setup.ready) return
      const { config } = setup

      if (config.ownerKeypairPath === null) {
        /*
         * Ключа власника немає — відкликати мусить людина у своєму гаманці.
         * Прогін тоді не «пропускається»: він вимагає, щоб акаунта вже не було,
         * і каже це прямо. Підміняти скасування чимось іншим не можна — саме
         * воно і є предметом виміру.
         */
        const before = await readTarget()
        expect(
          before,
          'E2E_OWNER_KEYPAIR_PATH is not set, so revoke this allowance in the wallet first ' +
            '(the owner signs a revocation, never the merchant), then run this again',
        ).toBeNull()
      } else {
        await revokeWithOwnerKey(config.ownerKeypairPath)
      }

      const gone = await readTarget()
      expect(gone, 'the allowance account must be closed before SC-001 is measured').toBeNull()

      const tally = await runCampaign(
        merchant.chain.rpc,
        {
          allowance: chargeTargetFromAllowance(allowance),
          amount: config.chargeAmount,
          merchant: merchant.signer,
          tokenProgram,
        },
        {
          attempts: config.attempts,
          delayMs: config.delayMs,
          maxSends: config.maxSends,
          stopOnCharge: true,
        },
      )
      process.stdout.write(`SC-001 (after revocation):\n${describeTally(tally)}\n\n`)

      expect(tally.charged, `successful charges after revocation: ${tally.chargedSignatures}`).toBe(
        0,
      )
      expect(tally.judged, 'attempts the network actually judged').toBeGreaterThanOrEqual(
        config.attempts,
      )
    },
    CAMPAIGN_TIMEOUT_MS,
  )

  /**
   * Скасування підписує **власник** дозволу, ніколи не мерчант: `revokeDelegation`
   * перевіряє authority, і ключ мерчанта тут не підійшов би за побудовою.
   */
  async function revokeWithOwnerKey(keypairPath: string): Promise<void> {
    const owner = await loadMerchantSigner(keypairPath)
    if (owner.address !== allowance.owner) {
      throw new Error(
        `E2E_OWNER_KEYPAIR_PATH holds ${owner.address}, but allowance ${allowance.pda} belongs ` +
          `to ${allowance.owner}; the program would reject the revocation as unauthorised`,
      )
    }
    const { value } = await merchant.chain.rpc
      .getLatestBlockhash({ commitment: 'confirmed' })
      .send()
    const revoke = buildRevokeTransaction({
      allowance,
      authority: owner.address,
      lifetime: {
        blockhash: toBlockhash(value.blockhash),
        lastValidBlockHeight: value.lastValidBlockHeight,
      },
    })
    const signed = await signTransaction([owner.keyPair], revoke.transaction)
    await merchant.chain.rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
      })
      .send()

    // Підтвердження — зниклий акаунт, а не повернутий підпис (`T026`).
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      if ((await readTarget()) === null) return
    }
    throw new Error(
      `revocation was sent but allowance ${allowance.pda} is still on the network after 30s; ` +
        'SC-001 measures charges after a revocation, so it must not run on an unrevoked account',
    )
  }
})
