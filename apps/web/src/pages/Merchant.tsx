import { useState } from 'react'
import { CHARGE_ATTEMPTS, formatAmount, MERCHANT } from '../lib/mockData'

const Merchant = () => {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`https://${MERCHANT.plan.link}`)
    } catch {
      /* clipboard unavailable — the link is visible on screen either way */
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="max-w-[720px]">
      <p className="text-[13px] text-ink/55">{MERCHANT.name}</p>
      <p className="mt-2 text-[40px] font-medium leading-none tracking-tight tnum sm:text-[48px]">
        {MERCHANT.activePermissions} active permissions
      </p>
      <p className="mt-3 text-[13px] text-ink/55 tnum">
        {formatAmount(MERCHANT.expectedThisPeriod, MERCHANT.asset)} expected this period
      </p>

      <div className="mt-10 rounded-[10px] border border-hairline p-5 sm:p-6">
        <p className="text-[16px] font-medium tnum">
          {MERCHANT.plan.name} — {formatAmount(MERCHANT.plan.ceiling, MERCHANT.asset)} every{' '}
          {MERCHANT.plan.periodDays} days
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="break-all text-[13px] text-ink/70">{MERCHANT.plan.link}</span>
          <button
            type="button"
            onClick={copy}
            className="shrink-0 rounded-md border border-ink px-3 py-2 text-[12px] text-ink transition-colors duration-150 hover:bg-ink/[0.06]"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>

      <h2 className="mt-12 text-[13px] uppercase tracking-[0.08em] text-ink/55">
        Recent charge attempts
      </h2>
      <div className="mt-3 border-t border-hairline">
        {CHARGE_ATTEMPTS.map((attempt) => (
          <div
            key={`${attempt.subscriber}-${attempt.when}`}
            className={`grid grid-cols-[minmax(84px,auto)_1fr] gap-x-4 gap-y-1 border-b border-hairline py-3 text-[13px] sm:grid-cols-[100px_1fr_auto_92px] sm:items-baseline ${
              attempt.rejected ? 'text-rust' : 'text-ink'
            }`}
          >
            <span className="tnum text-ink/55">{attempt.subscriber}</span>
            <span className={attempt.rejected ? 'text-rust' : 'text-ink/80'}>{attempt.result}</span>
            <span className="tnum">
              {attempt.amount === null ? '—' : formatAmount(attempt.amount, MERCHANT.asset)}
            </span>
            <span className="tnum text-ink/55 sm:text-right">{attempt.when}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default Merchant
