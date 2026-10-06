import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core'

export { log } from './chain.js'

import type { PerfConfig } from './config.js'
import { stubWalletScript } from './wallet.js'

/**
 * The browser side of the runs: real Chrome on the deployed site, a stub wallet
 * that only knows the owner's address, and marks the page itself records.
 *
 * Times are the page's own `performance.now()`, whose zero is the navigation's
 * start — the moment a person opens the dashboard. A mark set by a polling loop
 * in Node would add the loop's own interval to every sample.
 */

/**
 * A card in the list (`AllowanceCard` inside the `Subscriptions` grid). Markup is
 * the only handle: the cards carry no test id, and adding one would mean measuring
 * a build that differs from the one people get.
 */
export const CARD_SELECTOR = 'div.grid > div.overflow-hidden'

export type PageMarks = {
  /** First card on screen, inside the viewport — the dashboard's first screen. */
  firstCardVisible: number | null
  /** The card count first reached `expected`. */
  full: number | null
  /** The highest card count seen. */
  maxCards: number
  firstContentfulPaint: number | null
}

/** Installs the observer before any app script runs. `expected` is the full list's size. */
export function marksScript(expected: number): string {
  return `(() => {
  const marks = { firstCardVisible: null, full: null, maxCards: 0, firstContentfulPaint: null }
  window.__perfMarks = marks
  const check = () => {
    const cards = document.querySelectorAll(${JSON.stringify(CARD_SELECTOR)})
    if (cards.length > marks.maxCards) marks.maxCards = cards.length
    if (marks.firstCardVisible === null && cards.length > 0 &&
        cards[0].getBoundingClientRect().top < window.innerHeight) marks.firstCardVisible = performance.now()
    if (marks.full === null && cards.length >= ${expected}) marks.full = performance.now()
  }
  new MutationObserver(check).observe(document, { childList: true, subtree: true })
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (entry.name === 'first-contentful-paint') marks.firstContentfulPaint = entry.startTime
  }).observe({ type: 'paint', buffered: true })
})()`
}

export async function readMarks(page: Page): Promise<PageMarks> {
  return page.evaluate(() => (window as unknown as { __perfMarks: PageMarks }).__perfMarks)
}

/** The list request's duration as the page saw it (Resource Timing). */
export async function listFetchMs(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const entry = performance
      .getEntriesByType('resource')
      .find((item) => item.name.includes('/v1/allowances?owner='))
    return entry === undefined ? null : Math.round(entry.duration)
  })
}

export type WaterfallEntry = { name: string; start: number; end: number; bytes: number }

/**
 * Where the first screen's time went: the document and every request it made,
 * from navigation start. Without this a red `SC-008` says "slow" but not what to
 * cut (`T057`).
 */
export async function waterfall(page: Page): Promise<WaterfallEntry[]> {
  return page.evaluate(() => {
    const entries = [
      ...performance.getEntriesByType('navigation'),
      ...performance.getEntriesByType('resource'),
    ] as PerformanceResourceTiming[]
    return entries.map((entry) => ({
      name: entry.name.replace(/^https?:\/\/[^/]+/, '').slice(0, 80),
      start: Math.round(entry.startTime),
      end: Math.round(entry.responseEnd),
      bytes: entry.transferSize,
    }))
  })
}

export async function cardCount(page: Page): Promise<number> {
  return page.locator(CARD_SELECTOR).count()
}

export type LaunchOptions = { proxyPort?: number }

export function launch(config: PerfConfig, options: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({
    executablePath: config.chromePath,
    headless: true,
    ...(options.proxyPort === undefined
      ? {}
      : {
          // `<-loopback>` keeps nothing out of the tunnel; QUIC off so every byte is TCP.
          proxy: { server: `http://127.0.0.1:${options.proxyPort}`, bypass: '<-loopback>' },
          args: ['--disable-quic'],
        }),
  })
}

export type OpenOptions = {
  owner: string
  expectedCards: number
  viewport: { width: number; height: number }
  mobile?: boolean
  /** Chrome's CPU slowdown factor; 4 is the usual mid-range phone. */
  cpuSlowdown?: number
}

/** A fresh context — empty cache, no cookies — with the wallet and the marks installed. */
export async function newVisit(
  browser: Browser,
  options: OpenOptions,
): Promise<{ context: BrowserContext; page: Page; consoleErrors: string[] }> {
  const context = await browser.newContext({
    viewport: options.viewport,
    ...(options.mobile === true ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  })
  await context.addInitScript(stubWalletScript(options.owner))
  await context.addInitScript(marksScript(options.expectedCards))
  const page = await context.newPage()
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleErrors.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  if (options.cpuSlowdown !== undefined && options.cpuSlowdown > 1) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpuSlowdown })
  }
  return { context, page, consoleErrors }
}

/** Raw samples and the verdict, as JSON outside the repository. */
export async function saveResult(
  config: PerfConfig,
  name: string,
  result: unknown,
): Promise<string> {
  await mkdir(config.outDir, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').slice(0, 19)
  const path = join(config.outDir, `${name}-${stamp}.json`)
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`)
  return path
}
