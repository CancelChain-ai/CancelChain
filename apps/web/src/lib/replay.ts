import type { DemoSnapshot, SnapshotStage } from '@cancelchain/shared/snapshot'
import type { FetchLike } from './api.js'

/**
 * The recorded demo (`T058`): what the deployed API answered at each stage of
 * the scenario on devnet, replayed when devnet is too unstable to show live.
 *
 * The recording is answers to `/v1` requests, so the app reads it through the
 * same client, the same Zod schemas and the same model as the live API — a
 * screen cannot show anything the API did not say. What it is never allowed to
 * do is pass for live: the source says `recorded`, and every screen says so.
 */

export type SnapshotLoader = () => Promise<DemoSnapshot>

let loaded: Promise<DemoSnapshot> | null = null

/**
 * The file `pnpm --filter @cancelchain/e2e demo capture` writes. A dynamic
 * import: a build reading the live API never downloads it, and the first-screen
 * budget never counts it.
 */
export const loadDemoSnapshot: SnapshotLoader = () => {
  loaded ??= import('./recording.js').then((module) => module.recording())
  return loaded
}

/** Which stage the screens replay. `null` — the first one. Changed by the person presenting. */
export function createStageStore() {
  let current: string | null = null
  return {
    get: (): string | null => current,
    set(id: string): void {
      current = id
    },
  }
}
export type StageStore = ReturnType<typeof createStageStore>

export const replayStage = createStageStore()

export function currentStage(snapshot: DemoSnapshot, store: StageStore): SnapshotStage {
  const id = store.get()
  const stage = snapshot.stages.find((candidate) => candidate.id === id) ?? snapshot.stages[0]
  // The schema refuses a recording without stages.
  if (stage === undefined) throw new Error('the recording has no stages')
  return stage
}

/**
 * A request the recording has no answer for. It fails like an unreachable API —
 * there is nothing to say about it but that it was not recorded — and the web
 * test over the committed recording keeps the screens' requests inside it.
 */
export class NotRecordedError extends Error {
  constructor(path: string) {
    super(`${path} is not in the recording`)
    this.name = 'NotRecordedError'
  }
}

/** The path and query of a request URL the client built with an empty base. */
function pathOf(url: string): string {
  const parsed = new URL(url, 'http://recording')
  return `${parsed.pathname}${parsed.search}`
}

export function replayFetch(load: SnapshotLoader, store: StageStore): FetchLike {
  return async (url) => {
    const stage = currentStage(await load(), store)
    const path = pathOf(url)
    const recorded = stage.responses[path]
    if (recorded === undefined) throw new NotRecordedError(path)
    return new Response(JSON.stringify(recorded.body), {
      status: recorded.status,
      headers: { 'content-type': 'application/json' },
    })
  }
}
