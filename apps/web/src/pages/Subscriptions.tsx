import AllowanceCard from '../components/AllowanceCard'
import type { AllowanceList } from '../lib/source'
import type { AllowancesState } from '../lib/useAllowances'
import {
  type AllowanceView,
  allowedTotal,
  everyPeriod,
  formatClock,
  scaleAmount,
  UNREADABLE_REASON_LABELS,
} from '../lib/view'

/**
 * Екран списку — `FR-001`, `FR-002`.
 *
 * Три речі, які цей екран не має права зробити:
 *
 * 1. **Показати порожнє місце замість невдачі.** «Дозволів немає» і «не змогли
 *    прочитати» виглядають однаково лише доти, доки цього не зробити навмисно:
 *    саме на цій різниці стоїть уся користь продукту (`FR-022`). Стан приходить
 *    сюди скінченним переліком (`useAllowances`), і кожен випадок має свій текст.
 * 2. **Тихо скоротитися.** Акаунти, які не стали картками, перелічені під
 *    списком із названою причиною (`FR-006`): список, який мовчки коротший за
 *    гаманець, — це прихований дозвіл.
 * 3. **Скласти різні активи в одне число.** Сума в шапці — тільки розрахунковий
 *    актив; дозвіл у чужому міні лишається в списку й каже про себе сам
 *    (`FR-020`).
 */

interface SubscriptionsProps {
  state: AllowancesState
  /** Гаманець, чий це список. `null` — джерело його не потребує (мок). */
  walletLabel: string | null
  /** Чи стоїть за списком мережа: від цього залежить, що екран каже про себе. */
  onNetwork: boolean
  onOpen?: ((id: string) => void) | undefined
  onCancel?: ((id: string) => void) | undefined
}

const Notice = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-12 max-w-[560px] text-[15px] leading-relaxed text-ink/70">{children}</p>
)

/** Активні дозволи вперед, скасовані — у кінець, решта — у порядку джерела. */
function ordered(items: readonly AllowanceView[]): AllowanceView[] {
  return items
    .map((view, index) => ({ view, index }))
    .sort((a, b) => {
      const weight = (view: AllowanceView) => (view.status === 'revoked' ? 1 : 0)
      const byStatus = weight(a.view) - weight(b.view)
      return byStatus !== 0 ? byStatus : a.index - b.index
    })
    .map((entry) => entry.view)
}

/**
 * Період під сумою. Спільний — коли він справді спільний: дозволи гаманця
 * бувають із різними періодами, і «per month» над сумою різних періодів — це
 * не спрощення, а неправильне число.
 */
function periodClause(items: readonly AllowanceView[]): string | null {
  const counted = items.filter((view) => view.assetSupported && view.status === 'active')
  // Нема чого рахувати — нема й спільного періоду. «Across their own periods»
  // над нулем було б твердженням про періоди, яких у цьому числі немає.
  if (counted.length === 0) return null
  const periods = new Set(counted.map((view) => view.periodSeconds))
  const only = periods.size === 1 ? [...periods][0] : undefined
  if (only === undefined) return 'across their own periods'
  return only === null ? 'one-off, not per period' : everyPeriod(only)
}

const Header = ({
  list,
  walletLabel,
  onNetwork,
}: {
  list: AllowanceList
  walletLabel: string | null
  onNetwork: boolean
}) => {
  const total = allowedTotal(list.items)
  const period = periodClause(list.items)
  const unsupported = list.items.filter((view) => !view.assetSupported).length

  return (
    <div className="flex flex-col gap-6 border-b border-hairline pb-10 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p className="text-[13px] text-ink/55">You have allowed</p>
        <p className="mt-2 text-[48px] font-medium leading-none tracking-tight tnum sm:text-[56px]">
          {scaleAmount(total.amount, total.decimals)} {total.label}
        </p>
        <p className="mt-3 text-[13px] text-ink/55 tnum">
          {period !== null && `${period}, `}across {total.count} active{' '}
          {total.count === 1 ? 'permission' : 'permissions'}
        </p>
        <p className="mt-1 text-[12px] text-ink/45">
          Paused, spent and cancelled permissions are not counted.
          {unsupported > 0 &&
            ` ${unsupported} more ${unsupported === 1 ? 'permission is' : 'permissions are'} in another asset and cannot be added to this number.`}
        </p>
      </div>
      <div className="flex flex-col gap-1 text-[13px] text-ink/55 sm:items-end sm:pt-1">
        {walletLabel !== null && <span className="tnum">Wallet {walletLabel}</span>}
        <span className="text-[12px] text-ink/45 tnum">
          {onNetwork ? 'Read from the network at ' : 'Invented data, generated at '}
          {formatClock(new Date(list.syncedAt))}
        </span>
        {list.stale && (
          <span className="text-[12px] text-amber">
            This is a stored copy, older than we are willing to vouch for.
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * «Показано не все». Порожній `unreadable` — це твердження, що показано все, і
 * тому непорожній зобов'язує сказати, скільком карткам тут місця не знайшлося.
 */
const Unreadable = ({ list }: { list: AllowanceList }) => {
  if (list.unreadable.length === 0) return null
  const count = list.unreadable.length
  return (
    <div className="mt-10 rounded-[10px] border border-dashed border-amber/60 p-5">
      <p className="text-[13px] text-ink/80">
        {count === 1
          ? 'One more account in this wallet belongs to the same program and is not in the list above.'
          : `${count} more accounts in this wallet belong to the same program and are not in the list above.`}{' '}
        The list is short by {count} — that is not the same as this wallet having fewer permissions.
      </p>
      <ul className="mt-3 space-y-1 text-[12px] text-ink/55">
        {list.unreadable.map((entry) => (
          <li key={entry.address} className="tnum">
            <span className="font-mono">{entry.address}</span> —{' '}
            {UNREADABLE_REASON_LABELS[entry.reason]}
          </li>
        ))}
      </ul>
    </div>
  )
}

const Subscriptions = ({ state, walletLabel, onNetwork, onOpen, onCancel }: SubscriptionsProps) => {
  if (state.status === 'no-wallet') {
    return (
      <Notice>
        A permission list is the list of one wallet. Connect yours and CancelChain reads every
        allowance granted from it — including the ones granted through other apps. There is nothing
        to log in to.
      </Notice>
    )
  }

  if (state.status === 'loading') {
    return <Notice>Reading this wallet's permissions from the network…</Notice>
  }

  if (state.status === 'error') {
    // Порожній список тут був би брехнею рівно про те, заради чого продукт існує.
    return (
      <Notice>
        <span className="text-rust">{state.message}</span>
      </Notice>
    )
  }

  const { list } = state
  const items = ordered(list.items)

  return (
    <div>
      <Header list={list} walletLabel={walletLabel} onNetwork={onNetwork} />

      {state.refreshFailed !== null && (
        <p className="mt-6 text-[12px] leading-relaxed text-rust">
          Showing what we read at {formatClock(new Date(list.syncedAt))}. The latest re-read failed:{' '}
          {state.refreshFailed}
        </p>
      )}

      {items.length === 0 ? (
        <Notice>
          No one can charge this wallet. Nothing here means nothing is running — not that we failed
          to load anything.
        </Notice>
      ) : (
        <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-2">
          {items.map((view) => (
            <AllowanceCard key={view.id} view={view} onOpen={onOpen} onCancel={onCancel} />
          ))}
        </div>
      )}

      <Unreadable list={list} />
    </div>
  )
}

export default Subscriptions
