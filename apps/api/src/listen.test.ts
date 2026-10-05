import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ListenConnection, ProbeLostError, startListener } from './listen.js'
import { createLogger } from './logger.js'

/**
 * The stream's `LISTEN` keeper (`T042`). The failure it exists for is the
 * quiet one: a subscription that stops hearing without anything throwing —
 * which is what a half-open connection does: no close, so the driver never re-listens.
 */

const CHANNEL = 'cancelchain_stream'
const EVERY = 30_000
const TIMEOUT = 10_000
const RETRY = 5_000

type FakeConnection = ListenConnection & {
  hears: boolean
  closed: boolean
  relisten: () => void
  deliver: (payload: string) => void
}

function fakeDatabase() {
  const connections: FakeConnection[] = []
  let refuseConnections = false
  let refuseNotify = false

  function connect(): FakeConnection {
    let onNotify: ((payload: string) => void) | null = null
    let onListen: (() => void) | null = null
    const connection: FakeConnection = {
      hears: true,
      closed: false,
      listen: async (channel, notify, listened) => {
        expect(channel).toBe(CHANNEL)
        if (refuseConnections) throw new Error('connect ECONNREFUSED')
        onNotify = notify
        onListen = listened
        listened()
      },
      close: async () => {
        connection.closed = true
      },
      relisten: () => onListen?.(),
      deliver: (payload) => {
        if (connection.hears && !connection.closed) onNotify?.(payload)
      },
    }
    connections.push(connection)
    return connection
  }

  async function notify(channel: string, payload: string): Promise<void> {
    if (refuseNotify) throw new Error('pool exhausted')
    expect(channel).toBe(CHANNEL)
    for (const connection of connections) connection.deliver(payload)
  }

  return {
    connections,
    connect: vi.fn(connect),
    notify: vi.fn(notify),
    refuseConnections: (value: boolean) => {
      refuseConnections = value
    },
    refuseNotify: (value: boolean) => {
      refuseNotify = value
    },
  }
}

function start(db: ReturnType<typeof fakeDatabase>) {
  const notices: string[] = []
  const onListen = vi.fn()
  const logger = createLogger('silent')
  const error = vi.spyOn(logger, 'error')
  const listener = startListener({
    connect: db.connect,
    notify: db.notify,
    channel: CHANNEL,
    onNotice: (payload) => notices.push(payload),
    onListen,
    logger,
    probeEveryMs: EVERY,
    probeTimeoutMs: TIMEOUT,
    retryMs: RETRY,
  })
  return { listener, notices, onListen, error }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startListener', () => {
  it('passes notifications on and says once that it listens', async () => {
    const db = fakeDatabase()
    const { listener, notices, onListen } = start(db)
    await vi.advanceTimersByTimeAsync(0)

    await db.notify(CHANNEL, '{"kind":"allowance","pda":"p","owner":"o"}')

    expect(notices).toEqual(['{"kind":"allowance","pda":"p","owner":"o"}'])
    expect(onListen).toHaveBeenCalledTimes(1)
    await listener.stop()
  })

  it('keeps probes — its own and another instance’s — away from the streams', async () => {
    const db = fakeDatabase()
    const { listener, notices } = start(db)
    await vi.advanceTimersByTimeAsync(EVERY)

    await db.notify(CHANNEL, '{"kind":"probe","nonce":"from-another-api"}')

    expect(db.notify).toHaveBeenCalledWith(CHANNEL, expect.stringContaining('"kind":"probe"'))
    expect(notices).toEqual([])
    await listener.stop()
  })

  it('stays on one connection while its probes come back', async () => {
    const db = fakeDatabase()
    const { listener, onListen } = start(db)

    await vi.advanceTimersByTimeAsync(EVERY * 5)

    expect(db.connect).toHaveBeenCalledTimes(1)
    expect(db.notify).toHaveBeenCalledTimes(5)
    expect(onListen).toHaveBeenCalledTimes(1)
    await listener.stop()
  })

  it('notices a subscription that went deaf, rebuilds it, and says so (resync)', async () => {
    const db = fakeDatabase()
    const { listener, notices, onListen, error } = start(db)
    await vi.advanceTimersByTimeAsync(0)
    const [first] = db.connections
    if (first === undefined) throw new Error('no connection')

    first.hears = false
    await vi.advanceTimersByTimeAsync(EVERY + TIMEOUT)
    expect(first.closed).toBe(true)
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(ProbeLostError) }),
      expect.any(String),
    )

    await vi.advanceTimersByTimeAsync(RETRY)
    expect(db.connect).toHaveBeenCalledTimes(2)
    expect(onListen).toHaveBeenCalledTimes(2)

    await db.notify(CHANNEL, '{"kind":"event"}')
    expect(notices).toEqual(['{"kind":"event"}'])
    await listener.stop()
  })

  it('keeps retrying while the database refuses, and resumes when it is back', async () => {
    const db = fakeDatabase()
    db.refuseConnections(true)
    const { listener, onListen, error } = start(db)

    await vi.advanceTimersByTimeAsync(RETRY * 3)
    expect(db.connect.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(onListen).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    expect(db.connections.every((connection) => connection.closed)).toBe(true)

    db.refuseConnections(false)
    await vi.advanceTimersByTimeAsync(RETRY)
    expect(onListen).toHaveBeenCalledTimes(1)
    await listener.stop()
  })

  it('treats a probe it could not even send as a lost subscription', async () => {
    const db = fakeDatabase()
    const { listener, onListen } = start(db)
    db.refuseNotify(true)

    await vi.advanceTimersByTimeAsync(EVERY)
    db.refuseNotify(false)
    await vi.advanceTimersByTimeAsync(RETRY)

    expect(db.connect).toHaveBeenCalledTimes(2)
    expect(onListen).toHaveBeenCalledTimes(2)
    await listener.stop()
  })

  it('passes on a re-listen the driver did by itself — that gap was not heard either', async () => {
    const db = fakeDatabase()
    const { listener, onListen } = start(db)
    await vi.advanceTimersByTimeAsync(0)

    db.connections[0]?.relisten()

    expect(onListen).toHaveBeenCalledTimes(2)
    await listener.stop()
  })

  it('stops: closes its connection and opens no other', async () => {
    const db = fakeDatabase()
    const { listener } = start(db)
    await vi.advanceTimersByTimeAsync(EVERY + 1)

    await listener.stop()
    await vi.advanceTimersByTimeAsync(EVERY * 3)

    expect(db.connect).toHaveBeenCalledTimes(1)
    expect(db.connections[0]?.closed).toBe(true)
  })
})
