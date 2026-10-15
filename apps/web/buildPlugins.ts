import { gzipSync } from 'node:zlib'
import type { HtmlTagDescriptor, Plugin } from 'vite'

/**
 * Two build-time guards of the first screen (`SC-008`).
 */

/**
 * `<link rel="preconnect">` to the API's origin, so DNS, TCP and TLS to it start
 * with the page instead of after the script runs — on 3G that is four round trips.
 * `crossorigin`: the list is a CORS request without credentials, and a connection
 * opened without the attribute would not be reused for it.
 *
 * `null` with no `VITE_API_URL`: the API is then the page's own origin, already open.
 */
export function preconnectTag(apiUrl: string | undefined): HtmlTagDescriptor | null {
  if (apiUrl === undefined || apiUrl === '' || !URL.canParse(apiUrl)) return null
  return {
    tag: 'link',
    attrs: { rel: 'preconnect', href: new URL(apiUrl).origin, crossorigin: '' },
    injectTo: 'head',
  }
}

export function preconnectToApi(): Plugin {
  let apiUrl: string | undefined
  return {
    name: 'cancelchain:preconnect-to-api',
    configResolved(config) {
      const value: unknown = config.env.VITE_API_URL
      apiUrl = typeof value === 'string' ? value : undefined
    },
    transformIndexHtml() {
      const tag = preconnectTag(apiUrl)
      return tag === null ? [] : [tag]
    },
  }
}

/**
 * The JavaScript a visit downloads before the first screen: the entry chunk and
 * every chunk it imports statically. Lazily loaded screens are not counted — the
 * list never waits for them.
 */
export type BuiltChunk = {
  type: 'chunk'
  fileName: string
  isEntry: boolean
  imports: string[]
  code: string
}

export function initialJsBytes(bundle: Record<string, BuiltChunk | { type: 'asset' }>): {
  bytes: number
  files: string[]
} {
  const chunks = new Map<string, BuiltChunk>()
  for (const output of Object.values(bundle)) {
    if (output.type === 'chunk') chunks.set(output.fileName, output)
  }
  const files = new Set<string>()
  const visit = (chunk: BuiltChunk) => {
    if (files.has(chunk.fileName)) return
    files.add(chunk.fileName)
    for (const name of chunk.imports) {
      const imported = chunks.get(name)
      if (imported !== undefined) visit(imported)
    }
  }
  for (const chunk of chunks.values()) if (chunk.isEntry) visit(chunk)
  let bytes = 0
  for (const name of files) bytes += gzipSync(chunks.get(name)?.code ?? '').length
  return { bytes, files: [...files].sort() }
}

/**
 * Fails the build when the first screen's JavaScript outgrows the budget. A
 * dependency that slips into the entry chunk is found here, not by the next
 * `SC-008` run on the deployed site.
 */
export function bundleBudget(maxGzipBytes: number): Plugin {
  return {
    name: 'cancelchain:bundle-budget',
    apply: 'build',
    generateBundle(_, bundle) {
      const { bytes, files } = initialJsBytes(bundle)
      if (bytes > maxGzipBytes) {
        this.error(
          `the first screen's JavaScript is ${bytes} bytes gzipped (${files.join(', ')}), ` +
            `over the budget of ${maxGzipBytes}. Load what the list does not need lazily, ` +
            'or raise the budget in vite.config.ts with the reason',
        )
      }
    },
  }
}
