import type { Address } from '@cancelchain/shared'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useRef } from 'react'
import { describeFailure } from './api.js'
import { slotFloors } from './slotFloors.js'
import { type AllowanceList, source } from './source.js'
import { type ListDivergence, listDivergence } from './storedList.js'

/**
 * Список дозволів для екрана. Стан запиту приводиться до скінченного переліку
 * випадків, кожен з яких екран мусить показати **по-різному**:
 *
 * — `no-wallet`: питати нема про кого. Це не порожній список;
 * — `loading`: ще не знаємо;
 * — `error`: не змогли прочитати. Порожній екран тут — брехня (`FR-022`);
 * — `ready`: прочитали. Порожньо означає «дозволів немає».
 *
 * Різницю між «нічого не запущено» і «нічого не завантажилося» продукт
 * зобов'язаний тримати видимою: на ній стоїть уся його користь.
 */
export type AllowancesState =
  | { status: 'no-wallet' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      list: AllowanceList
      refreshing: boolean
      /**
       * Перечитка **поверх наявного списку** не вдалася. Показувати старий
       * список і мовчати про це не можна: людина дивилася б на стан, який ми
       * вже не підтверджуємо, і не знала б цього.
       */
      refreshFailed: string | null
      /**
       * The list on screen is this browser's copy from an earlier visit
       * (`SC-008`): no network has confirmed it yet on this one.
       */
      savedCopy: boolean
      /**
       * How the network's answer differed from the copy shown before it, counted
       * once, when it replaced the copy. `null` — no copy was shown, the network
       * has not answered yet, or it answered with exactly the copy.
       */
      sinceSavedCopy: { savedAt: string; divergence: ListDivergence } | null
    }

/** Мітка стану моку: демо змінює його кліками, і список мусить це побачити. */
export function allowancesKey(owner: Address | null, revision: number): readonly unknown[] {
  return ['allowances', source.kind, owner, revision]
}

/**
 * Свіжість. Стан мережі має пріоритет над сховищем, тож список не тримається
 * довго: `staleTime` нульовий, і повернення на вкладку перечитує його. Своєї
 * періодичної перечитки тут немає навмисно: її місце займає потік (`useStream`,
 * `T042a`), а полінг лише швидше з'їдає квоту публічного вузла.
 */
const RETRY_ATTEMPTS = 1

export function useAllowances(owner: Address | null, revision = 0): AllowancesState {
  const needsWallet = source.requiresWallet && owner === null
  /** Read once per wallet: the copy on screen at open, not whatever was saved since. */
  const saved = useMemo(() => (owner === null ? null : source.storedList(owner)), [owner])
  const divergence = useRef<{
    saved: AllowanceList
    since: { savedAt: string; divergence: ListDivergence } | null
  } | null>(null)

  const query = useQuery({
    queryKey: allowancesKey(owner, revision),
    // The floor is read when the request goes out, not when the key is built (`slotFloors.ts`).
    queryFn: ({ signal }) =>
      source.listAllowances(owner, signal, owner === null ? undefined : slotFloors.list(owner)),
    enabled: !needsWallet,
    // Dated by its own read, so the copy is stale at once and the network is asked anyway.
    ...(saved === null
      ? {}
      : { initialData: saved, initialDataUpdatedAt: Date.parse(saved.syncedAt) }),
    staleTime: 0,
    retry: RETRY_ATTEMPTS,
  })

  if (needsWallet) return { status: 'no-wallet' }
  if (query.data !== undefined) {
    const savedCopy = saved !== null && query.data === saved
    if (saved !== null && !savedCopy && divergence.current?.saved !== saved) {
      const counted = listDivergence(saved, query.data)
      divergence.current = {
        saved,
        since:
          counted.added + counted.gone + counted.changed === 0
            ? null
            : { savedAt: saved.syncedAt, divergence: counted },
      }
    }
    return {
      status: 'ready',
      list: query.data,
      refreshing: query.isFetching,
      refreshFailed: query.isError ? describeFailure(query.error) : null,
      savedCopy,
      sinceSavedCopy: divergence.current?.saved === saved ? divergence.current.since : null,
    }
  }
  if (query.isError) return { status: 'error', message: describeFailure(query.error) }
  return { status: 'loading' }
}
