import { describe, expect, it } from 'vitest'
import { type DemoSnapshot, demoSnapshotSchema } from './snapshot.js'

const OWNER = '5nhMcYQg8oUDvrAoVALzRYHbFkBjn8H76noiUMAWCy7a'
const MERCHANT = 'FGHMNoGvR5zP9K5Cs4XrwZhQnAxNrFEQYH3TK22fBkKF'
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const SIGNATURE =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'

const SNAPSHOT: DemoSnapshot = {
  version: 1,
  cluster: 'devnet',
  recordedAt: '2026-10-18T10:00:00.000Z',
  apiUrl: 'https://cancelchain-api.onrender.com',
  owner: OWNER,
  merchant: MERCHANT,
  mint: MINT,
  steps: [
    {
      stage: 'before',
      label: 'Permission granted',
      signer: 'owner',
      signature: SIGNATURE,
      outcome: 'confirmed',
      refusal: null,
    },
  ],
  stages: [
    {
      id: 'before',
      title: 'Before cancelling',
      summary: 'Two permissions.',
      recordedAt: '2026-10-18T10:00:00.000Z',
      responses: {
        [`/v1/allowances?owner=${OWNER}`]: { status: 200, body: { items: [] } },
        [`/v1/allowances/${OWNER}`]: { status: 404, body: { error: { code: 'NOT_FOUND' } } },
      },
    },
  ],
}

describe('demoSnapshotSchema', () => {
  it('accepts a recording', () => {
    expect(demoSnapshotSchema.parse(SNAPSHOT)).toEqual(SNAPSHOT)
  })

  it('refuses anything but devnet', () => {
    expect(demoSnapshotSchema.safeParse({ ...SNAPSHOT, cluster: 'mainnet-beta' }).success).toBe(
      false,
    )
  })

  it('refuses a step that leads to a stage the recording does not have', () => {
    const steps = [{ ...SNAPSHOT.steps[0], stage: 'after' }]
    expect(demoSnapshotSchema.safeParse({ ...SNAPSHOT, steps }).success).toBe(false)
  })

  it('refuses two stages with one id', () => {
    const stage = SNAPSHOT.stages[0]
    expect(demoSnapshotSchema.safeParse({ ...SNAPSHOT, stages: [stage, stage] }).success).toBe(
      false,
    )
  })

  it('names a refusal exactly when the step was refused', () => {
    const step = SNAPSHOT.steps[0]
    const unnamed = [{ ...step, outcome: 'refused', refusal: null }]
    const named = [{ ...step, outcome: 'confirmed', refusal: 'InvalidAccountOwner' }]
    const refused = [{ ...step, outcome: 'refused', refusal: 'InvalidAccountOwner' }]
    expect(demoSnapshotSchema.safeParse({ ...SNAPSHOT, steps: unnamed }).success).toBe(false)
    expect(demoSnapshotSchema.safeParse({ ...SNAPSHOT, steps: named }).success).toBe(false)
    expect(demoSnapshotSchema.safeParse({ ...SNAPSHOT, steps: refused }).success).toBe(true)
  })

  it('refuses a recorded path outside /v1', () => {
    const stages = [{ ...SNAPSHOT.stages[0], responses: { '/health': { status: 200, body: {} } } }]
    expect(demoSnapshotSchema.safeParse({ ...SNAPSHOT, stages }).success).toBe(false)
  })

  it('refuses a recorded response without a body', () => {
    // The replay would answer with an empty body, and the client would call it a broken contract.
    const stages = [{ ...SNAPSHOT.stages[0], responses: { '/v1/x': { status: 200 } } }]
    expect(demoSnapshotSchema.safeParse({ ...SNAPSHOT, stages }).success).toBe(false)
  })
})
