// @vitest-environment jsdom
import type { PlanSubscriber, PlanView } from '@cancelchain/shared'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reviewSubscription } from '../lib/subscribeReview'
import { LiveSubscribe } from './Subscribe'

/**
 * The live subscribe screen (`T036`, `FR-008`): the terms under "What you are
 * signing" come out of the built instructions, a disagreement with the
 * merchant's listing is spelled out, and nothing claims to be signed.
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

async function renderReview(over: Partial<PlanView> = {}) {
  const review = await reviewSubscription(view(over), NOW)
  render(<LiveSubscribe state={{ status: 'ready', review }} onOpenPlan={() => {}} />)
  return review
}

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

  it('never offers a live signature from this screen yet', async () => {
    await renderReview()
    const button = screen.getByRole('button', { name: 'Allow this' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText(/nothing is sent from here/)).toBeTruthy()
  })

  it('a link to a plan that is gone says so, and lets another address be opened', () => {
    const onOpenPlan = vi.fn()
    render(<LiveSubscribe state={{ status: 'missing', plan: PLAN }} onOpenPlan={onOpenPlan} />)
    expect(screen.getByText('There is no plan here')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Plan address'), { target: { value: ` ${PLAN} ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpenPlan).toHaveBeenCalledWith(PLAN)
  })
})
