import type { Address } from '@cancelchain/shared'

/**
 * The oldest slot the next read of a list or a card may answer from (`T042a`).
 *
 * `allowance.updated` says the store already holds a change at `lastSlot`, and
 * the re-read it triggers goes to the network (`FR-024`). A node behind that
 * slot would answer with the state before the change — a cancelled permission
 * back on the list as active — and no later message would correct it
 * (`SC-009`). So the read carries the slot as a floor, and the API makes the
 * node refuse anything older.
 *
 * Kept apart from the query keys on purpose: the floor says how fresh a read
 * must be, not which data it is, and a key that changed with every message
 * would leave a trail of dead cache entries behind each one.
 */
export interface SlotFloors {
  /** Floor for the list of one wallet: the newest change seen among its permissions. */
  list(owner: Address): number | undefined
  /** Floor for one permission's card. */
  card(pda: string): number | undefined
  /** A change at `lastSlot` was stored; reads of its list and card start there. Never lowers. */
  raise(change: { owner: Address; pda: string; lastSlot: number }): void
}

export function createSlotFloors(): SlotFloors {
  const lists = new Map<Address, number>()
  const cards = new Map<string, number>()
  const lift = <K>(floors: Map<K, number>, key: K, slot: number) => {
    if ((floors.get(key) ?? -1) < slot) floors.set(key, slot)
  }
  return {
    list: (owner) => lists.get(owner),
    card: (pda) => cards.get(pda),
    raise({ owner, pda, lastSlot }) {
      lift(lists, owner, lastSlot)
      lift(cards, pda, lastSlot)
    },
  }
}

/** The application's floors: one per page load, like `source`. */
export const slotFloors = createSlotFloors()
