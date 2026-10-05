import type { Address, StreamMessage } from '@cancelchain/shared'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { SlotFloors } from './slotFloors.js'
import type { StreamTimers } from './stream.js'

/**
 * What each stream message does to the page's reads (`T042a`).
 *
 * Nothing from the stream is written into the cache. `allowance.updated`
 * carries the **stored** copy, and the network wins over the store (`FR-024`):
 * the message marks the list and the card stale, and they are read again from
 * the network — no older than the change, through `SlotFloors`. The feed comes
 * from the store anyway, but it too is read again rather than patched, so its
 * order and cursors stay with the one reader on the server.
 *
 * — `allowance.updated` → the wallet's list, that permission's card, and the
 *   plan screen when it is a subscription (it says "already subscribed");
 * — `event.appended` → that permission's feed;
 * — `ready`, `resync` → every read the stream speaks for;
 * — `ping` → nothing.
 *
 * Messages are gathered for `flushMs` before anything is read again: one
 * subscription is an insert of the permission and of its event within
 * milliseconds, and the list costs a `getProgramAccounts` on the node each time.
 */

export const STREAM_FLUSH_MS = 100

export type StreamCacheOptions = {
  queryClient: QueryClient
  /** `source.kind` — the first part of every key after the family. */
  kind: string
  owner: Address
  floors: SlotFloors
  flushMs?: number
  timers?: StreamTimers
}

/** The query families the stream speaks for, as in `allowancesKey`, `allowanceKey`, `feedKey`… */
const FAMILIES = ['allowances', 'allowance', 'feed', 'history', 'plan'] as const

export function createStreamCache(options: StreamCacheOptions) {
  const { queryClient, kind, owner, floors } = options
  const flushMs = options.flushMs ?? STREAM_FLUSH_MS
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle: unknown) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  }

  let everything = false
  let list = false
  let plans = false
  const cards = new Set<string>()
  const feeds = new Set<string>()
  let pending: unknown = null

  function flush() {
    pending = null
    const keys: QueryKey[] = everything
      ? FAMILIES.map((family) => [family, kind])
      : [
          ...(list ? [['allowances', kind, owner]] : []),
          ...[...cards].map((pda) => ['allowance', kind, pda]),
          ...[...feeds].map((pda) => ['feed', kind, pda]),
          ...(plans ? [['plan', kind]] : []),
        ]
    everything = list = plans = false
    cards.clear()
    feeds.clear()
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey })
  }

  return {
    push(message: StreamMessage): void {
      switch (message.type) {
        case 'ping':
          return
        case 'ready':
        case 'resync':
          everything = true
          break
        case 'allowance.updated': {
          const { allowance } = message
          floors.raise({ owner: allowance.owner, pda: allowance.pda, lastSlot: allowance.lastSlot })
          list = true
          cards.add(allowance.pda)
          if (allowance.kind === 'subscription') plans = true
          break
        }
        case 'event.appended':
          feeds.add(message.allowancePda)
          break
      }
      if (pending === null) pending = timers.setTimeout(flush, flushMs)
    },
    /** Drops whatever is waiting: the stream is closing with the page or the wallet. */
    cancel(): void {
      if (pending !== null) timers.clearTimeout(pending)
      pending = null
    },
  }
}
