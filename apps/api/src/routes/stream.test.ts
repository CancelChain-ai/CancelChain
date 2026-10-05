import { type Allowance, apiErrorSchema, streamMessageSchema } from '@cancelchain/shared'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { errorHandler, notFoundHandler } from '../errors.js'
import { createLogger } from '../logger.js'
import { createStreamHub, type StreamHub } from '../stream.js'
import type { AppEnv } from '../types.js'
import { createOutbox, type StreamDeps, streamRoute } from './stream.js'

/**
 * `GET /v1/stream` — `T042`. Delivery rules live in the hub (`stream.test.ts`);
 * here: the wire — SSE frames, the order of the first ones, the heartbeat, the
 * ceiling, and that a stream leaving gives its slot back.
 */

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const PDA = 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2'

const ALLOWANCE: Allowance = {
  pda: PDA,
  owner: OWNER,
  delegate: 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg',
  mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  kind: 'subscription',
  capAmount: '9990000',
  periodSeconds: 2_592_000,
  spentInPeriod: '0',
  periodStartedAt: '2026-09-28T17:07:36.000Z',
  expiresAt: null,
  pausedAt: null,
  endsAt: null,
  status: 'revoked',
  planPda: 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg',
  lastSlot: 506_340_647,
  syncedAt: '2026-10-05T10:00:00.000Z',
}

const NOTICE = JSON.stringify({ kind: 'allowance', pda: PDA, owner: OWNER })

const open: ReadableStreamDefaultReader<Uint8Array>[] = []

afterEach(async () => {
  for (const reader of open.splice(0)) await reader.cancel().catch(() => {})
})

function setup(over: Partial<StreamDeps> & { maxStreams?: number } = {}) {
  const { maxStreams, ...deps } = over
  const hub = createStreamHub({
    read: { allowance: async () => ALLOWANCE, event: async () => null },
    logger: createLogger('silent'),
    ...(maxStreams === undefined ? {} : { maxStreams }),
  })
  const app = new Hono<AppEnv>()
  app.notFound(notFoundHandler)
  app.onError(errorHandler)
  app.route('/', streamRoute({ hub, ...deps }))
  return { hub, app }
}

type Frame = { event: string | null; data: string | null; comment: string | null }

/** Reads SSE frames off a response until `count` are in. */
function frames(response: Response) {
  const body = response.body
  if (body === null) throw new Error('no body')
  const reader = body.getReader()
  open.push(reader)
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    reader,
    async next(count: number): Promise<Frame[]> {
      const out: Frame[] = []
      while (out.length < count) {
        const end = buffer.indexOf('\n\n')
        if (end >= 0) {
          const raw = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const frame: Frame = { event: null, data: null, comment: null }
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) frame.event = line.slice(7)
            else if (line.startsWith('data: ')) frame.data = line.slice(6)
            else if (line.startsWith(':')) frame.comment = line.slice(1).trim()
          }
          out.push(frame)
          continue
        }
        const { value, done } = await reader.read()
        if (done) throw new Error(`stream ended after ${out.length} of ${count} frames`)
        buffer += decoder.decode(value, { stream: true })
      }
      return out
    },
  }
}

async function connect(app: Hono<AppEnv>, owner = OWNER) {
  return app.request(`/v1/stream?owner=${owner}`)
}

/** Waits until the hub has `count` streams — the route subscribes before the body flows. */
async function streams(hub: StreamHub, count: number) {
  for (let i = 0; i < 100 && hub.size() !== count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(hub.size()).toBe(count)
}

describe('GET /v1/stream', () => {
  it('opens an event stream that starts with ready', async () => {
    const { app } = setup()
    const response = await connect(app)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    const [first] = await frames(response).next(1)
    expect(first).toEqual({ event: 'ready', data: '{"type":"ready"}', comment: null })
  })

  it('names each frame by its type and carries the whole contract message', async () => {
    const { app, hub } = setup()
    const stream = frames(await connect(app))
    await stream.next(1)

    await hub.notify(NOTICE)
    const [frame] = await stream.next(1)

    expect(frame?.event).toBe('allowance.updated')
    expect(streamMessageSchema.parse(JSON.parse(frame?.data ?? ''))).toEqual({
      type: 'allowance.updated',
      allowance: ALLOWANCE,
    })
  })

  it('sends a named ping down a quiet stream, which the browser can see', async () => {
    const { app } = setup({ heartbeatMs: 20 })
    const stream = frames(await connect(app))

    const [, ping] = await stream.next(2)

    expect(ping?.event).toBe('ping')
    expect(streamMessageSchema.parse(JSON.parse(ping?.data ?? ''))).toEqual({ type: 'ping' })
  })

  it('gives the slot back when the client goes away', async () => {
    const { app, hub } = setup({ heartbeatMs: 20 })
    const stream = frames(await connect(app))
    await stream.next(1)
    await streams(hub, 1)

    await stream.reader.cancel()

    await streams(hub, 0)
  })

  it('answers a full server with a named 429, not a stream that dies', async () => {
    const { app, hub } = setup({ maxStreams: 1 })
    await frames(await connect(app)).next(1)
    await streams(hub, 1)

    const refused = await connect(app)

    expect(refused.status).toBe(429)
    expect(apiErrorSchema.parse(await refused.json()).error.code).toBe('RATE_LIMITED')
  })

  it('ends the stream when the server shuts down', async () => {
    const { app, hub } = setup()
    const stream = frames(await connect(app))
    await stream.next(1)

    hub.close()

    const { done } = await stream.reader.read()
    expect(done).toBe(true)
    await streams(hub, 0)
  })

  it('wants a wallet address', async () => {
    const { app, hub } = setup()
    for (const query of ['', '?owner=not-an-address']) {
      const response = await app.request(`/v1/stream${query}`)
      expect(response.status).toBe(400)
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe('INVALID_INPUT')
    }
    expect(hub.size()).toBe(0)
  })
})

describe('createOutbox', () => {
  const update = { type: 'allowance.updated', allowance: ALLOWANCE } as const

  it('starts with ready and hands messages over oldest first, once', () => {
    const outbox = createOutbox(10)
    outbox.push(update)
    expect(outbox.take()).toEqual([{ type: 'ready' }, update])
    expect(outbox.size).toBe(0)
    expect(outbox.take()).toEqual([])
  })

  it('swaps a backlog the client is not draining for a single resync', () => {
    const outbox = createOutbox(3)
    for (let i = 0; i < 3; i += 1) outbox.push(update)
    expect(outbox.take()).toEqual([{ type: 'resync' }])
  })

  it('keeps a backlog right at the ceiling', () => {
    const outbox = createOutbox(3)
    outbox.push(update)
    outbox.push(update)
    expect(outbox.take()).toEqual([{ type: 'ready' }, update, update])
  })
})
