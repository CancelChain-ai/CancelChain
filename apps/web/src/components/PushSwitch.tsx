import type { PushControls } from '../lib/usePush'

/**
 * Notifications for the connected wallet, in this browser (`T043`).
 *
 * Every state that is not "on" ends with the same promise, because it is true
 * and it is the one that matters (`FR-027`): nothing a push would say is
 * missing from the feed. A switch that only works here and there must not
 * read as a function that only works here and there.
 */
const FEED = 'Every charge and refusal is in the feed either way.'

const LINES = {
  unsupported: `This browser cannot show notifications from here. ${FEED}`,
  disabled: `Notifications are not set up on this server. ${FEED}`,
  blocked: `Notifications are blocked for this site in the browser settings. ${FEED}`,
} as const

export const PushSwitch = ({
  push,
  className = '',
}: {
  push: PushControls | null
  className?: string
}) => {
  if (push === null || push.status === 'checking') return null
  const { status, busy, error } = push

  return (
    <div className={`flex flex-col gap-1 text-[12px] sm:items-end ${className}`}>
      {status === 'off' && (
        <>
          <button
            type="button"
            onClick={push.enable}
            disabled={busy}
            className="self-start rounded-[8px] border border-hairline px-3 py-1.5 text-[12px] text-ink transition-colors duration-150 hover:border-ink/40 disabled:text-ink/45 sm:self-end"
          >
            {busy ? 'Turning notifications on…' : 'Notify me in this browser'}
          </button>
          <span className="text-ink/45">Before a charge is due, and when one is refused.</span>
        </>
      )}
      {status === 'on' && (
        <span className="text-ink/55">
          Notifications on in this browser ·{' '}
          <button
            type="button"
            onClick={push.disable}
            disabled={busy}
            className="underline underline-offset-[3px] hover:text-ink disabled:text-ink/45"
          >
            {busy ? 'turning off…' : 'turn off'}
          </button>
        </span>
      )}
      {(status === 'unsupported' || status === 'disabled' || status === 'blocked') && (
        <span className="text-ink/45">{LINES[status]}</span>
      )}
      {error !== null && (
        <span role="alert" className="text-amber">
          {error}
        </span>
      )}
    </div>
  )
}
