/**
 * The fallback for a lazy screen whose file is gone (`T063`): the page was drawn
 * from a version a deploy has since taken off the server, and the service worker
 * does not have the file either — the browser dropped its cache, or the worker
 * was not installed yet. One reload draws the version the server has now.
 *
 * Once per version: the entry script's URL carries the build's hash, and a
 * version that has already reloaded once and is still missing a file ends in
 * the screen's own error, not in a page that reloads itself forever. A later
 * deploy is another version and may reload again. Without session storage
 * there is no way to tell the second reload from the first, and there is none.
 */

export const RELOADED_FOR_KEY = 'cancelchain:reloaded-for-build'

export function reloadIsDue(storage: Storage | null, version: string): boolean {
  if (storage === null) return false
  try {
    if (storage.getItem(RELOADED_FOR_KEY) === version) return false
    storage.setItem(RELOADED_FOR_KEY, version)
    return true
  } catch {
    return false
  }
}

/** `null` where session storage is missing or throws on access. */
export function sessionStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : (window.sessionStorage ?? null)
  } catch {
    return null
  }
}

/**
 * Vite's own event for a failed lazy import; cancelling it is what keeps the
 * error from the screen. `version` — the entry script's `import.meta.url`.
 */
export function reloadOnStaleBuild(version: string, target: Window = window) {
  target.addEventListener('vite:preloadError', (event) => {
    if (!reloadIsDue(sessionStore(), version)) return
    event.preventDefault()
    target.location.reload()
  })
}
