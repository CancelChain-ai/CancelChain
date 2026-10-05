import { shortenAddress } from '../chain/wallet'
import ConsentStrip from '../components/ConsentStrip'
import { LiveStatus } from '../components/LiveStatus'
import type { AllowanceState } from '../lib/useAllowance'
import type { FeedFreshness, FeedState, OlderState } from '../lib/useFeed'
import type { HistoryState } from '../lib/useHistory'
import type { LiveState } from '../lib/useStream'
import {
  type ActivityRow,
  type AddressHistoryView,
  type AllowanceDetailView,
  type CardField,
  capSentence,
  cardFields,
  type FeedEvent,
  feedLine,
  feedStaleSentence,
  feedTruncationSentence,
  formatClock,
  formatDay,
  formatMoney,
  shortDay,
} from '../lib/view'

/**
 * Екран однієї картки — `FR-002`, і на ньому міряється `SC-005`.
 *
 * Умова там сформульована як «5 полів із 5 без переходу на інший екран», і саме
 * тому п'ять полів тут — не верстка, а структура: `cardFields()` віддає кортеж
 * рівно з п'яти, і жодне з них не має права зникнути, коли значення невідоме.
 *
 * Три речі, яких цей екран не робить:
 *
 * 1. **Не пише нуль замість «ніхто не знає».** Скільки вже взято за разовим
 *    дозволом, мережа не зберігає взагалі (`decode.ts`: у `FixedDelegation` є
 *    лише залишок). Поле лишається на місці й каже це словами — «0.00 USDC»
 *    було б твердженням про чужі гроші, якого ніхто не робив.
 * 2. **Не малює смужку згоди над мертвим періодом.** Стеля скидається
 *    **списанням**, а не за годинником (`periodElapsed`), тож повна смужка
 *    сказала б «більше взяти не можуть» саме тоді, коли можуть будь-якої миті.
 * 3. **Не пропонує над чужим активом нічого, крім скасування** (`FR-020`).
 *    Пауза й «не поновлювати» там не з'являються ні за яких умов.
 */

interface SubscriptionProps {
  state: AllowanceState
  onBack: () => void
  /**
   * The feed (`T041a`; the address history of `T030` when the indexer has not
   * seen the permission). A state of its own, not a field of the card: a failed
   * feed must not take the five fields of `FR-002` off the screen. Absent — the
   * screen says it does not read a feed, instead of showing an empty one.
   */
  feed?: FeedState | undefined
  /**
   * Посилання на транзакцію в оглядачі. Приходить ззовні, бо мережу знає
   * оточення гаманця, а не цей екран; `null` з неї — оглядача для цієї мережі
   * немає (локальний вузол).
   */
  explorerUrl?: ((signature: string) => string | null) | undefined
  /** The same for an address: where the full history lives when the feed is cut or behind. */
  explorerAddressUrl?: ((address: string) => string | null) | undefined
  /**
   * Дії. Кожна з них існує на екрані рівно тоді, коли є що викликати: кнопка,
   * яка нічого не робить, гірша за її відсутність. На справжніх даних дій поки
   * немає жодної — скасування приходить із білдером транзакції (`T025`, `T026`).
   */
  onPause?: ((id: string) => void) | undefined
  onDontRenew?: ((id: string) => void) | undefined
  onCancelNow?: ((id: string) => void) | undefined
  onResume?: ((id: string) => void) | undefined
  onKeep?: ((id: string) => void) | undefined
  /** Whether the card and its feed keep themselves current (`T042a`). Absent — nothing streams. */
  live?: LiveState | undefined
}

type TagTone = 'quiet' | 'outline' | 'amber' | 'grey'

const TAG_STYLES: Record<TagTone, string> = {
  quiet: 'text-ink/55 border-transparent bg-rail/60',
  outline: 'text-ink border-ink',
  amber: 'text-amber border-amber',
  grey: 'text-ink/45 border-hairline',
}

const Tag = ({ children, tone = 'quiet' }: { children: string; tone?: TagTone }) => (
  <span
    className={`inline-block rounded border px-2 py-[3px] text-[11px] leading-none ${TAG_STYLES[tone]}`}
  >
    {children}
  </span>
)

const Back = ({ onBack }: { onBack: () => void }) => (
  <button
    type="button"
    onClick={onBack}
    className="text-[13px] text-ink/55 transition-colors duration-150 hover:text-ink"
  >
    ← My subscriptions
  </button>
)

const Notice = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-10 max-w-[560px] text-[15px] leading-relaxed text-ink/70">{children}</p>
)

/**
 * Одне з п'яти полів `FR-002`.
 *
 * Невідоме значення показується інакше за відоме — але показується. Порожній
 * рядок або прочерк на цьому місці читався б як «нуль», а різниця між «нуль» і
 * «мережа цього не зберігає» тут і є всім змістом поля.
 */
const Field = ({ field }: { field: CardField }) => (
  <div className="border-b border-hairline py-4">
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <dt className="text-[13px] text-ink/55">{field.label}</dt>
      <dd
        className={[
          'text-[14px] tnum',
          field.key === 'recipient' ? 'break-all font-mono text-[13px]' : '',
          field.known ? 'text-ink' : 'text-ink/55',
        ].join(' ')}
      >
        {field.value}
      </dd>
    </div>
    {field.note !== null && (
      <p className="mt-1 max-w-[520px] text-[12px] leading-relaxed text-ink/45">{field.note}</p>
    )}
  </div>
)

const Row = ({ label, value, mono }: { label: string; value: string; mono?: boolean }) => (
  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-hairline py-3">
    <span className="text-[13px] text-ink/55">{label}</span>
    <span className={`text-[13px] text-ink/80 tnum ${mono === true ? 'break-all font-mono' : ''}`}>
      {value}
    </span>
  </div>
)

/** Те, що на п'ять полів не претендує, але на картці мусить бути. */
function secondaryRows(
  detail: AllowanceDetailView,
): { label: string; value: string; mono: boolean }[] {
  const rows: { label: string; value: string; mono: boolean }[] = []

  rows.push({
    label: 'Given through',
    value:
      detail.planName ??
      (detail.kind === 'subscription' ? 'A merchant plan' : 'Given directly, not through a plan'),
    mono: false,
  })
  if (detail.givenOn !== null) {
    rows.push({ label: 'Permission given', value: formatDay(detail.givenOn), mono: false })
  }
  if (detail.expiresOn !== null) {
    rows.push({ label: 'Expires', value: formatDay(detail.expiresOn), mono: false })
  }
  if (detail.endsOn !== null) {
    rows.push({ label: 'Ends, and will not renew', value: formatDay(detail.endsOn), mono: false })
  }
  if (detail.mintAddress !== null) {
    rows.push({
      label: 'Asset',
      value: detail.assetSupported ? `USDC · ${detail.mintAddress}` : detail.mintAddress,
      mono: true,
    })
  }
  if (detail.ownerAddress !== null) {
    rows.push({ label: 'Granted from', value: detail.ownerAddress, mono: true })
  }
  if (detail.address !== null) {
    rows.push({ label: 'Permission address', value: detail.address, mono: true })
  }
  return rows
}

/** Звідки взято те, що вище, і коли. Мок каже про себе, що він вигаданий. */
const ReadAt = ({ detail }: { detail: AllowanceDetailView }) => (
  <p className="mt-4 text-[12px] text-ink/45 tnum">
    {detail.networkState === 'none'
      ? `Invented data, generated at ${formatClock(detail.syncedAt)}`
      : `Read from the network at ${formatClock(detail.syncedAt)}${
          detail.slot === null ? '' : ` · slot ${detail.slot}`
        }`}
  </p>
)

/**
 * Стрічка на вимогу — `T030`, мінімальна форма `FR-005`.
 *
 * **Що вона каже і чого не каже.** Без індексатора в нас є рівно
 * `getSignaturesForAddress`: транзакція згадала цю адресу, і мережа її
 * прийняла або ні. Ані суми, ані «списано / скасовано», ані причини відмови
 * тут немає — щоб їх назвати, треба розбирати логи програми (`T038`) і мапити
 * коди помилок у категорії (`T040`). Порожнє поле замість здогадки, як і в
 * решті екрана.
 *
 * **Це історія адреси, а не дозволу.** Акаунт закривається скасуванням, і ті
 * самі сіди дають ту саму адресу знову, тож старий рядок може належати
 * дозволу, якого вже немає. Екран каже це вголос, а не робить вигляд, що
 * стрічка суцільна.
 */
const HistoryFeed = ({
  history,
  explorerUrl,
}: {
  history: AddressHistoryView
  explorerUrl: ((signature: string) => string | null) | undefined
}) => {
  if (history.rows.length === 0) {
    return (
      <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-ink/55">
        No transaction has touched this address — read at {formatClock(history.syncedAt)}. That is
        an answer from the network, not a feed we failed to load.
      </p>
    )
  }

  return (
    <>
      <p className="mt-3 max-w-[520px] text-[12px] leading-relaxed text-ink/45">
        Transactions that mentioned this address. What each one did is not read here — only whether
        the network accepted it.
      </p>
      <div className="mt-3 border-t border-hairline">
        {history.rows.map((row) => {
          const url = explorerUrl?.(row.signature) ?? null
          const short = shortenAddress(row.signature)
          return (
            <div
              key={row.signature}
              className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 border-b border-hairline py-3 text-[13px] sm:grid-cols-[120px_1fr_auto]"
            >
              <span className="tnum text-ink/55">
                {row.when === null
                  ? `slot ${row.slot}`
                  : `${shortDay(row.when)} ${formatClock(row.when)}`}
              </span>
              <span
                className={`col-span-2 sm:col-span-1 ${row.failed ? 'text-rust' : 'text-ink/80'}`}
              >
                {row.failed ? 'The network refused it' : 'The network accepted it'}
              </span>
              <span className="justify-self-end font-mono text-[12px] tnum">
                {url === null ? (
                  <span className="text-ink/45">{short}</span>
                ) : (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink/55 underline underline-offset-4 hover:text-ink"
                  >
                    {short}
                  </a>
                )}
              </span>
            </div>
          )
        })}
      </div>
      <p className="mt-3 max-w-[520px] text-[12px] leading-relaxed text-ink/45">
        Read at {formatClock(history.syncedAt)}.{' '}
        {history.more
          ? `Showing the ${history.rows.length} most recent — the address has older ones.`
          : 'That is everything this node still keeps for the address.'}{' '}
        Cancelling closes the account and the same address can be granted again, so an older row may
        belong to a permission that no longer exists.
      </p>
    </>
  )
}

/**
 * Стрічка мока M0 — вигадана разом з усім іншим і тому приїжджає в самій
 * картці. Справжня історія приходить окремим запитом (`HistoryFeed`).
 */
const MockActivity = ({ rows }: { rows: ActivityRow[] }) => (
  <>
    <div className="mt-3 border-t border-hairline">
      {rows.map((event) => (
        <div
          key={`${event.date}-${event.description}`}
          className={`border-b border-hairline py-3 text-[13px] ${
            event.rejected ? 'text-rust' : 'text-ink'
          }`}
        >
          <div className="sm:hidden">
            <div className={event.rejected ? 'text-rust' : 'text-ink/80'}>{event.description}</div>
            <div className="mt-1 flex items-baseline justify-between gap-4">
              <span className={`tnum ${event.rejected ? 'text-rust' : 'text-ink/55'}`}>
                {event.date}
              </span>
              <span className={`tnum ${event.rejected ? 'text-rust' : 'text-ink/55'}`}>
                {event.amount === null ? '—' : formatMoney(event.amount)}
              </span>
            </div>
          </div>

          <div className="hidden grid-cols-[100px_1fr_auto] items-baseline gap-4 sm:grid">
            <span className={`tnum ${event.rejected ? 'text-rust' : 'text-ink/55'}`}>
              {event.date}
            </span>
            <span className={event.rejected ? 'text-rust' : 'text-ink/80'}>
              {event.description}
            </span>
            <span className="tnum">{event.amount === null ? '—' : formatMoney(event.amount)}</span>
          </div>
        </div>
      ))}
    </div>
    <p className="mt-3 text-[12px] text-ink/45">
      Showing the last 90 days. Older activity stays on the network.
    </p>
  </>
)

/** The address history of `T030` in each of its states. */
const AddressHistory = ({
  history,
  explorerUrl,
}: {
  history: HistoryState
  explorerUrl: ((signature: string) => string | null) | undefined
}) =>
  history.status === 'unavailable' ? (
    <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-ink/55">
      Charges and refused attempts are not read on this screen. That is a feed we do not fetch — not
      a history that is empty.
    </p>
  ) : history.status === 'loading' ? (
    <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-ink/55">
      Reading the transactions that touched this address…
    </p>
  ) : history.status === 'error' ? (
    // Стрічка не доїхала — і це сказано про стрічку. П'ять полів `FR-002`
    // лишаються на екрані: вони прочитані іншим запитом і від цього не залежать.
    <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-rust">{history.message}</p>
  ) : (
    <HistoryFeed history={history.history} explorerUrl={explorerUrl} />
  )

const NetworkLink = ({ url }: { url: string | null }) =>
  url === null ? null : (
    <>
      {' '}
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="whitespace-nowrap text-ink/70 underline underline-offset-4 hover:text-ink"
      >
        See the address on the network
      </a>
    </>
  )

/**
 * A heartbeat too old to vouch for the head of the feed (`T041a`). The events
 * stay: they are still true, only possibly not the newest.
 */
const StaleNote = ({
  freshness,
  networkUrl,
}: {
  freshness: FeedFreshness
  networkUrl: string | null
}) =>
  freshness.stale ? (
    <p className="mt-3 max-w-[520px] text-[12px] leading-relaxed text-amber">
      {feedStaleSentence(freshness.syncedAt, new Date())}
      <NetworkLink url={networkUrl} />
    </p>
  ) : null

const FeedRow = ({
  event,
  detail,
  explorerUrl,
}: {
  event: FeedEvent
  detail: AllowanceDetailView
  explorerUrl: ((signature: string) => string | null) | undefined
}) => {
  const line = feedLine(event, detail)
  const url = explorerUrl?.(event.signature) ?? null
  const short = shortenAddress(event.signature)
  return (
    // Narrow: time and amount on one line, what happened under them. Wide: one
    // row, with the amount moved last.
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 border-b border-hairline py-3 text-[13px] sm:grid-cols-[120px_1fr_auto]">
      <span className="tnum text-ink/55">{`${shortDay(event.when)} ${formatClock(event.when)}`}</span>
      <span
        className={`justify-self-end tnum sm:order-last ${line.refused ? 'text-rust' : 'text-ink'}`}
      >
        {line.amount ?? ''}
      </span>
      <div className="col-span-2 min-w-0 sm:col-span-1">
        <div className={line.refused ? 'text-rust' : 'text-ink/80'}>{line.title}</div>
        {line.reason !== null && <div className="mt-[2px] text-rust/80">{line.reason}</div>}
        <div className="mt-1 font-mono text-[12px] tnum">
          {url === null ? (
            <span className="text-ink/45">{short}</span>
          ) : (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-ink/45 underline underline-offset-4 hover:text-ink"
            >
              {short}
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

const ACTION_SMALL =
  'rounded-md border border-ink px-3 py-[7px] text-[13px] transition-colors duration-150 hover:bg-ink/[0.06] disabled:cursor-default disabled:border-hairline disabled:text-ink/45 disabled:hover:bg-transparent'

/**
 * The end of the loaded feed: more to load, or the honest end — the cut
 * (`truncatedAt`) with a way to the network, or the creation of the permission.
 */
const FeedEnd = ({
  older,
  truncatedAt,
  hasEvents,
  networkUrl,
}: {
  older: OlderState
  truncatedAt: Date | null
  hasEvents: boolean
  networkUrl: string | null
}) => {
  if (older.status === 'more' || older.status === 'loading') {
    return (
      <button
        type="button"
        className={`mt-4 ${ACTION_SMALL}`}
        disabled={older.status === 'loading'}
        onClick={older.status === 'more' ? older.load : undefined}
      >
        {older.status === 'loading' ? 'Loading older…' : 'Show older'}
      </button>
    )
  }
  if (older.status === 'failed') {
    return (
      <div className="mt-4">
        <p className="max-w-[520px] text-[12px] leading-relaxed text-rust">{older.message}</p>
        <button type="button" className={`mt-2 ${ACTION_SMALL}`} onClick={older.load}>
          Try older again
        </button>
      </div>
    )
  }
  if (truncatedAt !== null) {
    return (
      <p className="mt-3 max-w-[520px] text-[12px] leading-relaxed text-ink/55">
        {feedTruncationSentence(truncatedAt)}
        <NetworkLink url={networkUrl} />
      </p>
    )
  }
  return hasEvents ? (
    <p className="mt-3 text-[12px] text-ink/45">
      That is everything since the permission was given.
    </p>
  ) : null
}

const Activity = ({
  detail,
  feed,
  explorerUrl,
  explorerAddressUrl,
}: {
  detail: AllowanceDetailView
  feed: FeedState | undefined
  explorerUrl: ((signature: string) => string | null) | undefined
  explorerAddressUrl: ((address: string) => string | null) | undefined
}) => {
  const networkUrl = detail.address === null ? null : (explorerAddressUrl?.(detail.address) ?? null)
  return (
    <>
      <h2 className="mt-12 text-[13px] uppercase tracking-[0.08em] text-ink/55">Activity</h2>
      {detail.activity !== null ? (
        <MockActivity rows={detail.activity} />
      ) : feed === undefined || feed.status === 'unavailable' ? (
        <AddressHistory history={{ status: 'unavailable' }} explorerUrl={explorerUrl} />
      ) : feed.status === 'loading' ? (
        <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-ink/55">
          Reading what happened under this permission…
        </p>
      ) : feed.status === 'error' ? (
        <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-rust">{feed.message}</p>
      ) : feed.status === 'untracked' ? (
        <>
          <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-ink/80">
            The indexer has not seen this permission yet, so charges and refusals are not named
            here. Below is what the network itself keeps for its address.
          </p>
          <StaleNote freshness={feed.freshness} networkUrl={networkUrl} />
          <AddressHistory history={feed.history} explorerUrl={explorerUrl} />
        </>
      ) : (
        <>
          <StaleNote freshness={feed.freshness} networkUrl={networkUrl} />
          {feed.events.length === 0 ? (
            <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-ink/55">
              The indexer has recorded nothing under this permission yet.
            </p>
          ) : (
            <div className="mt-3 border-t border-hairline">
              {feed.events.map((event) => (
                <FeedRow key={event.id} event={event} detail={detail} explorerUrl={explorerUrl} />
              ))}
            </div>
          )}
          <FeedEnd
            older={feed.older}
            truncatedAt={feed.truncatedAt}
            hasEvents={feed.events.length > 0}
            networkUrl={networkUrl}
          />
        </>
      )}
    </>
  )
}

const ACTION_BASE =
  'rounded-md border border-ink px-4 py-[10px] text-[13px] transition-colors duration-150 hover:bg-ink/[0.06]'

const Card = ({
  detail,
  refreshFailed,
  onPause,
  onDontRenew,
  onCancelNow,
  onResume,
  onKeep,
  feed,
  explorerUrl,
  explorerAddressUrl,
  live = 'off',
}: {
  detail: AllowanceDetailView
  refreshFailed: string | null
} & Omit<SubscriptionProps, 'state' | 'onBack'>) => {
  const { id, title, counterparty, status, assetSupported } = detail
  const revoked = status === 'revoked'
  const paused = status === 'paused'
  const exhausted = status === 'exhausted'
  const fields = cardFields(detail)

  /**
   * Пауза й «не поновлювати» існують лише для підписки за планом (`FR-011`,
   * `FR-028`) — і лише в розрахунковому активі: над чужим активом єдина дія —
   * скасування (`FR-020`).
   */
  const planActions = detail.kind === 'subscription' && assetSupported && !revoked
  const offersPlanActions = onPause !== undefined || onDontRenew !== undefined
  const actions = [
    planActions && paused && onResume !== undefined
      ? { key: 'resume', label: 'Resume', tone: 'ink', run: () => onResume(id) }
      : null,
    planActions && detail.endsOn !== null && onKeep !== undefined
      ? { key: 'keep', label: 'Keep it after all', tone: 'ink', run: () => onKeep(id) }
      : null,
    planActions && !paused && detail.endsOn === null && onPause !== undefined
      ? { key: 'pause', label: 'Pause', tone: 'ink', run: () => onPause(id) }
      : null,
    planActions && !paused && detail.endsOn === null && detail.nextCharge !== null
      ? onDontRenew === undefined
        ? null
        : {
            key: 'dont-renew',
            label: `Don't renew after ${shortDay(detail.nextCharge)}`,
            tone: 'ink',
            run: () => onDontRenew(id),
          }
      : null,
    !revoked && onCancelNow !== undefined
      ? { key: 'cancel', label: 'Cancel now', tone: 'rust', run: () => onCancelNow(id) }
      : null,
  ].filter((action): action is { key: string; label: string; tone: string; run: () => void } => {
    return action !== null
  })

  return (
    <>
      <div className="mt-8">
        <h1
          className={[
            'leading-tight',
            title === null ? 'break-all font-mono text-[22px]' : 'text-[28px] font-medium',
            revoked ? 'text-ink/45 line-through' : 'text-ink',
          ].join(' ')}
        >
          {title ?? counterparty}
        </h1>

        <div className="mt-3 flex flex-wrap gap-2">
          <Tag>{detail.kindLabel}</Tag>
          {revoked && <Tag tone="grey">Cancelled</Tag>}
          {paused && <Tag tone="amber">Paused</Tag>}
          {exhausted && <Tag tone="grey">Cannot charge</Tag>}
          {detail.note !== null && !revoked && <Tag>{detail.note}</Tag>}
          {detail.endsOn !== null && (
            <Tag tone="outline">{`Ends ${shortDay(detail.endsOn)} — won't renew`}</Tag>
          )}
        </div>

        <p className="mt-3 text-[14px] text-ink/80 tnum">{capSentence(detail)}</p>
      </div>

      {refreshFailed !== null && (
        <p className="mt-4 max-w-[520px] text-[12px] leading-relaxed text-rust">
          Showing what we read at {formatClock(detail.syncedAt)}. The latest re-read failed:{' '}
          {refreshFailed}
        </p>
      )}

      {detail.networkState === 'absent' && (
        <p className="mt-4 max-w-[520px] text-[13px] leading-relaxed text-ink/80">
          There is no account for this permission on the network any more. A cancelled permission
          leaves nothing behind, and nothing can be charged under it again.
        </p>
      )}

      {detail.diverged && (
        <p className="mt-4 max-w-[520px] text-[13px] leading-relaxed text-amber">
          Our stored copy of this permission disagreed with the network. What you see below is the
          network — it wins, and the difference is shown rather than hidden.
        </p>
      )}

      {/*
        Смужка згоди — тільки коли є що показувати: частка від невідомого
        («витрачено» разового дозволу) і повна смужка над мертвим періодом
        обидві сказали б неправду. Тому вона зникає, а поля — ні.
      */}
      {!revoked && detail.used !== null && !detail.periodElapsed && (
        <div className="mt-6">
          <ConsentStrip
            used={Number(detail.used.amount)}
            ceiling={Number(detail.cap.amount)}
            height={10}
          />
          <p className="mt-2 text-[12px] text-ink/45 tnum">
            {formatMoney(detail.used)} of {formatMoney(detail.cap)} used this period
          </p>
        </div>
      )}

      {/*
        `FR-002` / `SC-005`: п'ять полів — отримувач, стеля, період, витрачено,
        наступне списання — на одному екрані, без переходу кудись іще. Перелік
        приходить кортежем із `cardFields()`, тож «п'ять із п'яти» тут не можна
        втратити правкою верстки.
      */}
      <dl className="mt-8 border-t border-hairline">
        {fields.map((field) => (
          <Field key={field.key} field={field} />
        ))}
      </dl>

      <ReadAt detail={detail} />
      <LiveStatus state={live} className="mt-1 block" />

      <div className="mt-10 border-t border-hairline">
        {secondaryRows(detail).map((row) => (
          <Row key={row.label} label={row.label} value={row.value} mono={row.mono} />
        ))}
      </div>

      <Activity
        detail={detail}
        feed={feed}
        explorerUrl={explorerUrl}
        explorerAddressUrl={explorerAddressUrl}
      />

      {actions.length > 0 && (
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          {actions.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={action.run}
              className={`${ACTION_BASE} ${action.tone === 'rust' ? 'text-rust' : 'text-ink'}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      {!assetSupported && !revoked && (
        <p className="mt-3 max-w-[520px] text-[12px] leading-relaxed text-ink/55">
          CancelChain only manages USDC permissions, so it offers nothing here but cancelling.{' '}
          {/*
            Друге речення — тільки там, де десяткових справді немає. Мок свій актив
            знає, і сказати про його суми «найменшими одиницями» означало б пояснити
            те, чого на екрані не сталося.
          */}
          {detail.cap.decimals === null &&
            "The amounts above are in that asset's smallest units, because its decimals are not known here. "}
          You can still cancel it.
        </p>
      )}

      {assetSupported && !revoked && detail.kind !== 'subscription' && offersPlanActions && (
        <p className="mt-3 max-w-[520px] text-[12px] leading-relaxed text-ink/55">
          This permission was given directly, not through a plan. Pausing and scheduling an end
          exist only for plan subscriptions. You can still cancel it now.
        </p>
      )}
    </>
  )
}

const Subscription = ({ state, onBack, ...actions }: SubscriptionProps) => (
  <div className="max-w-[640px]">
    <Back onBack={onBack} />

    {state.status === 'loading' && <Notice>Reading this permission from the network…</Notice>}

    {state.status === 'missing' && (
      <Notice>
        There is no permission at this address. Either there never was one, or its account has
        already been closed — a cancelled permission leaves nothing behind on the network. This is
        an answer, not a failure to load.
      </Notice>
    )}

    {state.status === 'error' && (
      <Notice>
        <span className="text-rust">{state.message}</span>
      </Notice>
    )}

    {state.status === 'ready' && (
      <Card detail={state.detail} refreshFailed={state.refreshFailed} {...actions} />
    )}
  </div>
)

export default Subscription
