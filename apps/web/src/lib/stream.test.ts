import type { StreamMessage } from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { type EventSourceLike, openStream, type StreamStatus, type StreamTimers } from './stream'

/**
 * `openStream` (`T042a`). Checked against a fake `EventSource` and a manual
 * clock: the watchdog reopens a stream that went quiet (the half-open case the
 * browser never reports), a refused stream is reopened with a growing backoff,
 * and a frame outside the contract turns into "read everything again".
 */

const URL = 'http://api.test/v1/stream?owner=x'

class FakeSource implements EventSourceLike {
  readyState = 0
  onerror: ((event: Event) => void) | null = null
  closed = false
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  emit(type: string, data: string): void {
    this.readyState = 1
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent<string>)
    }
  }

  send(message: StreamMessage): void {
    this.emit(message.type, JSON.stringify(message))
  }

  fail(readyState: 0 | 2): void {
    this.readyState = readyState
    this.onerror?.(new Event('error'))
  }
}

function clock() {
  let now = 0
  let next = 0
  const due = new Map<number, { at: number; callback: () => void }>()
  const timers: StreamTimers = {
    setTimeout(callback, ms) {
      const id = ++next
      due.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout(handle) {
      due.delete(handle as number)
    },
  }
  function advance(ms: number) {
    const until = now + ms
    for (;;) {
      const first = [...due.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (first === undefined) break
      due.delete(first[0])
      now = first[1].at
      first[1].callback()
    }
    now = until
  }
  return { timers, advance, pending: () => due.size }
}

function setup() {
  const sources: FakeSource[] = []
  const messages: StreamMessage[] = []
  const statuses: StreamStatus[] = []
  const time = clock()
  const close = openStream({
    url: URL,
    create: (url) => {
      expect(url).toBe(URL)
      const source = new FakeSource()
      sources.push(source)
      return source
    },
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    silenceMs: 40_000,
    backoff: { initialMs: 1_000, maxMs: 30_000 },
    timers: time.timers,
  })
  const current = () => {
    const source = sources.at(-1)
    if (source === undefined) throw new Error('no stream opened')
    return source
  }
  return { sources, messages, statuses, close, current, ...time }
}

describe('openStream', () => {
  it('is connecting until ready, then live, and hands every message on', () => {
    const { current, messages, statuses } = setup()
    expect(statuses).toEqual(['connecting'])

    current().send({ type: 'ready' })
    current().send({ type: 'ping' })
    current().send({ type: 'resync' })

    expect(statuses).toEqual(['connecting', 'live'])
    expect(messages.map((message) => message.type)).toEqual(['ready', 'ping', 'resync'])
  })

  it('a frame outside the contract becomes a resync, not silence', () => {
    const { current, messages } = setup()
    current().emit('allowance.updated', '{"type":"allowance.updated","allowance":{}}')
    current().emit('ready', 'not json')

    expect(messages).toEqual([{ type: 'resync' }, { type: 'resync' }])
  })

  it('reopens a stream that went quiet past the silence limit', () => {
    const { sources, current, statuses, advance } = setup()
    current().send({ type: 'ready' })

    advance(39_999)
    expect(sources).toHaveLength(1)
    advance(1)

    expect(sources).toHaveLength(2)
    expect(sources[0]?.closed).toBe(true)
    expect(statuses).toEqual(['connecting', 'live', 'reconnecting'])

    current().send({ type: 'ready' })
    expect(statuses.at(-1)).toBe('live')
  })

  it('a ping keeps a quiet stream alive', () => {
    const { sources, current, advance } = setup()
    current().send({ type: 'ready' })

    for (let i = 0; i < 5; i++) {
      advance(20_000)
      current().send({ type: 'ping' })
    }

    expect(sources).toHaveLength(1)
  })

  it('leaves a dropped connection to the browser, which reconnects by itself', () => {
    const { sources, current, statuses, advance } = setup()
    current().send({ type: 'ready' })

    current().fail(0)
    advance(5_000)

    expect(sources).toHaveLength(1)
    expect(statuses.at(-1)).toBe('reconnecting')
    current().send({ type: 'ready' })
    expect(statuses.at(-1)).toBe('live')
  })

  it('reopens a refused stream itself, backing off up to the ceiling', () => {
    const { sources, current, statuses, advance } = setup()
    const opened: number[] = []
    let elapsed = 0
    const step = (ms: number) => {
      advance(ms)
      elapsed += ms
    }

    for (let i = 0; i < 7; i++) {
      const before = sources.length
      current().fail(2)
      expect(statuses.at(-1)).toBe('down')
      while (sources.length === before) step(500)
      opened.push(elapsed)
    }

    const gaps = opened.map((at, i) => at - (i === 0 ? 0 : (opened[i - 1] ?? 0)))
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(sources.slice(0, -1).every((source) => source.closed)).toBe(true)
  })

  it('ready resets the backoff', () => {
    const { sources, current, advance } = setup()
    current().fail(2)
    advance(1_000)
    current().fail(2)
    advance(2_000)
    current().send({ type: 'ready' })

    current().fail(2)
    const before = sources.length
    advance(1_000)
    expect(sources.length).toBe(before + 1)
  })

  it('stays down while refused: no watchdog reopening on top of the backoff', () => {
    const { sources, current, advance } = setup()
    current().fail(2)
    advance(999)
    expect(sources).toHaveLength(1)
  })

  it('closing stops everything: the stream, the watchdog, the backoff', () => {
    const first = setup()
    first.current().send({ type: 'ready' })
    first.close()
    expect(first.current().closed).toBe(true)
    first.advance(120_000)
    expect(first.sources).toHaveLength(1)

    const second = setup()
    second.current().fail(2)
    second.close()
    second.advance(120_000)
    expect(second.sources).toHaveLength(1)
    expect(second.pending()).toBe(0)
  })

  it('ignores a stream it has already replaced', () => {
    const { sources, messages, current, advance } = setup()
    current().send({ type: 'ready' })
    advance(40_000)
    const stale = sources[0]
    stale?.send({ type: 'resync' })
    stale?.fail(2)

    expect(messages).toEqual([{ type: 'ready' }])
    expect(sources).toHaveLength(2)
  })
})
