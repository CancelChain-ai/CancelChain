import type { SnapshotStep } from '@cancelchain/shared/snapshot'
import { describe, expect, it } from 'vitest'
import { stepMismatches } from './verify.js'

const SIGNATURE =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'

const CONFIRMED: SnapshotStep = {
  stage: 'before',
  label: 'Granted',
  signer: 'owner',
  signature: SIGNATURE,
  outcome: 'confirmed',
  refusal: null,
}
const REFUSED: SnapshotStep = {
  ...CONFIRMED,
  label: 'Charged after cancelling',
  signer: 'merchant',
  outcome: 'refused',
  refusal: 'InvalidAccountOwner',
}

describe('stepMismatches', () => {
  it('is empty when the network agrees with every step', () => {
    expect(
      stepMismatches(
        [CONFIRMED, REFUSED],
        [{ err: null }, { err: { InstructionError: [0, 'InvalidAccountOwner'] } }],
      ),
    ).toEqual([])
  })

  it('names a transaction the network no longer knows', () => {
    expect(stepMismatches([CONFIRMED], [null])).toEqual([
      `Granted: the network does not know ${SIGNATURE}`,
    ])
  })

  it('names a refusal the network reports as confirmed, and the reverse', () => {
    expect(stepMismatches([REFUSED, CONFIRMED], [{ err: null }, { err: 'x' }])).toEqual([
      `Charged after cancelling: recorded as refused, the network says confirmed (${SIGNATURE})`,
      `Granted: recorded as confirmed, the network says refused (${SIGNATURE})`,
    ])
  })

  it('treats a missing status as unknown, not as confirmed', () => {
    expect(stepMismatches([CONFIRMED], [])).toHaveLength(1)
  })
})
