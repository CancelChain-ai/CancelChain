import { type DemoSnapshot, demoSnapshotSchema } from '@cancelchain/shared/snapshot'
import { describe, expect, it } from 'vitest'
import recording from '../../../../tests/fixtures/demo-snapshot.json'
import { createApiClient } from './api'
import {
  createStageStore,
  currentStage,
  loadDemoSnapshot,
  NotRecordedError,
  replayFetch,
} from './replay'
import { createSnapshotSource, REPLAY_MODE, sourceKindFromEnv } from './source'

const OWNER = '5nhMcYQg8oUDvrAoVALzRYHbFkBjn8H76noiUMAWCy7a'
const PDA = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const SIGNATURE =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
const AT = '2026-10-18T10:00:00.000Z'

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'no permission at this address' } }

function snapshot(): DemoSnapshot {
  return {
    version: 1,
    cluster: 'devnet',
    recordedAt: AT,
    apiUrl: 'https://cancelchain-api.onrender.com',
    owner: OWNER,
    merchant: OWNER,
    mint: OWNER,
    steps: [
      {
        stage: 'before',
        label: 'Granted',
        signer: 'owner',
        signature: SIGNATURE,
        outcome: 'confirmed',
        refusal: null,
      },
    ],
    stages: [
      {
        id: 'before',
        title: 'Before',
        summary: 'Before.',
        recordedAt: AT,
        responses: {
          [`/v1/allowances/${PDA}/signatures`]: {
            status: 200,
            body: { items: [], syncedAt: AT, more: false },
          },
        },
      },
      {
        id: 'after',
        title: 'After',
        summary: 'After.',
        recordedAt: AT,
        responses: { [`/v1/allowances/${PDA}/signatures`]: { status: 404, body: NOT_FOUND } },
      },
    ],
  }
}

describe('replayFetch', () => {
  const load = () => Promise.resolve(snapshot())

  it('answers a recorded path with its recorded status and body', async () => {
    const stage = createStageStore()
    const client = createApiClient('', replayFetch(load, stage))
    await expect(client.listSignatures(PDA)).resolves.toEqual({
      items: [],
      syncedAt: AT,
      more: false,
    })
  })

  it('answers from the stage the presenter chose', async () => {
    const stage = createStageStore()
    const client = createApiClient('', replayFetch(load, stage))
    stage.set('after')
    await expect(client.listSignatures(PDA)).rejects.toMatchObject({
      name: 'ApiRequestError',
      code: 'NOT_FOUND',
      status: 404,
    })
  })

  it('fails a request the recording has no answer for, instead of inventing one', async () => {
    const fetch = replayFetch(load, createStageStore())
    await expect(fetch(`/v1/allowances?owner=${OWNER}`)).rejects.toThrow(NotRecordedError)
  })

  it('starts at the first stage, and falls back to it for an unknown one', () => {
    const stage = createStageStore()
    expect(currentStage(snapshot(), stage).id).toBe('before')
    stage.set('gone')
    expect(currentStage(snapshot(), stage).id).toBe('before')
  })
})

describe('the replay build', () => {
  it('replays the recording in the replay mode, whatever the data source says', () => {
    expect(sourceKindFromEnv({ MODE: REPLAY_MODE, VITE_DATA_SOURCE: 'api' })).toBe('snapshot')
    expect(sourceKindFromEnv({ VITE_DATA_SOURCE: 'snapshot' })).toBe('snapshot')
    expect(sourceKindFromEnv({ MODE: 'production' })).toBe('api')
  })
})

/**
 * The committed recording, read the way the screens read it. A path the
 * screens ask for and the recording does not hold would fail at the show as an
 * unreachable API; here it fails before the commit.
 */
describe('the committed recording', () => {
  it('is a recording the schema accepts', () => {
    expect(demoSnapshotSchema.safeParse(recording).success).toBe(true)
  })

  it('answers every request the list and the cards make, at every stage', async () => {
    const snapshot = await loadDemoSnapshot()
    const stage = createStageStore()
    const source = createSnapshotSource(loadDemoSnapshot, stage)
    const pdas = new Set<string>()

    for (const recorded of snapshot.stages) {
      stage.set(recorded.id)
      const list = await source.listAllowances(null)
      for (const item of list.items) pdas.add(item.id)
      for (const pda of pdas) {
        await source.getAllowance(pda)
        await source.getHistory(pda)
        await source.getEvents(pda, null)
      }
    }
    expect(pdas.size).toBeGreaterThan(0)
  })

  it('shows the cancelled permission leaving the list and its card saying so', async () => {
    const snapshot = await loadDemoSnapshot()
    const stage = createStageStore()
    const source = createSnapshotSource(loadDemoSnapshot, stage)
    const [first, last] = [snapshot.stages[0], snapshot.stages.at(-1)]
    if (first === undefined || last === undefined) throw new Error('no stages')

    stage.set(first.id)
    const before = (await source.listAllowances(null)).items.map((item) => item.id)
    stage.set(last.id)
    const after = (await source.listAllowances(null)).items.map((item) => item.id)
    const cancelled = before.filter((pda) => !after.includes(pda))

    expect(cancelled).toHaveLength(1)
    const [pda] = cancelled
    if (pda === undefined) throw new Error('unreachable')
    expect((await source.getAllowance(pda))?.status).toBe('revoked')
    const feed = await source.getEvents(pda, null)
    expect(feed?.events.map((event) => event.kind)).toEqual(['rejected', 'revoked', 'created'])
  })

  it('acts on nothing: no actions, no plans, no wallet, no copy kept', () => {
    const source = createSnapshotSource()
    expect(source.actions).toBeNull()
    expect(source.plans).toBeNull()
    expect(source.requiresWallet).toBe(false)
    expect(source.provenance).toBe('recorded')
    expect(source.storedList(OWNER)).toBeNull()
  })
})
