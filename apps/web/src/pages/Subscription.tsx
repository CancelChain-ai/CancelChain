import ConsentStrip from '../components/ConsentStrip'
import { formatAmount, type Permission, shortDate } from '../lib/mockData'

interface SubscriptionProps {
  permission: Permission
  onBack: () => void
  onPause: (id: string) => void
  onDontRenew: (id: string) => void
  onCancelNow: (id: string) => void
  onResume: (id: string) => void
  onKeep: (id: string) => void
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-6 border-b border-hairline py-3">
    <span className="text-[13px] text-ink/55">{label}</span>
    <span className="text-[14px] text-ink tnum">{value}</span>
  </div>
)

type TagTone = 'quiet' | 'outline' | 'amber'

const TAG_STYLES: Record<TagTone, string> = {
  quiet: 'text-ink/55 border-transparent bg-rail/60',
  outline: 'text-ink border-ink',
  amber: 'text-amber border-amber',
}

const Tag = ({ children, tone }: { children: string; tone: TagTone }) => (
  <span
    className={`inline-block rounded border px-2 py-[3px] text-[11px] leading-none ${TAG_STYLES[tone]}`}
  >
    {children}
  </span>
)

const Subscription = ({
  permission,
  onBack,
  onPause,
  onDontRenew,
  onCancelNow,
  onResume,
  onKeep,
}: SubscriptionProps) => {
  const {
    id,
    merchant,
    ceiling,
    asset,
    periodDays,
    usedThisPeriod,
    nextCharge,
    recipient,
    state,
    endsOn,
    quietTag,
    viaPlan,
    planName,
    detail,
  } = permission

  const paused = state === 'paused'
  const ending = state === 'ending'
  const unsupported = state === 'unsupported'

  const actionBase =
    'rounded-md border border-ink px-4 py-[10px] text-[13px] transition-colors duration-150 hover:bg-ink/[0.06]'

  const note = unsupported
    ? 'CancelChain only manages USDC permissions. You can still cancel this one.'
    : !viaPlan
      ? 'This permission was given directly, not through a plan. Pausing and scheduling an end are only possible for plan subscriptions. You can still cancel it now.'
      : null

  return (
    <div className="max-w-[640px]">
      <button
        type="button"
        onClick={onBack}
        className="text-[13px] text-ink/55 transition-colors duration-150 hover:text-ink"
      >
        ← My subscriptions
      </button>

      <div className="mt-8">
        <h1 className="text-[28px] font-medium leading-tight">{merchant}</h1>

        {(quietTag || paused || (ending && endsOn)) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {paused && <Tag tone="amber">Paused</Tag>}
            {quietTag && <Tag tone="quiet">{quietTag}</Tag>}
            {ending && endsOn && (
              <Tag tone="outline">{`Ends ${shortDate(endsOn)} — won't renew`}</Tag>
            )}
          </div>
        )}

        <p className="mt-3 text-[14px] text-ink/80 tnum">
          Up to {formatAmount(ceiling, asset)} every {periodDays} days
        </p>
        <p className="mt-1 text-[13px] text-ink/55 tnum">
          {state === 'cancelled'
            ? 'Cancelled — no further charges'
            : nextCharge
              ? `Next charge ${nextCharge}`
              : paused
                ? 'Paused — no charge scheduled'
                : 'No further charge scheduled'}
        </p>
      </div>

      <div className="mt-6">
        <ConsentStrip used={usedThisPeriod} ceiling={ceiling} height={10} />
        <p className="mt-2 text-[12px] text-ink/45 tnum">
          {formatAmount(usedThisPeriod, asset)} of {formatAmount(ceiling, asset)} used this period
        </p>
      </div>

      <div className="mt-10 border-t border-hairline">
        <Row label="Ceiling" value={`${formatAmount(ceiling, asset)} per ${periodDays} days`} />
        <Row label="Used this period" value={formatAmount(usedThisPeriod, asset)} />
        <Row label="Period started" value={detail.periodStarted} />
        <Row label="Next charge" value={nextCharge ?? '—'} />
        <Row label="Recipient" value={recipient} />
        <Row label="Given through" value={planName ?? 'Directly, not through a plan'} />
        <Row label="Permission given" value={detail.givenOn} />
      </div>

      <h2 className="mt-12 text-[13px] uppercase tracking-[0.08em] text-ink/55">Activity</h2>
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
                  {event.amount === null ? '—' : formatAmount(event.amount, asset)}
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
                {event.amount === null ? '—' : formatAmount(event.amount, asset)}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-ink/45">
        Showing the last 90 days. Older activity stays on the network.
      </p>

      {state !== 'cancelled' && (
        <>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            {viaPlan && !unsupported && paused && (
              <button
                type="button"
                onClick={() => onResume(id)}
                className={`${actionBase} text-ink`}
              >
                Resume
              </button>
            )}
            {viaPlan && !unsupported && ending && (
              <button type="button" onClick={() => onKeep(id)} className={`${actionBase} text-ink`}>
                Keep it after all
              </button>
            )}
            {viaPlan && !unsupported && !paused && !ending && (
              <button
                type="button"
                onClick={() => onPause(id)}
                className={`${actionBase} text-ink`}
              >
                Pause
              </button>
            )}
            {viaPlan && !unsupported && !paused && !ending && nextCharge && (
              <button
                type="button"
                onClick={() => onDontRenew(id)}
                className={`${actionBase} text-ink tnum`}
              >
                Don&apos;t renew after {nextCharge}
              </button>
            )}
            <button
              type="button"
              onClick={() => onCancelNow(id)}
              className={`${actionBase} text-rust`}
            >
              Cancel now
            </button>
          </div>

          {note && (
            <p className="mt-3 max-w-[520px] text-[12px] leading-relaxed text-ink/55">{note}</p>
          )}
        </>
      )}
    </div>
  )
}

export default Subscription
