import { useState } from 'react'
import { formatAmount, SUBSCRIBE_OFFER } from '../lib/mockData'

interface SubscribeProps {
  onDone: () => void
  /** Creates the permission. Called once, and only once. */
  onAllow: () => void
  /** True when this plan has already been allowed in this session. */
  alreadyGiven: boolean
}

const Subscribe = ({ onDone, onAllow, alreadyGiven }: SubscribeProps) => {
  const [given, setGiven] = useState(alreadyGiven)
  const { merchant, plan, ceiling, asset, periodDays, recipient } = SUBSCRIBE_OFFER

  return (
    <div className="flex justify-center pt-4">
      <div className="w-full max-w-[480px] rounded-[10px] border border-hairline bg-ground p-6 sm:p-8">
        <p className="text-[13px] text-ink/55">{plan}</p>

        {given ? (
          <div className="mt-6">
            <h1 className="text-[24px] font-medium leading-tight">Permission given</h1>
            <p className="mt-3 text-[14px] leading-relaxed text-ink/70 tnum">
              {merchant} can now charge up to {formatAmount(ceiling, asset)} every {periodDays}{' '}
              days, and only to {recipient}.
            </p>
            <button
              type="button"
              onClick={onDone}
              className="mt-6 text-[13px] text-ink underline underline-offset-4 transition-opacity duration-150 hover:opacity-70"
            >
              See it in my subscriptions
            </button>
          </div>
        ) : (
          <>
            <h1 className="mt-3 text-[22px] font-medium leading-snug">
              {merchant} wants permission to charge this wallet.
            </h1>

            <div className="mt-8 space-y-5">
              <div>
                <p className="text-[12px] text-ink/55">Ceiling</p>
                <p className="mt-1 text-[26px] font-medium leading-none tnum">
                  Up to {formatAmount(ceiling, asset)}
                </p>
              </div>
              <div>
                <p className="text-[12px] text-ink/55">Period</p>
                <p className="mt-1 text-[26px] font-medium leading-none tnum">
                  Every {periodDays} days
                </p>
              </div>
              <div>
                <p className="text-[12px] text-ink/55">Recipient</p>
                <p className="mt-1 text-[26px] font-medium leading-none tnum">
                  Only to {recipient}
                </p>
              </div>
            </div>

            <p className="mt-8 text-[13px] leading-relaxed text-ink tnum">
              This is a ceiling, not a payment. They can never take more than{' '}
              {formatAmount(ceiling, asset)} in a {periodDays}-day period, and you can cancel it in
              two clicks, any time, without asking them.
            </p>

            <button
              type="button"
              onClick={() => {
                if (given || alreadyGiven) return
                setGiven(true)
                onAllow()
              }}
              className="mt-7 w-full rounded-md border border-ink bg-ink py-3 text-[14px] text-ground transition-opacity duration-150 hover:opacity-90"
            >
              Allow this
            </button>

            <p className="mt-3 text-[12px] text-ink/45">
              You keep the money in your wallet until each charge happens.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

export default Subscribe
