/**
 * CancelChain's service worker — Web Push and nothing else (`T043`).
 *
 * No cache and no `fetch` handler: the page is read from the network every
 * time, as before, and nothing here can show a stale permission as current.
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

// A new version takes over at once: there is no cache to migrate.
self.addEventListener('install', () => {
  self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})
