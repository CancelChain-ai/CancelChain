/**
 * Numbers a measurement is judged by.
 *
 * The percentile is **nearest rank**, not interpolated: the p95 of 40 samples is
 * the 38th smallest, a time somebody actually waited. An interpolated value can
 * sit between two samples and pass a budget that no real visit met.
 */

export type Summary = {
  n: number
  min: number
  p50: number
  p95: number
  max: number
}

export class EmptySampleError extends Error {
  constructor() {
    super('no samples: a budget cannot be judged on nothing')
    this.name = 'EmptySampleError'
  }
}

/** Nearest-rank percentile: the smallest sample with at least `p`% of samples at or below it. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new EmptySampleError()
  if (!(p > 0 && p <= 100)) throw new RangeError(`percentile must be in (0, 100], got ${p}`)
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  // `rank` is 1…length for p in (0, 100].
  return sorted[rank - 1] as number
}

export function summarize(samples: readonly number[]): Summary {
  return {
    n: samples.length,
    min: Math.min(...samples),
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: percentile(samples, 100),
  }
}

export type Verdict = {
  pass: boolean
  /** What was compared with the budget, said in words for the report. */
  statement: string
}

/** `SC-003`: the p95 under the budget. */
export function p95Verdict(samples: readonly number[], budgetMs: number): Verdict {
  const p95 = percentile(samples, 95)
  return {
    pass: p95 < budgetMs,
    statement: `p95 ${p95} ms of ${samples.length} samples vs < ${budgetMs} ms`,
  }
}

/**
 * `SC-006`, `SC-008`, `SC-009`: every sample under the budget. The budget is
 * promised to each visitor, not on average across them, so the worst sample
 * decides — and a sample that never arrived counts as over budget, not as missing.
 */
export function everyVerdict(samples: readonly (number | null)[], budgetMs: number): Verdict {
  if (samples.length === 0) throw new EmptySampleError()
  const missing = samples.filter((sample) => sample === null).length
  const arrived = samples.filter((sample): sample is number => sample !== null)
  const over = arrived.filter((sample) => sample >= budgetMs).length
  const worst = arrived.length === 0 ? null : Math.max(...arrived)
  return {
    pass: missing === 0 && over === 0,
    statement:
      `${over + missing} of ${samples.length} over ${budgetMs} ms` +
      (missing > 0 ? ` (${missing} never arrived)` : '') +
      (worst === null ? '' : `, worst ${worst} ms`),
  }
}
