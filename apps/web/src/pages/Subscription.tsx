import ConsentStrip from '../components/ConsentStrip'
import type { AllowanceState } from '../lib/useAllowance'
import {
  type AllowanceDetailView,
  type CardField,
  capSentence,
  cardFields,
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
   * Дії. Кожна з них існує на екрані рівно тоді, коли є що викликати: кнопка,
   * яка нічого не робить, гірша за її відсутність. На справжніх даних дій поки
   * немає жодної — скасування приходить із білдером транзакції (`T025`, `T026`).
   */
  onPause?: ((id: string) => void) | undefined
  onDontRenew?: ((id: string) => void) | undefined
  onCancelNow?: ((id: string) => void) | undefined
  onResume?: ((id: string) => void) | undefined
  onKeep?: ((id: string) => void) | undefined
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

const Activity = ({ detail }: { detail: AllowanceDetailView }) => (
  <>
    <h2 className="mt-12 text-[13px] uppercase tracking-[0.08em] text-ink/55">Activity</h2>
    {detail.activity === null ? (
      <p className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-ink/55">
        Charges and refused attempts are not read on this screen yet. That is a feed we do not fetch
        — not a history that is empty.
      </p>
    ) : (
      <>
        <div className="mt-3 border-t border-hairline">
          {/* Ключ — вміст події, не її позиція. Коли стрічку почне давати
              індексатор, ключем стане підпис транзакції (`events.signature`). */}
          {detail.activity.map((event) => (
            <div
              key={`${event.date}-${event.description}`}
              className={`border-b border-hairline py-3 text-[13px] ${
                event.rejected ? 'text-rust' : 'text-ink'
              }`}
            >
              <div className="sm:hidden">
                <div className={event.rejected ? 'text-rust' : 'text-ink/80'}>
                  {event.description}
                </div>
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
                <span className="tnum">
                  {event.amount === null ? '—' : formatMoney(event.amount)}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[12px] text-ink/45">
          Showing the last 90 days. Older activity stays on the network.
        </p>
      </>
    )}
  </>
)

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

      <div className="mt-10 border-t border-hairline">
        {secondaryRows(detail).map((row) => (
          <Row key={row.label} label={row.label} value={row.value} mono={row.mono} />
        ))}
      </div>

      <Activity detail={detail} />

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
