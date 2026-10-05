import type { LiveState } from '../lib/useStream'

/**
 * Whether what is on screen keeps itself current (`T042a`).
 *
 * `SC-006` and `SC-009` are kept by the stream, so when the stream is down the
 * page has to say so: a list that looks live and is not would show a cancelled
 * permission as active without a hint that it might be stale. `off` says
 * nothing — no wallet, or the mock, where there is nothing to stream.
 */
const LINES: Record<Exclude<LiveState, 'off'>, { text: string; warn: boolean }> = {
  connecting: { text: 'Connecting to live updates…', warn: false },
  live: { text: 'Live — changes appear here as they reach CancelChain.', warn: false },
  reconnecting: { text: 'Live updates interrupted — reconnecting…', warn: true },
  down: {
    text: 'Live updates are off. This is what we read at the time above; it is read again when you come back to this tab.',
    warn: true,
  },
}

export const LiveStatus = ({ state, className = '' }: { state: LiveState; className?: string }) => {
  if (state === 'off') return null
  const line = LINES[state]
  return (
    <span
      role="status"
      className={`text-[12px] ${line.warn ? 'text-amber' : 'text-ink/45'} ${className}`}
    >
      {line.text}
    </span>
  )
}
