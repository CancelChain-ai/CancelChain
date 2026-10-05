import type { Allowance, AllowanceEvent, StreamMessage } from '@cancelchain/shared'
import { describe, expect, it, vi } from 'vitest'
import { createLogger } from './logger.js'
import { createStreamHub, type StreamReaders } from './stream.js'

/**
 * The stream's fan-out (`T042`). The triggers and the reads are checked on
 * PGlite (`stream.pglite.test.ts`); here: who gets what, in which order, and
 * what a stream hears when the hub could not deliver.
 */

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const STRANGER = '8N6FWYVvCvcf3ZR2NfRmEbnVWZ1GvmuKXtqoMoBMvmKN'
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

const EVENT: AllowanceEvent = {
  id: '42',
  allowancePda: PDA,
  kind: 'cancelled',
  amount: null,
  reason: null,
  signature: '5'.repeat(88),
  slot: 506_340_647,
  blockTime: '2026-10-05T10:00:00.000Z',
  chargesStopAt: '2026-10-28T17:07:36.000Z',
}

const allowanceNotice = (owner: string | null = OWNER) =>
  JSON.stringify({ kind: 'allowance', pda: PDA, owner })
const eventNotice = (owner: string | null = OWNER, id = '42') =>
  JSON.stringify({ kind: 'event', id, pda: PDA, owner })

function setup(read: Partial<StreamReaders> = {}, maxStreams?: number) {
  const readers: StreamReaders = {
    allowance: vi.fn(async () => ALLOWANCE),
    event: vi.fn(async () => EVENT),
    ...read,
  }
  const logger = createLogger('silent')
  const hub = createStreamHub({
    read: readers,
    logger,
    ...(maxStreams === undefined ? {} : { maxStreams }),
  })
  return { hub, readers, logger }
}

function listener() {
  const received: StreamMessage[] = []
  const close = vi.fn()
  return { received, close, subscriber: { send: (m: StreamMessage) => received.push(m), close } }
}

describe('createStreamHub', () => {
  it('hands a changed permission to every stream of its owner, read once', async () => {
    const { hub, readers } = setup()
    const a = listener()
    const b = listener()
    hub.subscribe(OWNER, a.subscriber)
    hub.subscribe(OWNER, b.subscriber)

    await hub.notify(allowanceNotice())

    expect(a.received).toEqual([{ type: 'allowance.updated', allowance: ALLOWANCE }])
    expect(b.received).toEqual(a.received)
    expect(readers.allowance).toHaveBeenCalledTimes(1)
    expect(readers.allowance).toHaveBeenCalledWith(PDA)
  })

  it('hands an appended event over with the permission it belongs to', async () => {
    const { hub, readers } = setup()
    const a = listener()
    hub.subscribe(OWNER, a.subscriber)

    await hub.notify(eventNotice())

    expect(a.received).toEqual([{ type: 'event.appended', allowancePda: PDA, event: EVENT }])
    expect(readers.event).toHaveBeenCalledWith('42')
  })

  it('tells another wallet nothing, and reads nothing for a wallet with no stream', async () => {
    const { hub, readers } = setup()
    const stranger = listener()
    hub.subscribe(STRANGER, stranger.subscriber)

    await hub.notify(allowanceNotice())
    await hub.notify(eventNotice())

    expect(stranger.received).toEqual([])
    expect(readers.allowance).not.toHaveBeenCalled()
    expect(readers.event).not.toHaveBeenCalled()
  })

  it('stops delivering to a stream that left, and forgets the wallet with its last stream', async () => {
    const { hub, readers } = setup()
    const a = listener()
    const leave = hub.subscribe(OWNER, a.subscriber)
    expect(hub.size()).toBe(1)

    leave?.()
    leave?.()
    await hub.notify(allowanceNotice())

    expect(hub.size()).toBe(0)
    expect(a.received).toEqual([])
    expect(readers.allowance).not.toHaveBeenCalled()
  })

  it('delivers in the order the database announced, however long each read takes', async () => {
    let release: (() => void) | undefined
    const slow = new Promise<void>((resolve) => {
      release = resolve
    })
    const { hub } = setup({
      allowance: async () => {
        await slow
        return ALLOWANCE
      },
    })
    const a = listener()
    hub.subscribe(OWNER, a.subscriber)

    const first = hub.notify(allowanceNotice())
    const second = hub.notify(eventNotice())
    release?.()
    await Promise.all([first, second])

    expect(a.received.map((m) => m.type)).toEqual(['allowance.updated', 'event.appended'])
  })

  it('says resync when a changed row could not be read — a missed change, not silence', async () => {
    const { hub } = setup({
      event: async () => {
        throw new Error('connection terminated')
      },
    })
    const a = listener()
    const stranger = listener()
    hub.subscribe(OWNER, a.subscriber)
    hub.subscribe(STRANGER, stranger.subscriber)

    await hub.notify(eventNotice())

    expect(a.received).toEqual([{ type: 'resync' }])
    expect(stranger.received).toEqual([])
  })

  it('keeps going after a failed read', async () => {
    const event = vi
      .fn<StreamReaders['event']>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue(EVENT)
    const { hub } = setup({ event })
    const a = listener()
    hub.subscribe(OWNER, a.subscriber)

    await hub.notify(eventNotice())
    await hub.notify(eventNotice())

    expect(a.received.map((m) => m.type)).toEqual(['resync', 'event.appended'])
  })

  it('sends nothing for a row that is gone by the time it is read', async () => {
    const { hub } = setup({ allowance: async () => null, event: async () => null })
    const a = listener()
    hub.subscribe(OWNER, a.subscriber)

    await hub.notify(allowanceNotice())
    await hub.notify(eventNotice())

    expect(a.received).toEqual([])
  })

  it('logs a notification of unknown shape and delivers nothing', async () => {
    const { hub, logger } = setup()
    const error = vi.spyOn(logger, 'error')
    const a = listener()
    hub.subscribe(OWNER, a.subscriber)

    for (const payload of [
      'not json',
      '{"kind":"plan","pda":"x","owner":"y"}',
      eventNotice(OWNER, '-1'),
    ]) {
      await hub.notify(payload)
    }

    expect(a.received).toEqual([])
    expect(error).toHaveBeenCalledTimes(3)
  })

  it('ignores an event whose permission has no owner on record', async () => {
    const { hub, readers } = setup()
    hub.subscribe(OWNER, listener().subscriber)
    await hub.notify(eventNotice(null))
    expect(readers.event).not.toHaveBeenCalled()
  })

  it('tells every open stream to read again on resync, behind what is already queued', async () => {
    const { hub } = setup()
    const a = listener()
    const b = listener()
    hub.subscribe(OWNER, a.subscriber)
    hub.subscribe(STRANGER, b.subscriber)

    const queued = hub.notify(allowanceNotice())
    hub.resync()
    await queued
    await hub.notify('{}')

    expect(a.received.map((m) => m.type)).toEqual(['allowance.updated', 'resync'])
    expect(b.received).toEqual([{ type: 'resync' }])
  })

  it('refuses a stream past the ceiling and takes one again once a slot frees', () => {
    const { hub } = setup({}, 2)
    const first = hub.subscribe(OWNER, listener().subscriber)
    expect(hub.subscribe(STRANGER, listener().subscriber)).not.toBeNull()
    expect(hub.subscribe(OWNER, listener().subscriber)).toBeNull()

    first?.()
    expect(hub.subscribe(OWNER, listener().subscriber)).not.toBeNull()
  })

  it('closes every stream on shutdown', () => {
    const { hub } = setup()
    const a = listener()
    const b = listener()
    hub.subscribe(OWNER, a.subscriber)
    hub.subscribe(STRANGER, b.subscriber)

    hub.close()

    expect(a.close).toHaveBeenCalledTimes(1)
    expect(b.close).toHaveBeenCalledTimes(1)
  })
})
