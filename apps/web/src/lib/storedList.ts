import { listAllowancesResponseSchema } from '@cancelchain/shared'
import { z } from 'zod'
import { browserStorage } from '../chain/wallet.js'
import type { ListAllowancesResponse } from './api.js'
import type { AllowanceList } from './source.js'
import type { AllowanceView } from './view.js'

/**
 * This browser's copy of a wallet's last list (`SC-008`): what the dashboard
 * shows first for a returning wallet, before the network has answered. The
 * network's answer replaces it, and the screen says which of the two it shows.
 *
 * The raw response is kept, not the screen model: the model is computed with the
 * moment of reading (`periodElapsed`), and recomputing it from `syncedAt` keeps
 * the copy judged by the clock it was read with.
 */

export const STORED_LIST_PREFIX = 'cancelchain:allowances:'

/** Bumped when the stored shape changes; an older copy is then no copy. */
const storedListSchema = z.object({
  version: z.literal(1),
  response: listAllowancesResponseSchema,
})

export type ListStore = {
  read(owner: string): ListAllowancesResponse | null
  save(owner: string, response: ListAllowancesResponse): void
  /** Every wallet's copy: disconnecting is asking this browser to stop showing it. */
  clear(): void
}

/** Storage may be missing or throw on any call (private mode, blocked site data): no copy, no failure. */
export function createListStore(storage: Storage | null): ListStore {
  const key = (owner: string) => `${STORED_LIST_PREFIX}${owner}`
  const remove = (name: string) => {
    try {
      storage?.removeItem(name)
    } catch {
      // Nothing to forget in a storage that cannot be read.
    }
  }
  return {
    read(owner) {
      let raw: string | null
      try {
        raw = storage?.getItem(key(owner)) ?? null
      } catch {
        return null
      }
      if (raw === null) return null
      try {
        const parsed = storedListSchema.safeParse(JSON.parse(raw))
        if (parsed.success) return parsed.data.response
      } catch {
        // Not JSON — the same as any other copy that does not parse.
      }
      remove(key(owner))
      return null
    },
    save(owner, response) {
      try {
        storage?.setItem(key(owner), JSON.stringify({ version: 1, response }))
      } catch {
        // A full or blocked storage costs the next visit its head start, nothing more.
      }
    },
    clear() {
      let names: string[] = []
      try {
        if (storage !== null) {
          for (let index = 0; index < storage.length; index += 1) {
            const name = storage.key(index)
            if (name?.startsWith(STORED_LIST_PREFIX)) names.push(name)
          }
        }
      } catch {
        names = []
      }
      for (const name of names) remove(name)
    },
  }
}

export const storedLists = createListStore(browserStorage())

/** How the network's list differs from the saved copy that was on screen before it. */
export type ListDivergence = { added: number; gone: number; changed: number }

/** What a person reads off a card; `lastSlot` and the read time move without anything changing. */
function fingerprint(view: AllowanceView): string {
  return JSON.stringify([
    view.status,
    view.cap.amount.toString(),
    view.used?.amount.toString() ?? null,
    view.nextCharge?.getTime() ?? null,
    view.endsOn?.getTime() ?? null,
    view.expiresOn?.getTime() ?? null,
  ])
}

export function listDivergence(saved: AllowanceList, fresh: AllowanceList): ListDivergence {
  const before = new Map(saved.items.map((view) => [view.id, fingerprint(view)]))
  let added = 0
  let changed = 0
  for (const view of fresh.items) {
    const was = before.get(view.id)
    if (was === undefined) added += 1
    else if (was !== fingerprint(view)) changed += 1
    before.delete(view.id)
  }
  return { added, gone: before.size, changed }
}
