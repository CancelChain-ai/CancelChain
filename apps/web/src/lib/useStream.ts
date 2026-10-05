import type { Address } from '@cancelchain/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { streamUrl } from './api.js'
import { slotFloors } from './slotFloors.js'
import { apiBaseUrlFromEnv, source } from './source.js'
import { type EventSourceLike, openStream, type StreamStatus } from './stream.js'
import { createStreamCache } from './streamCache.js'

/**
 * Live updates for the connected wallet (`T042a`, `FR-024`, `SC-006`,
 * `SC-009`): the stream of `/v1/stream` turned into re-reads of the list, the
 * card and the feed (`streamCache.ts`).
 *
 * `off` — there is nothing to stream: no wallet, or no network behind the
 * source (the M0 mock). It is not a failure, and the screen says nothing then.
 */
export type LiveState = StreamStatus | 'off'

const defaultCreate = (url: string): EventSourceLike => new EventSource(url)

export function useStream(
  owner: Address | null,
  create: (url: string) => EventSourceLike = defaultCreate,
): LiveState {
  const queryClient = useQueryClient()
  const enabled = source.onNetwork && owner !== null
  const [status, setStatus] = useState<StreamStatus>('connecting')

  useEffect(() => {
    if (!source.onNetwork || owner === null) return
    const cache = createStreamCache({ queryClient, kind: source.kind, owner, floors: slotFloors })
    const close = openStream({
      url: streamUrl(apiBaseUrlFromEnv(import.meta.env), owner),
      create,
      onMessage: cache.push,
      onStatus: setStatus,
    })
    return () => {
      close()
      cache.cancel()
    }
  }, [owner, queryClient, create])

  return enabled ? status : 'off'
}
