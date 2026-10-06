import { readAllowances, toAddress } from '@cancelchain/chain'
import {
  attemptCharge,
  chargeTargetFromAllowance,
  createMerchantSim,
  loadMerchantSigner,
  resolveTokenProgram,
} from '@cancelchain/merchant-sim'
import { shortenAddress } from '@cancelchain/shared'
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token'
import { launch, log, newVisit, saveResult } from './browser.js'
import { blockTimeMs, sendAndConfirm, sleep } from './chain.js'
import type { PerfConfig } from './config.js'
import { everyVerdict, summarize } from './stats.js'

/**
 * `SC-006`: a rejected charge attempt is in the user's feed in under 30 s.
 *
 * The card of one recurring permission stays open, as a person watching it would
 * keep it. `merchant-sim` then tries to pull one unit more than the cap — the
 * protocol refuses — and the sample ends when that transaction's signature is on
 * the screen. The path measured is the deployed one end to end: chain → the
 * indexer on Render → Postgres `NOTIFY` → the API's stream → the open page.
 *
 * Two clocks, one verdict. The decisive number starts when the attempt is sent:
 * the attempt cannot have executed before that, so it never flatters — it is the
 * criterion's interval plus the send itself. The block's own time is printed next
 * to it; it is the criterion's zero exactly, but in whole seconds and on the
 * cluster's clock, not ours.
 */

export const BUDGET_MS = 30_000
export const DEFAULT_SAMPLES = 20
const PAUSE_MS = 10_000
const SAMPLE_TIMEOUT_MS = 90_000

export async function sc006(config: PerfConfig, samples = DEFAULT_SAMPLES): Promise<void> {
  const merchant = await createMerchantSim(config.merchant)
  const owner = await loadMerchantSigner(config.ownerKeypairPath)
  const { rpc } = merchant.chain
  const mint = toAddress(config.merchant.chain.usdcMint)
  const tokenProgram = await resolveTokenProgram(rpc, mint)

  // The merchant's account to credit has to exist, or the refusal would be
  // "no account to pay into" instead of the protocol's cap.
  await sendAndConfirm(
    rpc,
    merchant.signer,
    [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        mint,
        owner: merchant.address,
        payer: merchant.signer,
      }),
    ],
    'merchant token account',
  )

  const read = await readAllowances(merchant.chain, { owner: owner.address })
  const allowance = read.allowances.find(
    (item) => item.kind === 'recurring' && item.delegate === merchant.address,
  )
  if (allowance === undefined) throw new Error('no recurring permission to the merchant: run seed')
  const target = chargeTargetFromAllowance(allowance)
  const amount = BigInt(allowance.capAmount) + 1n
  log(`card ${allowance.pda}, cap ${allowance.capAmount}, trying ${amount}`)

  const browser = await launch(config)
  const rows: {
    signature: string
    sinceSendMs: number | null
    sinceBlockMs: number | null
    programErrorCode: number | null
  }[] = []
  let consoleErrors: string[] = []
  try {
    const visit = await newVisit(browser, {
      owner: owner.address,
      expectedCards: 1,
      viewport: { width: 1280, height: 900 },
    })
    consoleErrors = visit.consoleErrors
    await visit.page.goto(`${config.appUrl}?allowance=${allowance.pda}`)
    await visit.page.getByText('Activity', { exact: true }).waitFor({ timeout: 60_000 })
    // Let the stream open before the first attempt: a page still connecting
    // would be timed for its own start-up.
    await sleep(5_000)
    // The page notes when each shortened signature first appears. Waiting for
    // the one we sent only after `attemptCharge` returns would start the watch
    // late — that call polls the network on its own schedule. A string, not a
    // function: tsx wraps named inner functions in a `__name` helper the page
    // does not have.
    await visit.page.evaluate(`(() => {
      const firstSeen = {}
      window.__firstSeen = firstSeen
      const scan = () => {
        for (const match of document.body.innerText.matchAll(/[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}/g)) {
          firstSeen[match[0]] ??= Date.now()
        }
      }
      scan()
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true })
    })()`)

    for (let i = 0; i < samples; i += 1) {
      const sentAt = Date.now()
      const verdict = await attemptCharge(rpc, {
        allowance: target,
        amount,
        merchant: merchant.signer,
        tokenProgram,
      })
      if (verdict.outcome !== 'rejected') {
        throw new Error(`attempt #${i + 1} was not refused by the network: ${verdict.outcome}`)
      }
      const short = shortenAddress(verdict.signature)
      const seen = await visit.page
        .waitForFunction(
          (text) =>
            (window as unknown as { __firstSeen: Record<string, number> }).__firstSeen[text] ??
            false,
          short,
          { timeout: SAMPLE_TIMEOUT_MS, polling: 250 },
        )
        .then(
          async (handle) => (await handle.jsonValue()) as number,
          () => null,
        )
      const blockAt = await blockTimeMs(rpc, verdict.slot)
      const row = {
        signature: verdict.signature,
        sinceSendMs: seen === null ? null : seen - sentAt,
        sinceBlockMs: seen === null ? null : seen - blockAt,
        programErrorCode: verdict.programErrorCode,
      }
      rows.push(row)
      log(
        `#${String(i + 1).padStart(2)} ${short} code ${row.programErrorCode ?? '—'}: on screen ` +
          `${row.sinceSendMs ?? 'never'} ms after send, ${row.sinceBlockMs ?? '—'} ms after block time`,
      )
      if (i < samples - 1) await sleep(PAUSE_MS)
    }
    await visit.context.close()
  } finally {
    await browser.close()
  }

  const verdict = everyVerdict(
    rows.map((row) => row.sinceSendMs),
    BUDGET_MS,
  )
  const arrived = rows.flatMap((row) => (row.sinceSendMs === null ? [] : [row.sinceSendMs]))
  const result = {
    criterion: 'SC-006',
    budgetMs: BUDGET_MS,
    method:
      'card open at 1280×900; merchant-sim pulls cap + 1; from send until the signature is on screen',
    allowance: allowance.pda,
    summary: arrived.length === 0 ? null : summarize(arrived),
    verdict,
    console: consoleErrors,
    rows,
  }
  const path = await saveResult(config, 'sc006', result)
  log(
    `SC-006 ${verdict.pass ? 'PASS' : 'FAIL'}: ${verdict.statement}; console ${consoleErrors.length}`,
  )
  log(`raw → ${path}`)
}
