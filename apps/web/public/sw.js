/**
 * CancelChain's service worker: Web Push (`T043`) and the app's own files (`SC-008`).
 *
 * The cache holds the page and its `assets/` — never an answer of the API, which
 * lives on another origin and is not touched here. A returning visit gets the app
 * from this cache at once and asks the network for a newer one behind it; the
 * permissions on screen come from the page's own saved copy, which says it is
 * one (`lib/storedList.ts`), until the network answers.
 *
 * The text arrives written (`packages/push/src/messages.ts`); the one thing the
 * server cannot write is the reader's clock, so `{at}` in the title or the body
 * is replaced here with `at` in this browser's time zone — the card's own
 * format, "28 Oct, 19:07".
 *
 * A click opens the permission's card: `?allowance=<pda>` under this worker's
 * scope, in a tab that is already open when there is one.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const AT_TOKEN = '{at}'
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function dayAndClock(date) {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${date.getDate()} ${MONTHS[date.getMonth()]}, ${hours}:${minutes}`
}

function fill(text, at) {
  if (typeof text !== 'string') return null
  if (!text.includes(AT_TOKEN)) return text
  const date = typeof at === 'string' ? new Date(at) : null
  const when = date === null || Number.isNaN(date.getTime()) ? 'soon' : dayAndClock(date)
  return text.split(AT_TOKEN).join(when)
}

/** The push as a notification, or a plain one: a push must show something. */
function notificationOf(data) {
  let message = null
  try {
    message = data === null ? null : data.json()
  } catch {
    message = null
  }
  const title = message === null ? null : fill(message.title, message.at)
  const body = message === null ? null : fill(message.body, message.at)
  if (title === null || body === null) {
    return {
      title: 'CancelChain',
      options: { body: 'Something changed on a permission of yours. Open CancelChain to see it.' },
    }
  }
  const allowance =
    typeof message.allowance === 'string' && ADDRESS.test(message.allowance)
      ? message.allowance
      : null
  return {
    title,
    options: {
      body,
      ...(typeof message.tag === 'string' ? { tag: message.tag } : {}),
      data: { allowance },
    },
  }
}

function openUrl(scope, allowance) {
  const url = new URL(scope)
  if (allowance !== null) url.searchParams.set('allowance', allowance)
  return url.href
}

self.addEventListener('push', (event) => {
  const { title, options } = notificationOf(event.data)
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data
  const allowance = data !== null && typeof data === 'object' ? (data.allowance ?? null) : null
  const target = openUrl(self.registration.scope, allowance)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((client) => client.url.startsWith(self.registration.scope))
      if (open !== undefined) {
        try {
          // `navigate` refuses a tab this worker does not control yet.
          await open.navigate(target)
          await open.focus()
          return
        } catch {
          // Falls through to a new tab.
        }
      }
      await self.clients.openWindow(target)
    })(),
  )
})

const SHELL_CACHE = 'cancelchain-shell-v1'

/** The files a page names under the worker's `assets/`: its script, preloads and stylesheet. */
function assetsOf(html, scope) {
  const found = new Set()
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(match[1], scope).href
    if (url.startsWith(`${scope}assets/`)) found.add(url)
  }
  return [...found]
}

/**
 * The page goes into the cache only with every file it names: a cached page
 * whose script is missing is a blank screen. A new page also drops the files of
 * the old one; a lazily loaded file of the new one is fetched again when asked for.
 */
async function storeShell(response) {
  const scope = self.registration.scope
  const cache = await caches.open(SHELL_CACHE)
  const html = await response.clone().text()
  const assets = assetsOf(html, scope)
  for (const url of assets) {
    if ((await cache.match(url)) === undefined) await cache.add(url)
  }
  const previous = await cache.match(scope)
  await cache.put(scope, response)
  if (previous !== undefined && (await previous.text()) !== html) {
    for (const request of await cache.keys()) {
      if (request.url !== scope && !assets.includes(request.url)) await cache.delete(request)
    }
  }
}

async function refreshShell() {
  const response = await fetch(self.registration.scope, { cache: 'no-cache' })
  if (response.ok) await storeShell(response)
}

function quietly(promise) {
  return promise.catch(() => {})
}

async function shellResponse(event) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(self.registration.scope)
  if (cached !== undefined) {
    // Seen on the next visit: this one is already drawing the cached version.
    event.waitUntil(quietly(refreshShell()))
    return cached
  }
  const response = await fetch(event.request)
  if (response.ok) event.waitUntil(quietly(storeShell(response.clone())))
  return response
}

/** Built files carry their hash in the name, so a cached one is never out of date. */
async function assetResponse(request) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request.url)
  if (cached !== undefined) return cached
  const response = await fetch(request)
  if (response.ok) await quietly(cache.put(request.url, response.clone()))
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const scope = self.registration.scope
  if (request.method !== 'GET' || !request.url.startsWith(scope)) return
  const url = new URL(request.url)
  if (request.mode === 'navigate' && `${url.origin}${url.pathname}` === scope) {
    event.respondWith(shellResponse(event))
  } else if (url.pathname.startsWith(new URL(`${scope}assets/`).pathname)) {
    event.respondWith(assetResponse(request))
  }
})

self.addEventListener('install', (event) => {
  // The first visit is already drawn from the network; this readies the next one.
  event.waitUntil(quietly(refreshShell()))
  self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('cancelchain-') && name !== SHELL_CACHE) await caches.delete(name)
      }
      await self.clients.claim()
    })(),
  )
})
