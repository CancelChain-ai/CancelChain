import { type DemoSnapshot, demoSnapshotSchema } from '@cancelchain/shared/snapshot'
import recorded from '../../../../tests/fixtures/demo-snapshot.json'

/**
 * The committed recording (`T058`), checked by the schema it was written with.
 * A module of its own so that only a replay downloads the file and the parser —
 * the live first screen carries neither (`SC-008`).
 */
export function recording(): DemoSnapshot {
  return demoSnapshotSchema.parse(recorded)
}
