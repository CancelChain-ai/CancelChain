import type { PlanTermField } from '@cancelchain/shared'
import { type FormEvent, useState } from 'react'
import { type SubscribeControls, type SubscribeState, subscribeStepLabel } from '../chain/subscribe'
import { shortenAddress } from '../chain/wallet'
import { formatAmount, SUBSCRIBE_OFFER } from '../lib/mockData'
import type { ReviewBlock, ReviewTerms, SubscribeReview } from '../lib/subscribeReview'
import type { SubscribeReviewState } from '../lib/useSubscribeReview'
import { everyPeriod, formatClock, formatDay, formatMoney } from '../lib/view'

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

/*
 * The live screen (`T036`, `FR-008`). Everything under "What you are signing"
 * is decoded from the instructions that will be signed (`subscribeReview.ts`);
 * the plan on the network and the merchant's catalog row are only what it is
 * compared with. The signature itself is `T037` (`chain/subscribe.tsx`).
 *
 * No colour marks a mismatch: colour here carries consent state only
 * (`tailwind.config.js`). A mismatch is marked by a border and by words.
 */

const FIELD_LABELS = {
  amount: 'Ceiling per period',
  periodSeconds: 'Period',
  mint: 'Asset',
  createdAt: 'Plan version',
} as const satisfies Record<PlanTermField, string>

const FIELD_ORDER: PlanTermField[] = ['amount', 'periodSeconds', 'mint', 'createdAt']

function termValue(field: PlanTermField, terms: ReviewTerms): string {
  switch (field) {
    case 'amount':
      return `Up to ${formatMoney(terms.perPeriod)}`
    case 'periodSeconds':
      return everyPeriod(terms.periodSeconds).replace(/^every/, 'Every')
    case 'mint':
      return `${terms.perPeriod.label} · ${shortenAddress(terms.mint)}`
    case 'createdAt':
      return terms.createdAt === null
        ? 'Unknown: the plan carries no creation time'
        : `Created ${formatDay(terms.createdAt)}, ${formatClock(terms.createdAt)}`
  }
}

function fieldList(fields: readonly PlanTermField[]): string {
  return fields.map((field) => FIELD_LABELS[field].toLowerCase()).join(', ')
}

export function blockMessage(block: ReviewBlock): string {
  switch (block.reason) {
    case 'wallet':
      return 'Connect a wallet to see the exact transaction. Until then, the terms below are the plan as the network holds it, and nothing has been built for you to sign.'
    case 'subscribed':
      return `This wallet is already subscribed to this plan (${shortenAddress(block.subscription)}). A second subscription would be refused by the network.`
    case 'no-token-account':
      return `This wallet has no account for this token yet (${shortenAddress(block.tokenAccount)}), and a subscription cannot be set up without one. Receive any amount of the token first, then come back.`
    case 'sunset':
      return 'The merchant is winding this plan down. It takes no new subscribers, and the network would refuse the transaction.'
    case 'ended':
      return `This plan ended on ${formatDay(block.endedAt)}. The network would refuse a new subscription.`
    case 'no-created-at':
      return 'This plan carries no creation time, so a subscription cannot pin which plan it agrees to. Nothing is offered for signing.'
    case 'builder-mismatch':
      return `The transaction CancelChain built does not match the plan on the network (${fieldList(block.fields)}). This is our fault, and it is not offered for signing.`
  }
}

function catalogNote(review: SubscribeReview): string | null {
  if (review.catalog === 'unavailable') {
    return "CancelChain's plan catalog could not be reached, so these terms were not compared with what the merchant listed. They come from the network only."
  }
  if (review.catalog === 'unnamed') {
    return "The merchant has not listed this plan in CancelChain's catalog. There is nothing to compare with: the terms come from the network only."
  }
  return null
}

const Row = ({ label, value, listed }: { label: string; value: string; listed?: string }) => (
  <div>
    <p className="text-[12px] text-ink/55">{label}</p>
    <p className="mt-1 text-[20px] font-medium leading-snug tnum">{value}</p>
    {listed !== undefined && (
      <p className="mt-1 text-[12px] font-medium tnum">The merchant's listing says: {listed}</p>
    )}
  </div>
)

/** Why the flow stopped before the wallet. Nothing was signed in any of these. */
export function stoppedMessage(state: Extract<SubscribeState, { status: 'stopped' }>): string {
  switch (state.reason) {
    case 'changed':
      return 'The plan changed while this screen was open, so nothing was sent to your wallet. The terms above are the plan as the network holds it now. Check them again.'
    case 'missing':
      return 'The plan is gone from the network, so nothing was sent to your wallet.'
    case 'blocked':
      return `Nothing was sent to your wallet. ${blockMessage(state.block)}`
  }
}

/** The line under the button: what is happening, or why nothing can. */
function flowNote(controls: SubscribeControls, review: SubscribeReview): string {
  const { state } = controls
  if (state.status === 'working') return subscribeStepLabel(state.step)
  if (state.status === 'stopped') return stoppedMessage(state)
  if (state.status === 'failed') return state.message
  if (controls.unavailable !== null) return controls.unavailable
  if (review.transaction === null)
    return 'There is nothing to sign until the note above is resolved.'
  return 'One signature, in your wallet. You keep the money until each charge happens.'
}

const Given = ({
  review,
  state,
  onDone,
  explorerUrl,
}: {
  review: SubscribeReview
  state: Extract<SubscribeState, { status: 'done' | 'unconfirmed' }>
  onDone: () => void
  explorerUrl: (signature: string) => string | null
}) => {
  const url = explorerUrl(state.signature)
  const confirmed = state.status === 'done'
  return (
    <>
      <h1 className="text-[24px] font-medium leading-tight">
        {confirmed ? 'Permission given' : 'Sent, not seen yet'}
      </h1>
      <p role="status" className="mt-3 text-[14px] leading-relaxed text-ink/70 tnum">
        {confirmed
          ? `${shortenAddress(review.merchant)} can now charge up to ${formatMoney(review.terms.perPeriod)} ${everyPeriod(review.terms.periodSeconds)}. The network holds the subscription at ${shortenAddress(state.subscription)}.`
          : `Your wallet sent the transaction, but the network does not show the subscription at ${shortenAddress(state.subscription)} yet. It may still land, or it may not have. Your subscriptions list reads the network each time it opens.`}
      </p>
      {url !== null && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mt-3 block text-[12px] text-ink/55 underline underline-offset-4 tnum"
        >
          Transaction {shortenAddress(state.signature, 6)}
        </a>
      )}
      <button
        type="button"
        onClick={onDone}
        className="mt-6 text-[13px] text-ink underline underline-offset-4 transition-opacity duration-150 hover:opacity-70"
      >
        See it in my subscriptions
      </button>
    </>
  )
}

const Review = ({ review, controls }: { review: SubscribeReview; controls: SubscribeControls }) => {
  const signing = review.termsSource === 'transaction'
  const note = catalogNote(review)
  const { listed } = review
  const { subscribe } = controls
  const signable =
    subscribe !== null &&
    review.transaction !== null &&
    review.blocked === null &&
    controls.state.status !== 'working'

  return (
    <>
      <p className="text-[13px] text-ink/55">
        {review.name ??
          (review.catalog === 'unavailable' ? 'Plan name unavailable' : 'Unnamed plan')}
      </p>
      <h1 className="mt-3 text-[22px] font-medium leading-snug">
        {shortenAddress(review.merchant)} wants permission to charge this wallet.
      </h1>

      {review.blocked !== null && (
        <p
          role="status"
          className="mt-6 rounded-md border border-hairline px-4 py-3 text-[13px] leading-relaxed"
        >
          {blockMessage(review.blocked)}
        </p>
      )}

      {review.mismatch.length > 0 && (
        <p
          role="alert"
          className="mt-6 rounded-md border-2 border-ink px-4 py-3 text-[13px] font-medium leading-relaxed"
        >
          This does not match the merchant's listing: {fieldList(review.mismatch)}.
          {signing
            ? ' What you would sign is the transaction below. The network enforces that, not the listing.'
            : ' The network holds the plan below, not the listing.'}
        </p>
      )}

      <h2 className="mt-8 text-[12px] font-medium uppercase tracking-wide text-ink/55">
        {signing ? 'What you are signing' : 'The plan on the network'}
      </h2>
      <div className="mt-4 space-y-5">
        {FIELD_ORDER.map((field) => (
          <Row
            key={field}
            label={FIELD_LABELS[field]}
            value={termValue(field, review.terms)}
            {...(listed !== null && review.mismatch.includes(field)
              ? { listed: termValue(field, listed) }
              : {})}
          />
        ))}
      </div>
      {note !== null && <p className="mt-5 text-[12px] leading-relaxed text-ink/55">{note}</p>}
      {review.transaction?.initsAuthority === true && (
        <p className="mt-5 text-[12px] leading-relaxed text-ink/55">
          The same transaction also sets up your spending authority for this token. That happens
          once per token, and every later charge is checked against it.
        </p>
      )}

      <h2 className="mt-8 text-[12px] font-medium uppercase tracking-wide text-ink/55">
        Not in the transaction
      </h2>
      <div className="mt-4 space-y-3 text-[13px] leading-relaxed">
        <p>
          <span className="text-ink/55">Money can go only to </span>
          <span className="tnum">
            {review.destinations.map((a) => shortenAddress(a)).join(', ')}
          </span>
          <span className="text-ink/55">. Fixed when the plan was created.</span>
        </p>
        <p>
          <span className="text-ink/55">Charges can be started by </span>
          <span className="tnum">{review.pullers.map((a) => shortenAddress(a)).join(', ')}</span>
          <span className="text-ink/55">
            . The merchant can change this list after you subscribe.
          </span>
        </p>
        <p>
          {review.endsAt === null ? (
            <>
              <span>The plan has no end date.</span>
              <span className="text-ink/55">
                {' '}
                The merchant can set one later, and charges stop then.
              </span>
            </>
          ) : (
            <span className="tnum">The plan ends on {formatDay(review.endsAt)}.</span>
          )}
        </p>
      </div>

      <button
        type="button"
        disabled={!signable}
        onClick={() => {
          if (signable) subscribe(review)
        }}
        className={
          signable
            ? 'mt-8 w-full rounded-md border border-ink bg-ink py-3 text-[14px] text-ground transition-opacity duration-150 hover:opacity-90'
            : 'mt-8 w-full cursor-not-allowed rounded-md border border-hairline py-3 text-[14px] text-ink/45'
        }
      >
        Allow this
      </button>
      <p
        {...(controls.state.status === 'stopped' || controls.state.status === 'failed'
          ? { role: 'alert' }
          : {})}
        className="mt-3 text-[12px] leading-relaxed text-ink/55"
      >
        {flowNote(controls, review)}
      </p>
      <p className="mt-6 text-[11px] text-ink/40 tnum">
        Read from the network at {formatClock(review.syncedAt)}.
      </p>
    </>
  )
}

const PlanPicker = ({ onOpen }: { onOpen: (plan: string) => void }) => {
  const [value, setValue] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = value.trim()
    if (trimmed !== '') onOpen(trimmed)
  }
  return (
    <form onSubmit={submit} className="mt-4 flex gap-2">
      <label className="sr-only" htmlFor="plan-address">
        Plan address
      </label>
      <input
        id="plan-address"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Plan address"
        className="min-w-0 flex-1 rounded-md border border-hairline bg-ground px-3 py-2 text-[13px] tnum"
      />
      <button type="submit" className="rounded-md border border-ink px-4 text-[13px]">
        Open
      </button>
    </form>
  )
}

export const LiveSubscribe = ({
  state,
  onOpenPlan,
  controls,
  onDone,
  explorerUrl,
}: {
  state: SubscribeReviewState
  onOpenPlan: (plan: string) => void
  controls: SubscribeControls
  /** Opens the subscriptions list — the third click of `SC-010`. */
  onDone: () => void
  explorerUrl: (signature: string) => string | null
}) => (
  <div className="flex justify-center pt-4">
    <div className="w-full max-w-[520px] rounded-[10px] border border-hairline bg-ground p-6 sm:p-8">
      {state.status === 'no-plan' && (
        <>
          <h1 className="text-[22px] font-medium leading-snug">Subscribe to a plan</h1>
          <p className="mt-3 text-[13px] leading-relaxed text-ink/70">
            A merchant's subscription link opens this screen with the plan filled in. Without one,
            paste the plan's address.
          </p>
          <PlanPicker onOpen={onOpenPlan} />
        </>
      )}
      {state.status === 'loading' && (
        <p className="text-[13px] text-ink/55">Reading the plan from the network…</p>
      )}
      {state.status === 'missing' && (
        <>
          <h1 className="text-[22px] font-medium leading-snug">There is no plan here</h1>
          <p className="mt-3 text-[13px] leading-relaxed text-ink/70 tnum">
            The network has no plan at {shortenAddress(state.plan)}. Its merchant may have deleted
            it, or the link is wrong.
          </p>
          <PlanPicker onOpen={onOpenPlan} />
        </>
      )}
      {state.status === 'error' && (
        <p role="alert" className="text-[13px] leading-relaxed">
          {state.message}
        </p>
      )}
      {state.status === 'ready' &&
        (controls.state.status === 'done' || controls.state.status === 'unconfirmed' ? (
          <Given
            review={state.review}
            state={controls.state}
            onDone={onDone}
            explorerUrl={explorerUrl}
          />
        ) : (
          <Review review={state.review} controls={controls} />
        ))}
    </div>
  </div>
)
