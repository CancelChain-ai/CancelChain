import { describe, expect, it } from 'vitest'
import { EmptySampleError, everyVerdict, p95Verdict, percentile, summarize } from './stats.js'

const forty = Array.from({ length: 40 }, (_, i) => (i + 1) * 100)

describe('percentile', () => {
  it('is nearest rank: the p95 of 40 samples is the 38th smallest, a time someone waited', () => {
    expect(percentile(forty, 95)).toBe(3800)
    expect(percentile([...forty].reverse(), 95)).toBe(3800)
  })

  it('never invents a value between two samples', () => {
    expect(percentile([1000, 2000], 50)).toBe(1000)
    expect(percentile([1000, 2000], 95)).toBe(2000)
  })

  it('refuses to judge nothing, and a percentile outside (0, 100]', () => {
    expect(() => percentile([], 95)).toThrow(EmptySampleError)
    expect(() => percentile([1], 0)).toThrow(RangeError)
    expect(() => percentile([1], 101)).toThrow(RangeError)
  })
})

describe('summarize', () => {
  it('reports the spread a reader needs to see backoff in a run', () => {
    expect(summarize([300, 100, 200])).toEqual({ n: 3, min: 100, p50: 200, p95: 300, max: 300 })
  })
})

describe('p95Verdict', () => {
  it('passes strictly under the budget', () => {
    expect(p95Verdict(forty, 3801).pass).toBe(true)
    expect(p95Verdict(forty, 3800).pass).toBe(false)
  })

  it('counts a visit that never finished as over budget', () => {
    const samples = [...forty.slice(0, 37).map(() => 100), Infinity, Infinity, Infinity]
    expect(p95Verdict(samples, 3000).pass).toBe(false)
  })
})

describe('everyVerdict', () => {
  it('lets the worst sample decide', () => {
    expect(everyVerdict([100, 200, 14_999], 15_000).pass).toBe(true)
    expect(everyVerdict([100, 200, 15_000], 15_000)).toEqual({
      pass: false,
      statement: '1 of 3 over 15000 ms, worst 15000 ms',
    })
  })

  it('treats a sample that never arrived as a failure, not a gap', () => {
    const verdict = everyVerdict([100, null], 30_000)
    expect(verdict.pass).toBe(false)
    expect(verdict.statement).toBe('1 of 2 over 30000 ms (1 never arrived), worst 100 ms')
  })

  it('refuses an empty run', () => {
    expect(() => everyVerdict([], 1)).toThrow(EmptySampleError)
  })
})
