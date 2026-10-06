import { loadMerchantSigner } from '@cancelchain/merchant-sim'
import { launch, listFetchMs, log, newVisit, readMarks, saveResult } from './browser.js'
import { sleep } from './chain.js'
import { TARGET_TOTAL } from './composition.js'
import type { PerfConfig } from './config.js'
import { p95Verdict, summarize } from './stats.js'

/**
 * `SC-003`: the list of a wallet with 100 permissions is fully on screen in under
 * 3 s at the 95th percentile.
 *
 * One sample is one first visit: a fresh browser context (empty cache), the
 * deployed site, the owner's wallet remembered from before. It ends when the 100th
 * card is in the document — "fully", not the first screenful. Desktop width, the
 * network as it is from here: the slow-network promise is `SC-008`'s.
 */

export const BUDGET_MS = 3_000
export const DEFAULT_SAMPLES = 40

/**
 * Between samples. Back-to-back visits would be one client's burst against the
 * API and its database, and the run would time its own queue.
 */
const PAUSE_MS = 8_000

const SAMPLE_TIMEOUT_MS = 30_000

export async function sc003(config: PerfConfig, samples = DEFAULT_SAMPLES): Promise<void> {
  const owner = await loadMerchantSigner(config.ownerKeypairPath)
  const browser = await launch(config)
  const rows: {
    full: number | null
    firstCard: number | null
    listFetch: number | null
    cards: number
    console: string[]
  }[] = []
  try {
    for (let i = 0; i < samples; i += 1) {
      const visit = await newVisit(browser, {
        owner: owner.address,
        expectedCards: TARGET_TOTAL,
        viewport: { width: 1280, height: 900 },
      })
      await visit.page.goto(config.appUrl)
      await visit.page
        .waitForFunction(
          () =>
            (window as unknown as { __perfMarks: { full: number | null } }).__perfMarks.full !==
            null,
          undefined,
          { timeout: SAMPLE_TIMEOUT_MS, polling: 200 },
        )
        .catch(() => undefined)
      const marks = await readMarks(visit.page)
      const row = {
        full: marks.full === null ? null : Math.round(marks.full),
        firstCard: marks.firstCardVisible === null ? null : Math.round(marks.firstCardVisible),
        listFetch: await listFetchMs(visit.page),
        cards: marks.maxCards,
        console: visit.consoleErrors,
      }
      rows.push(row)
      log(
        `#${String(i + 1).padStart(2)} full ${row.full ?? '—'} ms, first card ${row.firstCard ?? '—'} ms, ` +
          `list request ${row.listFetch ?? '—'} ms, cards ${row.cards}, console ${row.console.length}`,
      )
      await visit.context.close()
      if (i < samples - 1) await sleep(PAUSE_MS)
    }
  } finally {
    await browser.close()
  }

  // A visit that never showed all 100 is a sample over budget, not a missing one.
  const values = rows.map((row) => row.full ?? Number.POSITIVE_INFINITY)
  const verdict = p95Verdict(values, BUDGET_MS)
  const arrived = rows.flatMap((row) => (row.full === null ? [] : [row.full]))
  const result = {
    criterion: 'SC-003',
    budgetMs: BUDGET_MS,
    method: 'fresh context per sample, 1280×900, no throttling, until the 100th card is in the DOM',
    appUrl: config.appUrl,
    summary: arrived.length === 0 ? null : summarize(arrived),
    incomplete: rows.length - arrived.length,
    verdict,
    rows,
  }
  const path = await saveResult(config, 'sc003', result)
  log(`SC-003 ${verdict.pass ? 'PASS' : 'FAIL'}: ${verdict.statement}`)
  log(`summary ${JSON.stringify(result.summary)}; raw → ${path}`)
}
