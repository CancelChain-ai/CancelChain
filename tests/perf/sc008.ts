import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMerchantSigner } from '@cancelchain/merchant-sim'
import {
  log,
  profileVisit,
  readMarks,
  saveResult,
  type Visit,
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
 * 768 kbit/s up, 300 ms round trip) on a packet-level shaper, a 4× slower CPU
 * and a phone viewport. "First screen" is the first card **with its data**
 * inside the viewport for a returning wallet — not a skeleton and not the
 * connect prompt, which is not the dashboard. Every sample must make it: the
 * budget is promised to each visit.
 *
 * Owner's decision 2026-10-07 after the first run (`T057`): the verdict is the
 * **returning** visit — the app from the service worker's cache, the list from
 * the copy this browser saved, the network re-read behind it. Each sample is a
 * fresh profile: a cold first visit (reported on its own, empty cache), then
 * Chrome is closed and relaunched on the same profile, so the second visit keeps
 * what a returning visitor keeps and no open connection.
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
/** `apps/web/public/sw.js` and `apps/web/src/lib/storedList.ts`. */
const SHELL_CACHE = 'cancelchain-shell-v1'
const STORED_LIST_PREFIX = 'cancelchain:allowances:'

type Shaper = Awaited<ReturnType<typeof startShaper>>

type Row = {
  firstScreen: number | null
  firstContentfulPaint: number | null
  downBytes: number
  upBytes: number
  waterfall: WaterfallEntry[]
  console: string[]
}

type Sample = {
  cold: Row
  warm: Row
  /** Tries that failed on the network before this sample — each with the shaper's log. */
  failedTries: string[]
}

/** One retry after a network failure of a navigation; a second one ends the run. */
const TRIES = 2

class NavigationFailed extends Error {}

async function visitAndMeasure(visit: Visit, shaper: Shaper, url: string): Promise<Row> {
  shaper.reset()
  const opened = await visit.page.goto(url, { timeout: SAMPLE_TIMEOUT_MS }).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message.split('\n')[0] : String(error)),
  )
  if (opened !== null) {
    throw new NavigationFailed(
      `${opened}; shaper: ${shaper.errors().join(' | ') || 'no socket error'}`,
    )
  }
  await visit.page
    .waitForFunction(
      () =>
        (window as unknown as { __perfMarks: { firstCardVisible: number | null } }).__perfMarks
          .firstCardVisible !== null,
      undefined,
      { timeout: SAMPLE_TIMEOUT_MS, polling: 200 },
    )
    .catch(() => undefined)
  const marks = await readMarks(visit.page)
  const bytes = shaper.bytes()
  return {
    firstScreen: marks.firstCardVisible === null ? null : Math.round(marks.firstCardVisible),
    firstContentfulPaint:
      marks.firstContentfulPaint === null ? null : Math.round(marks.firstContentfulPaint),
    downBytes: bytes.down,
    upBytes: bytes.up,
    waterfall: await waterfall(visit.page),
    console: [...visit.consoleErrors],
  }
}

/**
 * The cold visit leaves what the warm one is to be measured with: a worker in
 * control with the app in its cache, and the list saved. A warm sample without
 * them would measure a second cold visit and call it warm.
 */
async function waitForReturnReady(visit: Visit, owner: string): Promise<void> {
  await visit.page.waitForFunction(
    (key) => navigator.serviceWorker.controller !== null && localStorage.getItem(key) !== null,
    `${STORED_LIST_PREFIX}${owner}`,
    { timeout: SAMPLE_TIMEOUT_MS, polling: 500 },
  )
  const cached = await visit.page.evaluate(
    async (name) => (await (await caches.open(name)).keys()).map((request) => request.url),
    SHELL_CACHE,
  )
  if (!cached.some((url) => url.includes('/assets/'))) {
    throw new Error(`the worker controls the page but its cache holds only ${cached.join(', ')}`)
  }
}

async function runProfile(
  config: PerfConfig,
  owner: string,
  profile: NetworkProfile,
  samples: number,
): Promise<{ control: number; samples: Sample[] }> {
  const shaper = await startShaper(profile)
  const done: Sample[] = []
  const options = {
    owner,
    expectedCards: TARGET_TOTAL,
    viewport: { width: 375, height: 812 },
    mobile: true,
    cpuSlowdown: CPU_SLOWDOWN,
    proxyPort: shaper.port,
  }
  try {
    const control = await probeFirstByte(shaper, config.appUrl)
    log(
      `${profile.name}: control first byte ${control} ms (model ≥ ${4 * profile.rttMs} ms + the real network)`,
    )
    for (let i = 0; i < samples; i += 1) {
      const failedTries: string[] = []
      for (let attempt = 1; ; attempt += 1) {
        const dir = await mkdtemp(join(tmpdir(), 'cancelchain-sc008-'))
        try {
          const first = await profileVisit(config, dir, options)
          let cold: Row
          try {
            cold = await visitAndMeasure(first, shaper, config.appUrl)
            await waitForReturnReady(first, owner)
          } finally {
            await first.context.close()
          }
          const again = await profileVisit(config, dir, options)
          let warm: Row
          try {
            warm = await visitAndMeasure(again, shaper, config.appUrl)
          } finally {
            await again.context.close()
          }
          done.push({ cold, warm, failedTries })
          log(
            `${profile.name} #${i + 1}: returning ${warm.firstScreen ?? '—'} ms ` +
              `(FCP ${warm.firstContentfulPaint ?? '—'} ms, ↓${Math.round(warm.downBytes / 1024)} KiB), ` +
              `cold ${cold.firstScreen ?? '—'} ms (↓${Math.round(cold.downBytes / 1024)} KiB), ` +
              `console ${cold.console.length}+${warm.console.length}`,
          )
          break
        } catch (error) {
          if (!(error instanceof NavigationFailed)) throw error
          log(`${profile.name} #${i + 1} try ${attempt}: navigation failed — ${error.message}`)
          failedTries.push(error.message)
          if (attempt >= TRIES) {
            throw new Error(`sample #${i + 1} failed ${TRIES} times: ${error.message}`)
          }
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      }
      if (i < samples - 1) await sleep(PAUSE_MS)
    }
    return { control, samples: done }
  } finally {
    await shaper.close()
  }
}

function report(samples: Sample[], visit: 'warm' | 'cold') {
  const firstScreens = samples.map((sample) => sample[visit].firstScreen)
  const arrived = firstScreens.filter((value): value is number => value !== null)
  return {
    summary: arrived.length === 0 ? null : summarize(arrived),
    verdict: everyVerdict(firstScreens, BUDGET_MS),
  }
}

export async function sc008(config: PerfConfig, samples = DEFAULT_SAMPLES): Promise<void> {
  const owner = (await loadMerchantSigner(config.ownerKeypairPath)).address
  const measured = await runProfile(config, owner, WPT_3G, samples)
  const reference = await runProfile(config, owner, LIGHTHOUSE_MOBILE, REFERENCE_SAMPLES)

  const returning = report(measured.samples, 'warm')
  const cold = report(measured.samples, 'cold')
  const result = {
    criterion: 'SC-008',
    budgetMs: BUDGET_MS,
    method:
      'packet-level CONNECT shaper, 375×812 mobile, CPU ×4, until the first card with data is ' +
      'inside the viewport; per sample a fresh profile: a cold visit, then Chrome relaunched on ' +
      'the same profile for the returning visit (the verdict)',
    appUrl: config.appUrl,
    profile: WPT_3G,
    control: measured.control,
    ...returning,
    cold,
    samples: measured.samples,
    reference: {
      profile: LIGHTHOUSE_MOBILE,
      control: reference.control,
      returning: report(reference.samples, 'warm'),
      cold: report(reference.samples, 'cold'),
      samples: reference.samples,
    },
  }
  const path = await saveResult(config, 'sc008', result)
  log(
    `SC-008 ${returning.verdict.pass ? 'PASS' : 'FAIL'} on ${WPT_3G.name}, returning visit: ` +
      `${returning.verdict.statement}`,
  )
  log(`cold first visit (reported, not the verdict): ${cold.verdict.statement}`)
  log(
    `reference ${LIGHTHOUSE_MOBILE.name}: returning ${result.reference.returning.verdict.statement}; ` +
      `cold ${result.reference.cold.verdict.statement}; raw → ${path}`,
  )
}
