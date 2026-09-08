import { type KeyboardEvent, type MouseEvent, useState } from 'react'
import { type AllowanceView, everyPeriod, formatMoney, shortDay } from '../lib/view'
import ConsentStrip from './ConsentStrip'

/**
 * Одна картка списку. Читає модель показу (`lib/view.ts`), тож однаково працює
 * і на моці M0, і на прочитаному з devnet.
 *
 * Дві речі тут — не косметика:
 *
 * — **над дозволом у чужому активі немає жодної дії, крім скасування**
 *   (`FR-020`). Він у списку саме тому, що інакше єдиний спосіб його закрити
 *   зник би разом із карткою;
 * — **`used === null` не малюється порожньою смужкою.** Для разового дозволу
 *   мережа не зберігає, скільки з нього вже взяли, і смужка «0 з 24» сказала б
 *   те, чого ніхто не знає.
 */

interface AllowanceCardProps {
  view: AllowanceView
  /** Немає — картка нікуди не веде: екрана картки для цього джерела ще немає. */
  onOpen?: ((id: string) => void) | undefined
  /** Немає — кнопки скасування немає. Кнопка, яка нічого не робить, гірша за її відсутність. */
  onCancel?: ((id: string) => void) | undefined
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

/** «Up to 24.00 USDC every 30 days» — або без періоду, якщо його немає. */
export function capSentence(view: AllowanceView): string {
  const cap = formatMoney(view.cap)
  if (view.periodSeconds === null) return `Up to ${cap}, one-off`
  return `Up to ${cap} ${everyPeriod(view.periodSeconds)}`
}

/**
 * Чому вичерпаний дозвіл більше не може списати.
 *
 * Для разового дозволу `cap` — це **залишок**, а не початкова стеля (структура
 * акаунта тримає саме залишок), тож нуль у ньому відрізняє «усе взято» від
 * «сплив строк». Для решти вичерпаність буває лише через строк.
 */
export function exhaustedSentence(view: AllowanceView): string {
  if (view.kind === 'fixed' && view.cap.amount === 0n) {
    return 'Nothing is left on this one-off permission. It cannot charge again.'
  }
  return 'Past its expiry. It cannot charge again.'
}

const AllowanceCard = ({ view, onOpen, onCancel }: AllowanceCardProps) => {
  const [confirming, setConfirming] = useState(false)

  const { id, title, counterparty, counterpartyLabel, kindLabel, status } = view
  const revoked = status === 'revoked'
  const paused = status === 'paused'
  const exhausted = status === 'exhausted'
  const periodEnd = view.nextCharge ?? view.endsOn ?? view.expiresOn

  const stop = (event: MouseEvent) => event.stopPropagation()

  const openConfirm = (event: MouseEvent) => {
    event.stopPropagation()
    setConfirming(true)
  }

  const onCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (onOpen === undefined) return
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.key === ' ') event.preventDefault()
      onOpen(id)
    }
  }

  const buttonBase =
    'w-full rounded-md border border-ink py-[10px] text-[13px] transition-colors duration-150 hover:bg-ink/[0.06]'

  // Поки відкрите підтвердження, картка не веде нікуди: клік по ній не має
  // забирати людину на інший екран посеред рішення про скасування.
  const interactive = onOpen !== undefined && !revoked && !confirming

  const confirmSentence = paused
    ? 'Cancelling stops all future charges immediately. You are not being charged while it is paused, but the permission still exists until you cancel it.'
    : periodEnd
      ? `Cancelling stops all future charges immediately. You have already paid for the period ending ${shortDay(periodEnd)} — whether they let you keep using the service until then is their decision, not ours.`
      : 'Cancelling stops all future charges immediately. You have already paid for the current period — whether they let you keep using the service until then is their decision, not ours.'

  return (
    <div
      {...(interactive
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: () => onOpen?.(id),
            onKeyDown: onCardKeyDown,
          }
        : {})}
      className={[
        'overflow-hidden rounded-[10px] border bg-ground text-left transition-colors duration-150',
        view.assetSupported ? 'border-hairline' : 'border-dashed border-hairline',
        interactive
          ? 'cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ink'
          : 'cursor-default',
      ].join(' ')}
    >
      {!revoked && view.used !== null && !view.periodElapsed && (
        /*
         * `Number` тут безпечний рівно тому, що з цих двох робиться **частка**,
         * а не показане число: смужка не пише суму, і втрачені молодші розряди
         * u64 не змінюють жодного пікселя. Сама сума нижче йде через `bigint`.
         *
         * Минулий період смужки не отримує зовсім: повна смужка над скінченим
         * періодом читалася б як «більше взяти не можуть», а це протилежність
         * правди — стеля скинеться на першому ж списанні.
         */
        <ConsentStrip used={Number(view.used.amount)} ceiling={Number(view.cap.amount)} />
      )}

      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div
            className={[
              'leading-tight',
              title === null ? 'font-mono text-[15px]' : 'text-[18px] font-medium',
              revoked ? 'text-ink/45 line-through' : 'text-ink',
            ].join(' ')}
          >
            {title ?? counterparty}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Tag>{kindLabel}</Tag>
            {revoked && <Tag tone="grey">Cancelled</Tag>}
            {paused && <Tag tone="amber">Paused</Tag>}
            {exhausted && <Tag tone="grey">Cannot charge</Tag>}
          </div>
        </div>

        {view.note !== null && !revoked && (
          <div className="mt-2">
            <Tag>{view.note}</Tag>
          </div>
        )}

        <p className={`mt-3 text-[14px] tnum ${revoked ? 'text-ink/45' : 'text-ink/80'}`}>
          {capSentence(view)}
        </p>

        {!revoked && (
          <div className="mt-4 space-y-1 text-[13px] text-ink/55">
            {/*
              Адреса не повторюється двічі. Коли назви немає, заголовок сам є
              адресою, і рядок під ним лише каже, що це за адреса.
            */}
            <div className="tnum">
              {counterpartyLabel}
              {title !== null && (
                <>
                  {' '}
                  <span className="font-mono">{counterparty}</span>
                </>
              )}
            </div>

            {view.used === null ? (
              // Не «0.00» і не порожня смужка: мережа цього не зберігає.
              <div>The network does not record what a one-off permission has already spent</div>
            ) : view.periodElapsed ? (
              <div className="tnum">
                Used {formatMoney(view.used)} in the period that ended
                {view.nextCharge ? ` ${shortDay(view.nextCharge)}` : ''}
              </div>
            ) : (
              <div className="tnum">Used this period {formatMoney(view.used)}</div>
            )}

            {exhausted ? (
              <div className="pt-1">{exhaustedSentence(view)}</div>
            ) : view.endsOn !== null ? (
              <div className="pt-1">
                <Tag tone="outline">{`Ends ${shortDay(view.endsOn)} — won't renew`}</Tag>
              </div>
            ) : paused ? (
              <div className="tnum">Next charge paused</div>
            ) : view.periodElapsed ? (
              // Мережа скидає витрачене не за годинником, а списанням, тож
              // «наступне списання 26 May» у минулому — це «будь-якої миті».
              <div>Next charge any time now — the period has ended and the ceiling resets</div>
            ) : (
              <div className="tnum">
                Next charge {view.nextCharge ? shortDay(view.nextCharge) : '—'}
              </div>
            )}

            {!exhausted && view.expiresOn !== null && (
              <div className="tnum">Expires {shortDay(view.expiresOn)}</div>
            )}
          </div>
        )}

        {!view.assetSupported && !revoked && (
          <p className="mt-4 text-[12px] leading-relaxed text-ink/55">
            CancelChain only manages USDC permissions, so it offers nothing here but cancelling —
            and it is not counted in the total above. You can still cancel it.
          </p>
        )}

        {revoked && (
          <p className="mt-4 text-[12px] text-ink/45">
            No further charges can be made under this permission.
          </p>
        )}

        {onCancel !== undefined && !revoked && !confirming && (
          <div className="mt-5 flex flex-col gap-2">
            <button type="button" onClick={openConfirm} className={`${buttonBase} text-rust`}>
              Cancel
            </button>
          </div>
        )}

        {onCancel !== undefined && !revoked && confirming && (
          <div className="mt-5 rounded-md border border-hairline p-4">
            <p className="text-[13px] leading-relaxed text-ink/80">{confirmSentence}</p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={(event) => {
                  stop(event)
                  setConfirming(false)
                  onCancel(id)
                }}
                className="flex-1 rounded-md border border-rust bg-rust py-[10px] text-[13px] text-ground transition-opacity duration-150 hover:opacity-90"
              >
                Cancel this permission
              </button>
              <button
                type="button"
                onClick={(event) => {
                  stop(event)
                  setConfirming(false)
                }}
                className="flex-1 rounded-md border border-ink py-[10px] text-[13px] text-ink transition-colors duration-150 hover:bg-ink/[0.06]"
              >
                Keep it
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default AllowanceCard
