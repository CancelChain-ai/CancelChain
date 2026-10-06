import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `public/sw.js` (`T043`) run as it ships — the file itself, not a copy of its
 * logic — against a fake `self`. The worker is plain JavaScript in `public/`
 * because Vite copies that verbatim to the root of the base path, where the
 * scope must start.
 */
const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8')
const SCOPE = 'https://cancelchain-ai.github.io/CancelChain/'
const PDA = 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2'

type Listener = (event: unknown) => void
type Shown = { title: string; options: { body?: string; tag?: string; data?: unknown } }
type FakeClient = { url: string; navigated: string[]; focused: number; controlled: boolean }

function worker(clients: FakeClient[] = []) {
  const listeners = new Map<string, Listener>()
  const shown: Shown[] = []
  const opened: string[] = []
  const self = {
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    registration: {
      scope: SCOPE,
      showNotification: async (title: string, options: Shown['options']) => {
        shown.push({ title, options })
      },
    },
    clients: {
      matchAll: async () =>
        clients.map((client) => ({
          url: client.url,
          focus: async () => {
            client.focused += 1
          },
          navigate: async (url: string) => {
            if (!client.controlled) throw new TypeError('not controlled')
            client.navigated.push(url)
          },
        })),
      openWindow: async (url: string) => {
        opened.push(url)
      },
      claim: async () => {},
    },
    skipWaiting: () => {},
  }
  new Function('self', SOURCE)(self)

  async function fire(name: string, event: Record<string, unknown>) {
    const pending: Promise<unknown>[] = []
    listeners.get(name)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    })
    await Promise.all(pending)
  }

  return {
    shown,
    opened,
    push: (data: unknown) =>
      fire('push', {
        data:
          data === null
            ? null
            : {
                json: () => {
                  if (typeof data === 'string') return JSON.parse(data)
                  return data
                },
              },
      }),
    click: (data: unknown) =>
      fire('notificationclick', { notification: { data, close: () => {} } }),
  }
}

describe('push', () => {
  it('shows the text it was sent, with the moment in the browser clock', async () => {
    const sw = worker()
    const at = '2026-10-07T12:00:00.000Z'
    await sw.push({
      kind: 'upcoming',
      title: 'Charge due {at}',
      body: 'Merchant plan EwH6…M2mg may take up to 10.00 USDC.',
      at,
      allowance: PDA,
      tag: `upcoming:${PDA}`,
    })

    const local = new Date(at)
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]
    const clock = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`
    expect(sw.shown).toEqual([
      {
        title: `Charge due ${local.getDate()} ${months[local.getMonth()]}, ${clock}`,
        options: {
          body: 'Merchant plan EwH6…M2mg may take up to 10.00 USDC.',
          tag: `upcoming:${PDA}`,
          data: { allowance: PDA },
        },
      },
    ])
  })

  it.each([
    ['no payload', null],
    ['a payload that is not JSON', 'not json'],
    ['a payload without text', { kind: 'upcoming' }],
  ])('still shows something for %s — a push must', async (_, data) => {
    const sw = worker()
    await sw.push(data)
    expect(sw.shown).toHaveLength(1)
    expect(sw.shown[0]?.title).toBe('CancelChain')
  })

  it('takes no address it would not open', async () => {
    const sw = worker()
    await sw.push({ title: 't', body: 'b', at: null, allowance: 'javascript:alert(1)', tag: 'x' })
    expect(sw.shown[0]?.options.data).toEqual({ allowance: null })
  })
})

describe('notificationclick', () => {
  it('opens the card of the permission under the app scope', async () => {
    const sw = worker()
    await sw.click({ allowance: PDA })
    expect(sw.opened).toEqual([`${SCOPE}?allowance=${PDA}`])
  })

  it('opens the app itself for a push about no permission', async () => {
    const sw = worker()
    await sw.click({ allowance: null })
    expect(sw.opened).toEqual([SCOPE])
  })

  it('reuses a tab of the app that is already open', async () => {
    const tab: FakeClient = { url: `${SCOPE}`, navigated: [], focused: 0, controlled: true }
    const sw = worker([
      { url: 'https://elsewhere.example/', navigated: [], focused: 0, controlled: true },
      tab,
    ])
    await sw.click({ allowance: PDA })
    expect(tab.navigated).toEqual([`${SCOPE}?allowance=${PDA}`])
    expect(tab.focused).toBe(1)
    expect(sw.opened).toEqual([])
  })

  it('opens a new tab when the open one is not the worker’s to steer', async () => {
    const tab: FakeClient = { url: `${SCOPE}`, navigated: [], focused: 0, controlled: false }
    const sw = worker([tab])
    await sw.click({ allowance: PDA })
    expect(sw.opened).toEqual([`${SCOPE}?allowance=${PDA}`])
  })
})
