import { loadMerchantSigner } from '@cancelchain/merchant-sim'
import {
  launch,
  log,
  newVisit,
  readMarks,
  saveResult,
  type WaterfallEntry,
  waterfall,
} from './browser.js'
import { sleep } from './chain.js'
import { TARGET_TOTAL } from './composition.js'
import type { PerfConfig } from './config.js'
import {
  LIGHTHOUSE_MOBILE,
  type NetworkProfile,
  probeFirstByte,
  startShaper,
  WPT_3G,
} from './shaper.js'
import { everyVerdict, summarize } from './stats.js'

/**
 * `SC-008`: the dashboard's first screen is drawn in under 2 s on 3G.
 *
 * Owner's decision 2026-10-07: "3G" is WebPageTest's 3G (1.6 Mbit/s down,
 * 768 kbit/s up, 300 ms round trip) on a packet-level shaper, a 4× slower CPU,
 * a phone viewport and an empty cache. "First screen" is the first card **with its
 * data** inside the viewport for a returning wallet — not a skeleton and not the
 * connect prompt, which is not the dashboard. Every sample must make it: the
 * budget is promised to each visit.
 *
 * Lighthouse's mobile profile (the old "Fast 3G", half the latency) is measured
 * alongside as a reference and does not decide anything.
 */

export const BUDGET_MS = 2_000
export const DEFAULT_SAMPLES = 10
const REFERENCE_SAMPLES = 5
const CPU_SLOWDOWN = 4
const PAUSE_MS = 8_000
const SAMPLE_TIMEOUT_MS = 60_000

type Row = {
  firstScreen: number | null
  firstContentfulPaint: number | null
  downBytes: number
  upBytes: number
  waterfall: WaterfallEntry[]
  console: string[]
  /** Navigations that failed on the network before this sample — each with the shaper's log. */
  failedTries: string[]
}

/** One retry after a network failure of the navigation itself; a second one ends the run. */
const TRIES = 2

async function runProfile(
  config: PerfConfig,
  owner: string,
  profile: NetworkProfile,
  samples: number,
): Promise<{ control: number; rows: Row[] }> {
  const shaper = await startShaper(profile)
  const rows: Row[] = []
  try {
    const control = await probeFirstByte(shaper, config.appUrl)
    log(
      `${profile.name}: control first byte ${control} ms (model ≥ ${4 * profile.rttMs} ms + the real network)`,
    )
    for (let i = 0; i < samples; i += 1) {
      const failedTries: string[] = []
      for (let attempt = 1; ; attempt += 1) {
        shaper.reset()
        // A browser per sample: Chrome keeps proxy tunnels per browser, and a reused
        // tunnel would hand the next "first visit" a connection it never paid for.
        const browser = await launch(config, { proxyPort: shaper.port })
        try {
          const visit = await newVisit(browser, {
            owner,
            expectedCards: TARGET_TOTAL,
            viewport: { width: 375, height: 812 },
            mobile: true,
            cpuSlowdown: CPU_SLOWDOWN,
          })
          const opened = await visit.page.goto(config.appUrl, { timeout: SAMPLE_TIMEOUT_MS }).then(
            () => null,
            (error: unknown) =>
              error instanceof Error ? error.message.split('\n')[0] : String(error),
          )
          if (opened !== null) {
            const why = `${opened}; shaper: ${shaper.errors().join(' | ') || 'no socket error'}`
            log(`${profile.name} #${i + 1} try ${attempt}: navigation failed — ${why}`)
            failedTries.push(why)
            if (attempt >= TRIES) throw new Error(`sample #${i + 1} failed ${TRIES} times: ${why}`)
            continue
          }
          await visit.page
            .waitForFunction(
              () =>
                (window as unknown as { __perfMarks: { firstCardVisible: number | null } })
                  .__perfMarks.firstCardVisible !== null,
              undefined,
              { timeout: SAMPLE_TIMEOUT_MS, polling: 200 },
            )
            .catch(() => undefined)
          const marks = await readMarks(visit.page)
          const bytes = shaper.bytes()
          const row: Row = {
            firstScreen:
              marks.firstCardVisible === null ? null : Math.round(marks.firstCardVisible),
            firstContentfulPaint:
              marks.firstContentfulPaint === null ? null : Math.round(marks.firstContentfulPaint),
            downBytes: bytes.down,
            upBytes: bytes.up,
            waterfall: await waterfall(visit.page),
            console: visit.consoleErrors,
            failedTries,
          }
          rows.push(row)
          log(
            `${profile.name} #${i + 1}: first screen ${row.firstScreen ?? '—'} ms, FCP ` +
              `${row.firstContentfulPaint ?? '—'} ms, ↓${Math.round(row.downBytes / 1024)} KiB ` +
              `↑${Math.round(row.upBytes / 1024)} KiB, console ${row.console.length}`,
          )
          break
        } finally {
          await browser.close()
        }
      }
      if (i < samples - 1) await sleep(PAUSE_MS)
    }
    return { control, rows }
  } finally {
    await shaper.close()
  }
}

export async function sc008(config: PerfConfig, samples = DEFAULT_SAMPLES): Promise<void> {
  const owner = (await loadMerchantSigner(config.ownerKeypairPath)).address
  const measured = await runProfile(config, owner, WPT_3G, samples)
  const reference = await runProfile(config, owner, LIGHTHOUSE_MOBILE, REFERENCE_SAMPLES)

  const firstScreens = (rows: Row[]) => rows.map((row) => row.firstScreen)
  const arrived = (rows: Row[]) =>
    rows.flatMap((row) => (row.firstScreen === null ? [] : [row.firstScreen]))
  const verdict = everyVerdict(firstScreens(measured.rows), BUDGET_MS)
  const result = {
    criterion: 'SC-008',
    budgetMs: BUDGET_MS,
    method:
      'packet-level CONNECT shaper, fresh browser per sample, 375×812 mobile, CPU ×4, empty cache, ' +
      'until the first card with data is inside the viewport',
    appUrl: config.appUrl,
    profile: WPT_3G,
    control: measured.control,
    summary: arrived(measured.rows).length === 0 ? null : summarize(arrived(measured.rows)),
    verdict,
    rows: measured.rows,
    reference: {
      profile: LIGHTHOUSE_MOBILE,
      control: reference.control,
      summary: arrived(reference.rows).length === 0 ? null : summarize(arrived(reference.rows)),
      verdict: everyVerdict(firstScreens(reference.rows), BUDGET_MS),
      rows: reference.rows,
    },
  }
  const path = await saveResult(config, 'sc008', result)
  log(`SC-008 ${verdict.pass ? 'PASS' : 'FAIL'} on ${WPT_3G.name}: ${verdict.statement}`)
  log(`reference ${LIGHTHOUSE_MOBILE.name}: ${result.reference.verdict.statement}; raw → ${path}`)
}
