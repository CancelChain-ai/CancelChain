import { buildRevokeTransaction, readAllowances, toBlockhash } from '@cancelchain/chain'
import { createMerchantSim, loadMerchantSigner } from '@cancelchain/merchant-sim'
import type { Page } from 'playwright-core'
import { CARD_SELECTOR, cardCount, launch, log, newVisit, saveResult } from './browser.js'
import { blockTimeMs, signAndSendCompiled, sleep } from './chain.js'
import { TARGET_TOTAL } from './composition.js'
import type { PerfConfig } from './config.js'
import { everyVerdict, summarize } from './stats.js'

/**
 * `SC-009`: no permission cancelled on chain stays in the active list for more
 * than 15 s after its transaction is confirmed.
 *
 * Owner's decision 2026-10-07: the cancellation comes from **elsewhere** — the
 * run signs `RevokeDelegation` as the owner in Node — while the dashboard stays
 * open in the browser. That is the hard case: a revocation made in this very tab
 * moves the list's read floor itself (`slotFloors`), and its card leaving would
 * prove only that. Here the card can leave only by the deployed path: the indexer
 * sees the transaction, the API's stream tells the page, the page re-reads.
 *
 * Only fixed and recurring permissions: revoking one closes its account, so its
 * card must leave. A cancelled subscription keeps running to the end of its paid
 * period by design (`composition.ts`).
 *
 * The zero is the moment this process saw the transaction confirmed, as the
 * criterion says; the block's own time is printed beside it. After each sample a
 * fresh read of the page must agree — a card gone only from the open tab's memory
 * would be the stream's claim, not the stored state.
 */

export const BUDGET_MS = 15_000
export const DEFAULT_SAMPLES = 20
const PAUSE_MS = 10_000
const SAMPLE_TIMEOUT_MS = 60_000

/** The page records every change of the card count with the OS clock. */
async function watchCount(page: Page): Promise<void> {
  // A string, not a function: tsx wraps named inner functions in a `__name`
  // helper the page does not have.
  await page.evaluate(`(() => {
    const history = []
    window.__counts = history
    let last = -1
    const check = () => {
      const count = document.querySelectorAll(${JSON.stringify(CARD_SELECTOR)}).length
      if (count !== last) {
        last = count
        history.push({ count, at: Date.now() })
      }
    }
    check()
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true })
  })()`)
}

/** When the count first fell to `below` or under, at or after `since`. */
async function firstDrop(page: Page, below: number, since: number): Promise<number | null> {
  return page
    .waitForFunction(
      ({ below, since }) => {
        const history = (window as unknown as { __counts: { count: number; at: number }[] })
          .__counts
        return history.find((entry) => entry.at >= since && entry.count <= below)?.at ?? false
      },
      { below, since },
      { timeout: SAMPLE_TIMEOUT_MS, polling: 250 },
    )
    .then(
      async (handle) => (await handle.jsonValue()) as number,
      () => null,
    )
}

export async function sc009(config: PerfConfig, samples = DEFAULT_SAMPLES): Promise<void> {
  const merchant = await createMerchantSim(config.merchant)
  const owner = await loadMerchantSigner(config.ownerKeypairPath)
  const { rpc } = merchant.chain

  const read = await readAllowances(merchant.chain, { owner: owner.address })
  const revocable = read.allowances.filter((item) => item.kind !== 'subscription')
  if (read.allowances.length !== TARGET_TOTAL || revocable.length < samples) {
    throw new Error(
      `the wallet holds ${read.allowances.length} permissions, ${revocable.length} revocable; ` +
        `run seed first (needs ${TARGET_TOTAL}, at least ${samples} revocable)`,
    )
  }
  // Alternate kinds so both card types leave the list.
  const recurring = revocable.filter((item) => item.kind === 'recurring')
  const fixed = revocable.filter((item) => item.kind === 'fixed')
  const picked = Array.from({ length: samples }, (_, i) => {
    const item = (i % 2 === 0 ? recurring : fixed).shift() ?? recurring.shift() ?? fixed.shift()
    if (item === undefined) throw new Error('not enough revocable permissions')
    return item
  })

  const browser = await launch(config)
  const rows: {
    pda: string
    kind: string
    signature: string
    sinceConfirmedMs: number | null
    sinceBlockMs: number | null
    afterReload: number
  }[] = []
  const consoleErrors: string[] = []
  try {
    const visit = await newVisit(browser, {
      owner: owner.address,
      expectedCards: TARGET_TOTAL,
      viewport: { width: 1280, height: 900 },
    })
    await visit.page.goto(config.appUrl)
    await visit.page
      .locator(CARD_SELECTOR)
      .nth(TARGET_TOTAL - 1)
      .waitFor({ timeout: 60_000 })
    await sleep(5_000)
    await watchCount(visit.page)

    for (const [i, allowance] of picked.entries()) {
      const before = await cardCount(visit.page)
      const sentAt = Date.now()
      const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
      const { transaction } = buildRevokeTransaction({
        allowance,
        authority: owner.address,
        lifetime: {
          blockhash: toBlockhash(lifetime.blockhash),
          lastValidBlockHeight: lifetime.lastValidBlockHeight,
        },
      })
      const landed = await signAndSendCompiled(rpc, transaction, owner, `revoke ${allowance.pda}`)
      const gone = await firstDrop(visit.page, before - 1, sentAt)
      const blockAt = await blockTimeMs(rpc, landed.slot)

      // A fresh read must agree with the open tab.
      const check = await newVisit(browser, {
        owner: owner.address,
        expectedCards: before - 1,
        viewport: { width: 1280, height: 900 },
      })
      await check.page.goto(config.appUrl)
      await check.page
        .locator(CARD_SELECTOR)
        .nth(before - 2)
        .waitFor({ timeout: 60_000 })
        .catch(() => undefined)
      await sleep(1_500)
      const afterReload = await cardCount(check.page)
      consoleErrors.push(...check.consoleErrors)
      await check.context.close()

      const row = {
        pda: allowance.pda,
        kind: allowance.kind,
        signature: landed.signature,
        // Seen before this process saw the confirmation: the stream was faster
        // than our status poll. Counted as zero, not as a negative time.
        sinceConfirmedMs: gone === null ? null : Math.max(0, gone - landed.confirmedAt),
        sinceBlockMs: gone === null ? null : gone - blockAt,
        afterReload,
      }
      rows.push(row)
      log(
        `#${String(i + 1).padStart(2)} ${row.kind.padEnd(9)} ${row.pda.slice(0, 6)}…: off the open list ` +
          `${row.sinceConfirmedMs ?? 'never'} ms after confirmation (${row.sinceBlockMs ?? '—'} ms ` +
          `after block time); fresh read ${afterReload} cards (expected ${before - 1})`,
      )
      if (i < picked.length - 1) await sleep(PAUSE_MS)
    }
    consoleErrors.push(...visit.consoleErrors)
    await visit.context.close()
  } finally {
    await browser.close()
  }

  const reloadMismatches = rows.filter((row, i) => row.afterReload !== TARGET_TOTAL - 1 - i).length
  const timing = everyVerdict(
    rows.map((row) => row.sinceConfirmedMs),
    BUDGET_MS,
  )
  const pass = timing.pass && reloadMismatches === 0
  const arrived = rows.flatMap((row) =>
    row.sinceConfirmedMs === null ? [] : [row.sinceConfirmedMs],
  )
  const result = {
    criterion: 'SC-009',
    budgetMs: BUDGET_MS,
    method:
      'dashboard open at 1280×900; the owner revokes in Node; from confirmation until the card count ' +
      'drops on the open page; then a fresh visit must show the same count',
    summary: arrived.length === 0 ? null : summarize(arrived),
    verdict: { pass, statement: `${timing.statement}; fresh-read mismatches ${reloadMismatches}` },
    console: consoleErrors,
    rows,
  }
  const path = await saveResult(config, 'sc009', result)
  log(
    `SC-009 ${pass ? 'PASS' : 'FAIL'}: ${result.verdict.statement}; console ${consoleErrors.length}`,
  )
  log(`raw → ${path}. The wallet now holds ${TARGET_TOTAL - rows.length}: run seed to top it up.`)
}
