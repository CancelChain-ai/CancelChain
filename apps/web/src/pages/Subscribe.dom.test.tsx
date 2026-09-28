// @vitest-environment jsdom
import type { PlanSubscriber, PlanView } from '@cancelchain/shared'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubscribeControls, SubscribeState } from '../chain/subscribe'
import { reviewSubscription } from '../lib/subscribeReview'
import { LiveSubscribe } from './Subscribe'

/**
 * The live subscribe screen (`T036`, `FR-008`): the terms under "What you are
 * signing" come out of the built instructions, a disagreement with the
 * merchant's listing is spelled out. `T037`: one click hands the reviewed offer
 * to the flow, and every state of the flow is said in words.
 */

const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const MERCHANT = 'FGHMNoGvR5zP9K5Cs4XrwZhQnAxNrFEQYH3TK22fBkKF'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const CREATED_AT = '2026-09-21T11:33:43.000Z'
const NOW = new Date('2026-09-26T12:00:00.000Z')

const SUBSCRIBER: PlanSubscriber = {
  address: 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR',
  authority: 'CivSovG4Kriz5ZMEVm1wbSjqZcqLTGesA3bHxUdLxLsr',
  authorityInitId: null,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  tokenAccount: 'ETWQPJL6dcCrL1T3rAstz2gdGvnf5sYrN3TbR6JWygHN',
  tokenAccountExists: true,
  subscription: 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2',
  subscribed: false,
}

const LISTED = {
  pda: PLAN,
  merchant: MERCHANT,
  planId: '1789990423243',
  name: 'Studio monthly',
  amount: '9990000',
  periodSeconds: 2_592_000,
  mint: USDC,
  createdAt: CREATED_AT,
}

function view(over: Partial<PlanView> = {}): PlanView {
  return {
    chain: {
      pda: PLAN,
      merchant: MERCHANT,
      planId: '1789990423243',
      mint: USDC,
      amount: '9990000',
      periodSeconds: 2_592_000,
      createdAt: CREATED_AT,
      status: 'active',
      endsAt: null,
      destinations: [MERCHANT],
      pullers: [MERCHANT],
    },
    catalog: { state: 'named', plan: LISTED },
    diverged: [],
    assetSupported: true,
    subscriber: SUBSCRIBER,
    syncedAt: '2026-09-26T11:59:58.000Z',
    ...over,
  }
}

function controlsWith(over: Partial<SubscribeControls> = {}): SubscribeControls {
  return {
    state: { status: 'idle' },
    subscribe: vi.fn(),
    unavailable: null,
    dismiss: () => {},
    ...over,
  }
}

const explorerUrl = (signature: string) => `https://explorer.test/tx/${signature}`

async function renderReview(
  over: Partial<PlanView> = {},
  controls: SubscribeControls = controlsWith(),
  onDone: () => void = () => {},
) {
  const review = await reviewSubscription(view(over), NOW)
  render(
    <LiveSubscribe
      state={{ status: 'ready', review }}
      onOpenPlan={() => {}}
      controls={controls}
      onDone={onDone}
      explorerUrl={explorerUrl}
    />,
  )
  return review
}

const allowButton = () => screen.getByRole('button', { name: 'Allow this' }) as HTMLButtonElement

afterEach(cleanup)

describe('LiveSubscribe', () => {
  it('shows the transaction terms, under a heading that says they are what gets signed', async () => {
    await renderReview()
    expect(screen.getByText('Studio monthly')).toBeTruthy()
    expect(screen.getByText('What you are signing')).toBeTruthy()
    expect(screen.getByText('Up to 9.99 USDC')).toBeTruthy()
    expect(screen.getByText('Every 30 days')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names the parts that are not in the transaction, and who can change them', async () => {
    await renderReview()
    expect(screen.getByText('Not in the transaction')).toBeTruthy()
    expect(screen.getByText(/can change this list after you subscribe/)).toBeTruthy()
    expect(screen.getByText(/Fixed when the plan was created/)).toBeTruthy()
    expect(screen.getByText('The plan has no end date.')).toBeTruthy()
  })

  it('says the authority is created in the same transaction', async () => {
    await renderReview()
    expect(screen.getByText(/also sets up your spending authority/)).toBeTruthy()
  })

  it('spells out a mismatch with the listing, next to the field and in a banner', async () => {
    await renderReview({ catalog: { state: 'named', plan: { ...LISTED, amount: '990000' } } })
    expect(screen.getByRole('alert').textContent).toContain('ceiling per period')
    expect(screen.getByText("The merchant's listing says: Up to 0.99 USDC")).toBeTruthy()
    // The transaction's own value stays what is shown as the term.
    expect(screen.getByText('Up to 9.99 USDC')).toBeTruthy()
  })

  it('says the catalog could not be checked, instead of implying it agrees', async () => {
    await renderReview({ catalog: { state: 'unavailable' } })
    expect(screen.getByText('Plan name unavailable')).toBeTruthy()
    expect(screen.getByText(/could not be reached/)).toBeTruthy()
  })

  it('without a wallet it shows the network plan and says nothing was built', async () => {
    await renderReview({ subscriber: null })
    expect(screen.getByText('The plan on the network')).toBeTruthy()
    expect(screen.queryByText('What you are signing')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Connect a wallet')
  })

  it('one click hands exactly the reviewed offer to the flow', async () => {
    const controls = controlsWith()
    const review = await renderReview({}, controls)
    expect(allowButton().disabled).toBe(false)
    fireEvent.click(allowButton())
    expect(controls.subscribe).toHaveBeenCalledTimes(1)
    expect(controls.subscribe).toHaveBeenCalledWith(review)
    expect(screen.getByText(/One signature, in your wallet/)).toBeTruthy()
  })

  it('a blocked offer is not signable even with a wallet that can sign', async () => {
    const controls = controlsWith()
    await renderReview({ subscriber: { ...SUBSCRIBER, subscribed: true } }, controls)
    expect(allowButton().disabled).toBe(true)
    fireEvent.click(allowButton())
    expect(controls.subscribe).not.toHaveBeenCalled()
  })

  it('without signing, the button is off and the reason is said', async () => {
    await renderReview(
      {},
      controlsWith({ subscribe: null, unavailable: 'Connect a wallet to subscribe.' }),
    )
    expect(allowButton().disabled).toBe(true)
    expect(screen.getByText('Connect a wallet to subscribe.')).toBeTruthy()
  })

  it('while the flow runs, the button is off and the step is named', async () => {
    const controls = controlsWith({ state: { status: 'working', step: 'confirming' } })
    await renderReview({}, controls)
    expect(allowButton().disabled).toBe(true)
    expect(screen.getByText(/Waiting for the network to show the subscription/)).toBeTruthy()
  })

  it('a plan that changed before the wallet says nothing was sent', async () => {
    const stopped: SubscribeState = { status: 'stopped', reason: 'changed' }
    await renderReview({}, controlsWith({ state: stopped }))
    const alert = screen.getAllByRole('alert').at(-1)
    expect(alert?.textContent).toContain('nothing was sent to your wallet')
  })

  it('a confirmed subscription says so, links the transaction, and leads to the list', async () => {
    const onDone = vi.fn()
    const done: SubscribeState = {
      status: 'done',
      subscription: SUBSCRIBER.subscription,
      signature: '5xSig111111111111111111111111111111111111111111111111111111111111',
    }
    await renderReview({}, controlsWith({ state: done }), onDone)
    expect(screen.getByText('Permission given')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Allow this' })).toBeNull()
    expect(screen.getByRole('link').getAttribute('href')).toBe(explorerUrl(done.signature))
    fireEvent.click(screen.getByRole('button', { name: 'See it in my subscriptions' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('sent but not seen is not called a success', async () => {
    const unconfirmed: SubscribeState = {
      status: 'unconfirmed',
      subscription: SUBSCRIBER.subscription,
      signature: '5xSig111111111111111111111111111111111111111111111111111111111111',
    }
    await renderReview({}, controlsWith({ state: unconfirmed }))
    expect(screen.queryByText('Permission given')).toBeNull()
    expect(screen.getByText('Sent, not seen yet')).toBeTruthy()
  })

  it('a link to a plan that is gone says so, and lets another address be opened', () => {
    const onOpenPlan = vi.fn()
    render(
      <LiveSubscribe
        state={{ status: 'missing', plan: PLAN }}
        onOpenPlan={onOpenPlan}
        controls={controlsWith()}
        onDone={() => {}}
        explorerUrl={explorerUrl}
      />,
    )
    expect(screen.getByText('There is no plan here')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Plan address'), { target: { value: ` ${PLAN} ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenPlan).toHaveBeenCalledWith(PLAN)
  })
})
