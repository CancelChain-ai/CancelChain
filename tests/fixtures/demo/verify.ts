import type { SnapshotStep } from '@cancelchain/shared/snapshot'

/**
 * Whether the network still says what the recording says about each of its
 * transactions (`T058`). Run before a show: a recording whose signatures the
 * explorer no longer finds, or finds with another outcome, must not be shown.
 */

/** What `getSignatureStatuses` (with history) answers for one signature. */
export type StepStatus = { err: unknown } | null

export function stepMismatches(
  steps: readonly SnapshotStep[],
  statuses: readonly StepStatus[],
): string[] {
  return steps.flatMap((step, index) => {
    const status = statuses[index]
    if (status === undefined || status === null) {
      return [`${step.label}: the network does not know ${step.signature}`]
    }
    const refused = status.err !== null
    if (refused !== (step.outcome === 'refused')) {
      return [
        `${step.label}: recorded as ${step.outcome}, the network says ` +
          `${refused ? 'refused' : 'confirmed'} (${step.signature})`,
      ]
    }
    return []
  })
}
