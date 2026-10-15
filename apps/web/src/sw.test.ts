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

type Served = Record<string, { status: number; body: string }>

/** `caches` in memory: one map per cache name, keyed by URL. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>()
  const open = async (name: string) => {
    let store = stores.get(name)
    if (store === undefined) {
      store = new Map()
      stores.set(name, store)
    }
    const entries = store
    return {
      match: async (url: string) => entries.get(url)?.clone(),
      put: async (url: string, response: Response) => void entries.set(url, response),
      add: async (url: string) => {
        const response = await serve(url)
        if (!response.ok) throw new TypeError(`${url}: ${response.status}`)
        entries.set(url, response)
      },
      keys: async () => [...entries.keys()].map((url) => ({ url })),
      delete: async (request: { url: string }) => entries.delete(request.url),
    }
  }
  let serve: (url: string) => Promise<Response> = async () => new Response(null, { status: 404 })
  return {
    stores,
    api: {
      open,
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    setNetwork: (network: (url: string) => Promise<Response>) => {
      serve = network
    },
  }
}

function worker(clients: FakeClient[] = [], served: Served = {}) {
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
  const fetched: string[] = []
  const network = async (input: string | { url: string }) => {
    const url = typeof input === 'string' ? input : input.url
    fetched.push(url)
    const page = served[url]
    return page === undefined
      ? new Response(null, { status: 404 })
      : new Response(page.body, { status: page.status })
  }
  const caches = fakeCaches()
  caches.setNetwork(network)
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches.api, network)

  async function fire(name: string, event: Record<string, unknown>) {
    const pending: Promise<unknown>[] = []
    listeners.get(name)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    })
    await Promise.all(pending)
  }

  /** A request as the page would make it; `null` — the worker left it to the network. */
  async function request(url: string, mode: 'navigate' | 'cors' = 'navigate', method = 'GET') {
    const answered: { response: Promise<Response> | null } = { response: null }
    const pending: Promise<unknown>[] = []
    listeners.get('fetch')?.({
      request: { url, mode, method },
      respondWith: (response: Promise<Response>) => {
        answered.response = response
      },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    })
    const response = answered.response === null ? null : await answered.response
    // Background refreshes queued while answering, and the ones they queue.
    for (let i = 0; i < pending.length; i += 1) await pending[i]
    return response === null ? null : { status: response.status, body: await response.text() }
  }

  return {
    shown,
    opened,
    fetched,
    caches,
    served,
    request,
    install: () => fire('install', {}),
    activate: () => fire('activate', {}),
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

describe('the app shell (SC-008)', () => {
  const page = (script: string) =>
    `<!doctype html><script type="module" src="/CancelChain/assets/${script}"></script>` +
    `<link rel="stylesheet" href="/CancelChain/assets/index.css"><link rel="icon" href="data:x">`
  const asset = (name: string) => `${SCOPE}assets/${name}`

  function deployed(script: string): Served {
    return {
      [SCOPE]: { status: 200, body: page(script) },
      [asset(script)]: { status: 200, body: `// ${script}` },
      [asset('index.css')]: { status: 200, body: 'body{}' },
    }
  }

  it('readies the next visit on install: the page with every file it names', async () => {
    const sw = worker([], deployed('index-A.js'))
    await sw.install()
    const shell = sw.caches.stores.get('cancelchain-shell-v1')
    expect([...(shell?.keys() ?? [])].sort()).toEqual(
      [SCOPE, asset('index-A.js'), asset('index.css')].sort(),
    )
  })

  it('answers a returning visit from the cache, whatever the query, and re-reads behind it', async () => {
    const sw = worker([], deployed('index-A.js'))
    await sw.install()
    sw.fetched.length = 0

    const answered = await sw.request(`${SCOPE}?plan=${PDA}`)
    expect(answered?.body).toBe(page('index-A.js'))
    expect(sw.fetched).toEqual([SCOPE])

    expect(await sw.request(asset('index-A.js'), 'cors')).toEqual({
      status: 200,
      body: '// index-A.js',
    })
    expect(sw.fetched).toEqual([SCOPE])
  })

  it('switches to a new deploy only with all its files, and drops the old ones', async () => {
    const sw = worker([], deployed('index-A.js'))
    await sw.install()
    Object.assign(sw.served, deployed('index-B.js'))
    delete sw.served[asset('index-A.js')]

    // This visit still draws the version it has; the next one gets the new.
    expect((await sw.request(SCOPE))?.body).toBe(page('index-A.js'))
    expect((await sw.request(SCOPE))?.body).toBe(page('index-B.js'))
    const shell = sw.caches.stores.get('cancelchain-shell-v1')
    expect([...(shell?.keys() ?? [])].sort()).toEqual(
      [SCOPE, asset('index-B.js'), asset('index.css')].sort(),
    )
  })

  it('keeps the old page when a file of the new one cannot be fetched', async () => {
    const sw = worker([], deployed('index-A.js'))
    await sw.install()
    sw.served[SCOPE] = { status: 200, body: page('index-B.js') }

    await sw.request(SCOPE)
    expect((await sw.request(SCOPE))?.body).toBe(page('index-A.js'))
  })

  it('goes to the network the first time and caches what came back', async () => {
    const sw = worker([], deployed('index-A.js'))
    expect((await sw.request(SCOPE))?.body).toBe(page('index-A.js'))
    sw.fetched.length = 0
    expect((await sw.request(asset('index-A.js'), 'cors'))?.body).toBe('// index-A.js')
    expect(sw.fetched).toEqual([])
  })

  it('does not cache a failed answer', async () => {
    const sw = worker([], { [SCOPE]: { status: 503, body: 'down' } })
    expect((await sw.request(SCOPE))?.status).toBe(503)
    expect(sw.caches.stores.get('cancelchain-shell-v1')?.size ?? 0).toBe(0)
  })

  it.each([
    [
      'the API on its own origin',
      'https://cancelchain-api.onrender.com/v1/allowances?owner=x',
      'cors',
      'GET',
    ],
    ['a write', `${SCOPE}assets/index-A.js`, 'cors', 'POST'],
    ['the worker itself', `${SCOPE}sw.js`, 'cors', 'GET'],
    ['a page outside the scope', 'https://cancelchain-ai.github.io/', 'navigate', 'GET'],
  ] as const)('leaves %s to the network', async (_, url, mode, method) => {
    const sw = worker([], deployed('index-A.js'))
    expect(await sw.request(url, mode, method)).toBeNull()
  })

  it('drops the caches of an older worker on activate', async () => {
    const sw = worker()
    await sw.caches.api.open('cancelchain-shell-v0')
    await sw.caches.api.open('cancelchain-shell-v1')
    await sw.activate()
    expect([...sw.caches.stores.keys()]).toEqual(['cancelchain-shell-v1'])
  })
})
