import type { CancelControls, CancelState } from '../chain/revoke'
import { stepLabel } from '../chain/revoke'
import AllowanceCard, { type CancelNotice, NOTICE_STYLES } from '../components/AllowanceCard'
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
 * Чотири речі, яких цей екран не має права зробити:
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
 * 4. **Намалювати скасований дозвіл.** Скасування закриває акаунт, тож із
 *    мережі він приходить не «скасованим», а ніяким: список перечитується і
 *    коротшає. Картка-надгробок тут була б станом нашого власного винаходу
 *    над станом мережі, тобто розбіжністю, яку ми ж обіцяємо показувати
 *    (`Departed`).
 */

interface SubscriptionsProps {
  state: AllowancesState
  /** Гаманець, чий це список. `null` — джерело його не потребує (мок). */
  walletLabel: string | null
  /** Чи стоїть за списком мережа: від цього залежить, що екран каже про себе. */
  onNetwork: boolean
  onOpen?: ((id: string) => void) | undefined
  /**
   * Скасування (`FR-003`). Немає — кнопки немає взагалі: над справжніми
   * дозволами кнопка, яка нічого не підписує, гірша за її відсутність.
   */
  cancel?: CancelControls | undefined
}

/**
 * Підсумок потоку для однієї картки.
 *
 * `unconfirmed` навмисно **не** зелений і не червоний. Гаманець повернув
 * підпис, а акаунт лишився на місці: це стан «невідомо», і назвати його
 * успіхом означало б сказати про чужі гроші те, чого ми не перевірили.
 */
function noticeFor(state: CancelControls['state'], id: string): CancelNotice | null {
  if (!('id' in state) || state.id !== id) return null
  switch (state.status) {
    case 'gone':
      return {
        tone: 'good',
        text: 'This permission was already gone before anything was signed. Nothing was sent.',
      }
    case 'done':
      return {
        tone: 'good',
        text: `Cancelled. The permission account no longer exists on the network — the next charge has nothing to charge against. Transaction ${state.signature}.`,
      }
    case 'unconfirmed':
      return {
        tone: 'warn',
        text: `Your wallet reported transaction ${state.signature}, but the permission is still on the network. It may still land, or it may have failed — this is not a confirmation.`,
      }
    case 'failed':
      return { tone: 'bad', text: state.message }
    default:
      return null
  }
}

function progressFor(state: CancelControls['state'], id: string): string | null {
  return state.status === 'working' && state.id === id ? stepLabel(state.step) : null
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

/**
 * Що сталося з дозволом, якого в списку **вже немає** — `FR-022`.
 *
 * Скасований дозвіл не стає карткою з міткою: він стає **зниклим акаунтом**.
 * Програма закриває акаунт, наступне читання гаманця його вже не бачить, і
 * список просто коротшає. Своєї мітки «Cancelled» ми над цим не малюємо
 * (рішення `T026`): намальована нами картка над закритим акаунтом і була б
 * розбіжністю зі станом мережі — тією самою, яку продукт обіцяє показувати, а
 * не створювати.
 *
 * Але разом із карткою зникає й підсумок потоку, а в ньому єдине, що людина
 * може віднести в оглядач, — підпис транзакції. Тому підсумок переживає картку
 * тут, на рівні списку, і каже рівно те, що ми знаємо: дозволу немає в списку,
 * прочитаному о такій-то годині.
 */
type FinishedCancel = Exclude<CancelState, { status: 'idle' } | { status: 'working' }>

function departedNotice(state: FinishedCancel, readAt: string): CancelNotice {
  switch (state.status) {
    case 'gone':
      return {
        tone: 'good',
        text:
          'This permission was already gone before anything was signed. Nothing was sent, and ' +
          `it is not in the list read at ${readAt}.`,
      }
    case 'done':
      return {
        tone: 'good',
        text:
          'Cancelled. The permission account no longer exists on the network — the next charge ' +
          `has nothing to charge against, so it is gone from the list read at ${readAt} instead ` +
          `of sitting in it marked cancelled. Transaction ${state.signature}.`,
      }
    case 'unconfirmed':
      /*
       * Тут «невідомо» вже скінчилося. Ми перестали чекати, поки акаунт був на
       * місці, — а список, прочитаний після того, його не бачить. Це та сама
       * перевірка, якою підтверджується скасування, тільки пізніше.
       */
      return {
        tone: 'good',
        text:
          `Your wallet reported transaction ${state.signature}, and we stopped waiting before ` +
          `the network dropped the permission. It is not in the list read at ${readAt} — the ` +
          'account is gone after all.',
      }
    case 'failed':
      return {
        tone: 'warn',
        text:
          `${state.message} The permission is also not in the list read at ${readAt}: either it ` +
          'was already gone, or the transaction landed anyway. Its absence is what the network ' +
          'says, not a state we set.',
      }
  }
}

const Departed = ({
  state,
  list,
  onDismiss,
}: {
  state: CancelControls['state']
  list: AllowanceList
  onDismiss: () => void
}) => {
  // Картка на місці — підсумок належить їй, а не списку.
  if (!('id' in state) || list.items.some((view) => view.id === state.id)) return null
  const readAt = formatClock(new Date(list.syncedAt))

  if (state.status === 'working') {
    // Картка зникла посеред потоку (перечитка на поверненні у вкладку). Мовчати
    // тут не можна: підпис уже може бути в гаманці.
    return (
      <p className="mt-8 max-w-[640px] rounded-md border border-hairline p-4 text-[13px] leading-relaxed text-ink/80">
        {stepLabel(state.step)} Its card is no longer in the list read at {readAt}.
      </p>
    )
  }

  const notice = departedNotice(state, readAt)
  return (
    <div
      className={`mt-8 max-w-[640px] rounded-md border p-4 text-[13px] leading-relaxed ${NOTICE_STYLES[notice.tone]}`}
    >
      <p>{notice.text}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-3 text-[12px] text-ink/55 underline underline-offset-4"
      >
        Dismiss
      </button>
    </div>
  )
}

/**
 * Порожній список — це **твердження про гаманець**, а не відсутність вмісту, і
 * правдиве воно не завжди (`FR-022`, `FR-006`).
 *
 * «Ніхто не може списати» можна сказати рівно тоді, коли ми прочитали все і
 * щойно. Якщо частину акаунтів прочитати не вдалося, порожній екран приховує
 * саме те, чого людина боїться; якщо перечитка впала або копія несвіжа — це
 * відповідь про минуле, видана за теперішнє.
 */
const EmptyList = ({
  list,
  refreshFailed,
}: {
  list: AllowanceList
  refreshFailed: string | null
}) => {
  const readAt = formatClock(new Date(list.syncedAt))

  if (list.unreadable.length > 0) {
    const count = list.unreadable.length
    return (
      <Notice>
        Not one account in this wallet became a card, and{' '}
        {count === 1 ? 'one of them' : `${count} of them`} could not be read at all. Empty here is
        not the same as safe: what could not be read is named below, and any of it may still be able
        to charge this wallet.
      </Notice>
    )
  }

  if (refreshFailed !== null) {
    return (
      <Notice>
        Nothing was in this wallet at {readAt} — and the latest re-read failed, so that is what the
        network said then, not what it says now.
      </Notice>
    )
  }

  if (list.stale) {
    return (
      <Notice>
        Nothing is in this stored copy, and it is older than we are willing to vouch for. Until it
        is re-read, this is not an answer about what can charge this wallet.
      </Notice>
    )
  }

  return (
    <Notice>
      No one can charge this wallet. Nothing here means nothing is running — not that we failed to
      load anything. A cancelled permission leaves nothing behind either: its account is closed, so
      it disappears from this list instead of sitting in it marked cancelled.
    </Notice>
  )
}

const Subscriptions = ({ state, walletLabel, onNetwork, onOpen, cancel }: SubscriptionsProps) => {
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

      {/*
        Чому кнопки немає — сказано вголос. Мовчазна відсутність головної дії
        продукту виглядала б як «тут нічого не можна», а причина щоразу інша:
        гаманця немає, гаманець не підписує, або це демо.
      */}
      {cancel?.unavailable != null && (
        <p className="mt-6 max-w-[560px] text-[12px] leading-relaxed text-amber">
          {cancel.unavailable}
        </p>
      )}

      {cancel !== undefined && (
        <Departed state={cancel.state} list={list} onDismiss={cancel.dismiss} />
      )}

      {items.length === 0 ? (
        <EmptyList list={list} refreshFailed={state.refreshFailed} />
      ) : (
        <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-2">
          {items.map((view) => (
            <AllowanceCard
              key={view.id}
              view={view}
              onOpen={onOpen}
              onCancel={cancel?.cancel ?? undefined}
              cancelProgress={cancel === undefined ? null : progressFor(cancel.state, view.id)}
              cancelNotice={cancel === undefined ? null : noticeFor(cancel.state, view.id)}
              onDismissCancel={cancel?.dismiss}
            />
          ))}
        </div>
      )}

      <Unreadable list={list} />
    </div>
  )
}

export default Subscriptions
