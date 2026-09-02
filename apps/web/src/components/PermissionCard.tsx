import { type KeyboardEvent, type MouseEvent, useState } from 'react'
import { formatAmount, type Permission } from '../lib/mockData'
import ConsentStrip from './ConsentStrip'

interface PermissionCardProps {
  permission: Permission
  onOpen: (id: string) => void
  onCancel: (id: string) => void
  onResume: (id: string) => void
  onKeep: (id: string) => void
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

/** '27 Sep 2026' -> '27 Sep'. The full date stays on the detail screen. */
export function shortDate(date: string): string {
  return date.split(' ').slice(0, 2).join(' ')
}

const PermissionCard = ({
  permission,
  onOpen,
  onCancel,
  onResume,
  onKeep,
}: PermissionCardProps) => {
  const [confirming, setConfirming] = useState(false)

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
  } = permission

  const cancelled = state === 'cancelled'
  const paused = state === 'paused'
  const ending = state === 'ending'
  const unsupported = state === 'unsupported'

  const periodEnd = nextCharge ?? endsOn ?? null

  const openConfirm = (event: MouseEvent) => {
    event.stopPropagation()
    setConfirming(true)
  }

  const stop = (event: MouseEvent) => event.stopPropagation()

  const onCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.key === ' ') event.preventDefault()
      onOpen(id)
    }
  }

  const buttonBase =
    'w-full rounded-md border border-ink py-[10px] text-[13px] transition-colors duration-150 hover:bg-ink/[0.06]'

  // Поки відкрите підтвердження, картка не веде нікуди: клік по ній не має
  // забирати людину на інший екран посеред рішення про скасування.
  const interactive = !cancelled && !confirming

  const confirmSentence = paused
    ? `Cancelling stops all future charges immediately. You are not being charged while it is paused, but the permission still exists until you cancel it.`
    : periodEnd
      ? `Cancelling stops all future charges immediately. You have already paid ${merchant} for the period ending ${periodEnd} — whether they let you keep using the service until then is their decision, not ours.`
      : `Cancelling stops all future charges immediately. You have already paid ${merchant} for the current period — whether they let you keep using the service until then is their decision, not ours.`

  return (
    <div
      {...(interactive
        ? {
            role: 'button',
            tabIndex: 0,
            onClick: () => onOpen(id),
            onKeyDown: onCardKeyDown,
          }
        : {})}
      className={[
        'overflow-hidden rounded-[10px] border bg-ground text-left transition-colors duration-150',
        unsupported ? 'border-dashed border-hairline' : 'border-hairline',
        cancelled
          ? 'cursor-default'
          : 'cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-ink',
      ].join(' ')}
    >
      {!cancelled && <ConsentStrip used={usedThisPeriod} ceiling={ceiling} />}

      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div
            className={`text-[18px] font-medium leading-tight ${
              cancelled ? 'text-ink/45 line-through' : 'text-ink'
            }`}
          >
            {merchant}
          </div>
          {cancelled && <Tag tone="grey">Cancelled just now</Tag>}
          {paused && <Tag tone="amber">Paused</Tag>}
        </div>

        {quietTag && !cancelled && (
          <div className="mt-2">
            <Tag>{quietTag}</Tag>
          </div>
        )}

        <p className={`mt-3 text-[14px] tnum ${cancelled ? 'text-ink/45' : 'text-ink/80'}`}>
          Up to {formatAmount(ceiling, asset)} every {periodDays} days
        </p>

        {!cancelled && (
          <div className="mt-4 space-y-1 text-[13px] text-ink/55">
            <div className="tnum">To {recipient}</div>
            <div className="tnum">Used this period {formatAmount(usedThisPeriod, asset)}</div>
            {ending && endsOn ? (
              <div className="pt-1">
                <Tag tone="outline">{`Ends ${shortDate(endsOn)} — won't renew`}</Tag>
              </div>
            ) : (
              <div className="tnum">Next charge {paused ? 'paused' : (nextCharge ?? '—')}</div>
            )}
          </div>
        )}

        {unsupported && (
          <p className="mt-4 text-[12px] leading-relaxed text-ink/55">
            CancelChain only manages USDC permissions. You can still cancel this one.
          </p>
        )}

        {cancelled && (
          <p className="mt-4 text-[12px] text-ink/45">
            No further charges can be made by this merchant.
          </p>
        )}

        {!cancelled && !confirming && (
          <div className="mt-5 flex flex-col gap-2">
            {ending && (
              <button
                type="button"
                onClick={(e) => {
                  stop(e)
                  onKeep(id)
                }}
                className={`${buttonBase} text-ink`}
              >
                Keep it after all
              </button>
            )}
            {paused && (
              <button
                type="button"
                onClick={(e) => {
                  stop(e)
                  onResume(id)
                }}
                className={`${buttonBase} text-ink`}
              >
                Resume
              </button>
            )}
            <button type="button" onClick={openConfirm} className={`${buttonBase} text-rust`}>
              Cancel
            </button>
          </div>
        )}

        {!cancelled && confirming && (
          <div className="mt-5 rounded-md border border-hairline p-4">
            <p className="text-[13px] leading-relaxed text-ink/80">{confirmSentence}</p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false)
                  onCancel(id)
                }}
                className="flex-1 rounded-md border border-rust bg-rust py-[10px] text-[13px] text-ground transition-opacity duration-150 hover:opacity-90"
              >
                Cancel this permission
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
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

export default PermissionCard
