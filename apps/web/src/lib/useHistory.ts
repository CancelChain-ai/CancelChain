import { useQuery } from '@tanstack/react-query'
import { describeFailure } from './api.js'
import { source } from './source.js'
import type { AddressHistoryView } from './view.js'

/**
 * Мінімальна стрічка для екрана картки (`T030`, `FR-005`).
 *
 * Окремий запит від самої картки, і це не оптимізація: п'ять полів `FR-002`
 * мусять бути на екрані разом (`SC-005`), тож вони не мають ані чекати на
 * історію, ані зникати з нею, коли вузол відмовить. Тому стан тут свій, і
 * невдача стрічки лишається невдачею **стрічки**.
 *
 * `unavailable` — це не порожньо і не збій: за джерелом немає мережі (мок M0),
 * і вигадана стрічка там приїжджає в самій картці.
 */
export type HistoryState =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; history: AddressHistoryView }

export function historyKey(id: string | null): readonly unknown[] {
  return ['history', source.kind, id]
}

const RETRY_ATTEMPTS = 1

export function useHistory(id: string | null): HistoryState {
  const query = useQuery({
    queryKey: historyKey(id),
    queryFn: ({ signal }) => (id === null ? Promise.resolve(null) : source.getHistory(id, signal)),
    enabled: id !== null,
    /*
     * Стрічка не перечитується сама. Відхилену спробу в межах 30 секунд обіцяє
     * `SC-006`, і виконає її SSE з індексатора (`T042`), а не полінг звідси:
     * на публічному вузлі саме він першим упирається в `429` (`T028`).
     */
    staleTime: 0,
    retry: RETRY_ATTEMPTS,
  })

  if (query.data === null) return { status: 'unavailable' }
  if (query.data !== undefined) return { status: 'ready', history: query.data }
  if (query.isError) return { status: 'error', message: describeFailure(query.error) }
  return { status: 'loading' }
}
