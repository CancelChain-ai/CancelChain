import { createServer, request, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/**
 * A packet-level network for `SC-008`: an HTTP `CONNECT` proxy Chrome is pointed at.
 *
 * Not Chrome's own throttling. DevTools emulation (`Network.emulateNetworkConditions`)
 * adds its latency **per request**, does not delay TCP or TLS handshakes and lets the
 * CORS preflight through untouched — and the dashboard's first screen is exactly a
 * chain of new connections: the page, its script, then a cross-origin read from the
 * API. Here every byte pays the link instead:
 *
 * - each direction is one shared bottleneck — all connections queue on it, the way
 *   they share one radio;
 * - every chunk arrives half a round trip after its last bit left;
 * - a new connection costs one round trip for TCP before the tunnel opens, plus one
 *   for DNS the first time a host is seen. TLS needs no model of its own: its
 *   handshake is bytes through the tunnel and pays the link like any other.
 *
 * The real network to the stand sits underneath, as it does under WebPageTest's
 * shaping. That is part of the number, not noise to subtract.
 */

export type NetworkProfile = {
  name: string
  downKbps: number
  upKbps: number
  rttMs: number
}

/**
 * WebPageTest's "3G" — the profile `SC-008` is measured with (owner's decision
 * 2026-10-07): the criterion says "3G" and this is the profile that carries the
 * name. Lighthouse's mobile preset is the historical "Fast 3G" at half the latency.
 */
export const WPT_3G: NetworkProfile = {
  name: 'WebPageTest 3G',
  downKbps: 1600,
  upKbps: 768,
  rttMs: 300,
}

/** Lighthouse mobile (`simulate` defaults, DevTools "Slow 4G"). A reference number only. */
export const LIGHTHOUSE_MOBILE: NetworkProfile = {
  name: 'Lighthouse mobile',
  downKbps: 1638.4,
  upKbps: 675,
  rttMs: 150,
}

/** When a chunk finishes leaving and when it lands, on a link that may still be busy. */
export function transmit(
  link: { kbps: number; oneWayMs: number },
  busyUntil: number,
  now: number,
  bytes: number,
): { busyUntil: number; deliverAt: number } {
  const start = Math.max(now, busyUntil)
  const done = start + (bytes * 8) / link.kbps
  return { busyUntil: done, deliverAt: done + link.oneWayMs }
}

/**
 * One direction of the shaped network: a FIFO behind a single timer.
 *
 * Not a `setTimeout` per chunk. Separate timers for chunks due microseconds apart
 * do not reliably fire in deadline order (Node schedules them on its own
 * millisecond clock), and both failures were seen through this proxy: a TLS record
 * handed over out of order (`bad record mac`, `ERR_SSL_PROTOCOL_ERROR` in Chrome)
 * and a connection closed before its last chunk (`write after end`). Here nothing
 * — data or the close — is handed over before what was queued ahead of it.
 */
class Link {
  private busyUntil = 0
  private readonly queue: { at: number; deliver: () => void }[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly kbps: number,
    private readonly oneWayMs: number,
  ) {}

  /** Queues `deliver` behind everything already queued; returns when it is due. */
  send(bytes: number, deliver: () => void): number {
    const next = transmit(
      { kbps: this.kbps, oneWayMs: this.oneWayMs },
      this.busyUntil,
      performance.now(),
      bytes,
    )
    this.busyUntil = next.busyUntil
    this.queue.push({ at: next.deliverAt, deliver })
    this.arm()
    return next.deliverAt
  }

  private arm(): void {
    const head = this.queue[0]
    if (this.timer !== null || head === undefined) return
    this.timer = setTimeout(
      () => {
        this.timer = null
        const now = performance.now()
        while (this.queue[0] !== undefined && this.queue[0].at <= now + 1) {
          this.queue.shift()?.deliver()
        }
        this.arm()
      },
      Math.max(0, head.at - performance.now()),
    )
  }
}

export type Shaper = {
  port: number
  profile: NetworkProfile
  /** Bytes that crossed each direction — the page's real weight on this network. */
  bytes: () => { down: number; up: number }
  /** Socket errors seen since the last reset, with the host — a failed visit must say why. */
  errors: () => string[]
  /** Forget resolved hosts and counted bytes: the next visit is a first one again. */
  reset: () => void
  close: () => Promise<void>
}

/**
 * Control: time to the first byte of one HTTPS GET on a new connection through the
 * shaper. The model says DNS + TCP + TLS 1.3 + the request = 4 round trips plus the
 * real network; a number far off that means the shaper is not the network it claims.
 */
export function probeFirstByte(shaper: Shaper, url: string): Promise<number> {
  const target = new URL(url)
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const tunnel = request({
      host: '127.0.0.1',
      port: shaper.port,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
    })
    tunnel.on('connect', (_res, socket) => {
      const tls = tlsConnect({ socket, servername: target.hostname }, () => {
        tls.write(
          `GET ${target.pathname} HTTP/1.1\r\nHost: ${target.hostname}\r\nConnection: close\r\n\r\n`,
        )
      })
      tls.once('data', () => {
        resolve(Math.round(performance.now() - started))
        tls.destroy()
      })
      tls.on('error', reject)
    })
    tunnel.on('error', reject)
    tunnel.end()
  })
}

function pipeShaped(from: Socket, to: Socket, link: Link, count: (n: number) => void): void {
  from.on('data', (chunk: Buffer) => {
    count(chunk.length)
    link.send(chunk.length, () => {
      if (!to.destroyed) to.write(chunk)
    })
  })
  // The close travels behind the data it follows, through the same queue.
  from.on('end', () => {
    link.send(0, () => to.end())
  })
  from.on('error', () => to.destroy())
}

export async function startShaper(profile: NetworkProfile, port = 0): Promise<Shaper> {
  const down = new Link(profile.downKbps, profile.rttMs / 2)
  const up = new Link(profile.upKbps, profile.rttMs / 2)
  const resolved = new Set<string>()
  const totals = { down: 0, up: 0 }
  const sockets = new Set<Socket>()
  const errors: string[] = []

  const server: Server = createServer((_req, res) => {
    // The stand is HTTPS end to end; a plain request here means a misconfigured run.
    res.writeHead(502).end('this proxy only tunnels')
  })

  server.on('connect', (req, client: Socket, head: Buffer) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    const [host = '', rawPort = '443'] = (req.url ?? '').split(':')
    const dns = resolved.has(host) ? 0 : profile.rttMs
    resolved.add(host)
    const upstream = connect({ host, port: Number(rawPort) })
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    upstream.on('error', (error) => {
      errors.push(`upstream ${host}: ${error.message}`)
      client.destroy()
    })
    client.on('error', (error) => {
      errors.push(`client side ${host}: ${error.message}`)
      upstream.destroy()
    })

    upstream.once('connect', () => {
      setTimeout(() => {
        if (client.destroyed) return
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) {
          totals.up += head.length
          up.send(head.length, () => upstream.write(head))
        }
        pipeShaped(client, upstream, up, (n) => {
          totals.up += n
        })
        pipeShaped(upstream, client, down, (n) => {
          totals.down += n
        })
      }, dns + profile.rttMs)
    })
  })

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the shaper has no port')

  return {
    port: address.port,
    profile,
    bytes: () => ({ ...totals }),
    errors: () => [...errors],
    reset: () => {
      resolved.clear()
      errors.length = 0
      totals.down = 0
      totals.up = 0
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
