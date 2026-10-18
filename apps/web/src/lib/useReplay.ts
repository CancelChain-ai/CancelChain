import type { DemoSnapshot } from '@cancelchain/shared/snapshot'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { currentStage, loadDemoSnapshot, replayStage } from './replay.js'
import { source } from './source.js'

export type ReplayState = {
  snapshot: DemoSnapshot
  stageId: string
  /** Shows another stage of the recording: every screen reads it again. */
  showStage(id: string): void
} | null

/**
 * The recording behind a replay (`T058`), and the stage the screens show. `null`
 * when the source is not a recording, or the recording is still loading.
 */
export function useReplay(): ReplayState {
  const queryClient = useQueryClient()
  const recorded = source.provenance === 'recorded'
  const { data } = useQuery({
    queryKey: ['replay'],
    queryFn: loadDemoSnapshot,
    enabled: recorded,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const [stageId, setStageId] = useState<string | null>(replayStage.get)

  if (!recorded || data === undefined) return null
  return {
    snapshot: data,
    stageId: stageId ?? currentStage(data, replayStage).id,
    showStage(id) {
      replayStage.set(id)
      setStageId(id)
      // Every key is `[family, source.kind, …]`; the recording itself is not one of them.
      void queryClient.resetQueries({ predicate: (query) => query.queryKey[1] === source.kind })
    },
  }
}
