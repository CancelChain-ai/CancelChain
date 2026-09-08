import { useQuery } from '@tanstack/react-query'
import { describeFailure } from './api.js'
import { source } from './source.js'
import type { AllowanceDetailView } from './view.js'

/**
 * Один дозвіл для екрана картки (`T024`). Стан — скінченний перелік, як і в
 * списку, і з тієї самої причини: кожен випадок екран мусить показати
 * **по-різному**.
 *
 * Головна відмінність від списку — окремий `missing`. «За цією адресою дозволу
 * немає» не є ані помилкою, ані порожнім станом: скасований дозвіл — це
 * закритий акаунт, тож саме `missing` і є нормальною відповіддю мережі про
 * дозвіл, якого більше немає. Показати замість нього «не вдалося завантажити»
 * означало б назвати збоєм єдину річ, заради якої продукт існує.
 */
export type AllowanceState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      detail: AllowanceDetailView
      refreshing: boolean
      /** Перечитка поверх показаної картки не вдалася — і про це кажуть. */
      refreshFailed: string | null
    }

/**
 * Ключ запиту. Ревізія мока входить у нього з тієї ж причини, що й у списку:
 * демо змінює стан кліками, і картка мусить побачити ту саму зміну, що й
 * список — інакше прототип суперечив би сам собі.
 */
export function allowanceKey(id: string | null, revision: number): readonly unknown[] {
  return ['allowance', source.kind, id, revision]
}

const RETRY_ATTEMPTS = 1

export function useAllowance(id: string | null, revision = 0): AllowanceState {
  const query = useQuery({
    queryKey: allowanceKey(id, revision),
    queryFn: ({ signal }) =>
      // `enabled` нижче не пускає сюди `null`, але тип цього не знає, і
      // мовчазний `!` заборонений: `null` тут означав би запит ні про що.
      id === null ? Promise.resolve(null) : source.getAllowance(id, signal),
    enabled: id !== null,
    staleTime: 0,
    retry: RETRY_ATTEMPTS,
  })

  if (query.data === null) return { status: 'missing' }
  if (query.data !== undefined) {
    return {
      status: 'ready',
      detail: query.data,
      refreshing: query.isFetching,
      refreshFailed: query.isError ? describeFailure(query.error) : null,
    }
  }
  if (query.isError) return { status: 'error', message: describeFailure(query.error) }
  return { status: 'loading' }
}
