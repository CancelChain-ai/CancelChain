import { request } from 'node:http'
import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { type NetworkProfile, startShaper, transmit, WPT_3G } from './shaper.js'

describe('transmit', () => {
  const link = { kbps: WPT_3G.downKbps, oneWayMs: WPT_3G.rttMs / 2 }

  it('charges serialization at the link rate and half a round trip on top', () => {
    // 200 000 bytes at 1600 kbit/s = 1 s on the wire.
    expect(transmit(link, 0, 0, 200_000)).toEqual({ busyUntil: 1000, deliverAt: 1150 })
  })

  it('queues behind whatever is still leaving: the link is shared', () => {
    const first = transmit(link, 0, 0, 200_000)
    const second = transmit(link, first.busyUntil, 10, 2_000)
    expect(second.busyUntil).toBe(1010)
    expect(second.deliverAt).toBe(1160)
  })

  it('starts at once on an idle link', () => {
    expect(transmit(link, 50, 100, 0)).toEqual({ busyUntil: 100, deliverAt: 250 })
  })
})

/**
 * The shaper on loopback, where the real network adds nothing measurable: the
 * delays it promises must be there. Lower bounds only — a loaded machine can be
 * slower, never faster than a timer.
 */
describe('startShaper', () => {
  const profile: NetworkProfile = { name: 'test', downKbps: 8_000, upKbps: 8_000, rttMs: 100 }
  let echo: Server | undefined
  let close: (() => Promise<void>) | undefined

  afterEach(async () => {
    await close?.()
    echo?.close()
  })

  function tunnel(port: number, target: number): Promise<{ opened: number; echoed: number }> {
    const started = performance.now()
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: `127.0.0.1:${target}`,
      })
      req.on('connect', (_res, socket) => {
        const opened = performance.now() - started
        const sent = performance.now()
        socket.once('data', () => {
          resolve({ opened, echoed: performance.now() - sent })
          socket.destroy()
        })
        socket.write('ping')
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('makes a new host pay DNS and TCP, a known host TCP only, and every exchange a round trip', async () => {
    echo = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo?.listen(0, '127.0.0.1', resolve))
    const address = echo.address()
    if (address === null || typeof address === 'string') throw new Error('no echo port')
    const shaper = await startShaper(profile)
    close = shaper.close

    const first = await tunnel(shaper.port, address.port)
    expect(first.opened).toBeGreaterThanOrEqual(2 * profile.rttMs - 1)
    expect(first.echoed).toBeGreaterThanOrEqual(profile.rttMs - 1)

    const second = await tunnel(shaper.port, address.port)
    expect(second.opened).toBeGreaterThanOrEqual(profile.rttMs - 1)
    expect(second.opened).toBeLessThan(2 * profile.rttMs)

    expect(shaper.bytes()).toEqual({ down: 8, up: 8 })
    shaper.reset()
    expect(shaper.bytes()).toEqual({ down: 0, up: 0 })
    const afterReset = await tunnel(shaper.port, address.port)
    expect(afterReset.opened).toBeGreaterThanOrEqual(2 * profile.rttMs - 1)
  })

  it('delivers every byte, in order: a TLS stream tolerates neither a gap nor a swap', async () => {
    echo = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo?.listen(0, '127.0.0.1', resolve))
    const address = echo.address()
    if (address === null || typeof address === 'string') throw new Error('no echo port')
    // Fast enough that many chunks share a millisecond.
    const shaper = await startShaper({
      name: 'fast',
      downKbps: 100_000,
      upKbps: 100_000,
      rttMs: 20,
    })
    close = shaper.close

    const sent = Array.from({ length: 400 }, (_, i) => `${i},`).join('')
    const received = await new Promise<string>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: shaper.port,
        method: 'CONNECT',
        path: `127.0.0.1:${address.port}`,
      })
      req.on('connect', (_res, socket) => {
        let text = ''
        socket.on('data', (chunk: Buffer) => {
          text += chunk.toString()
          if (text.length >= sent.length) {
            resolve(text)
            socket.destroy()
          }
        })
        for (const piece of sent.match(/\d+,/g) ?? []) socket.write(piece)
      })
      req.on('error', reject)
      req.end()
    })
    expect(received).toBe(sent)
  })
})
