import type { Address } from '@cancelchain/shared'
import { useQuery } from '@tanstack/react-query'
import { describeFailure } from './api.js'
import { type AllowanceList, source } from './source.js'

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
    }

/** Мітка стану моку: демо змінює його кліками, і список мусить це побачити. */
export function allowancesKey(owner: Address | null, revision: number): readonly unknown[] {
  return ['allowances', source.kind, owner, revision]
}

/**
 * Свіжість. Стан мережі має пріоритет над сховищем, тож список не тримається
 * довго: `staleTime` нульовий, і повернення на вкладку перечитує його. Своєї
 * періодичної перечитки тут немає навмисно — її місце займе SSE (`T042`), а
 * до нього зайвий полінг лише швидше з'їдає квоту публічного вузла.
 */
const RETRY_ATTEMPTS = 1

export function useAllowances(owner: Address | null, revision = 0): AllowancesState {
  const needsWallet = source.requiresWallet && owner === null

  const query = useQuery({
    queryKey: allowancesKey(owner, revision),
    queryFn: ({ signal }) => source.listAllowances(owner, signal),
    enabled: !needsWallet,
    staleTime: 0,
    retry: RETRY_ATTEMPTS,
  })

  if (needsWallet) return { status: 'no-wallet' }
  if (query.data !== undefined) {
    return {
      status: 'ready',
      list: query.data,
      refreshing: query.isFetching,
      refreshFailed: query.isError ? describeFailure(query.error) : null,
    }
  }
  if (query.isError) return { status: 'error', message: describeFailure(query.error) }
  return { status: 'loading' }
}
