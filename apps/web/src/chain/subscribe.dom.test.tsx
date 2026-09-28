// @vitest-environment jsdom
import type { PlanSubscriber, PlanView } from '@cancelchain/shared'
import { getTransactionDecoder } from '@solana/kit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reviewSubscription, type SubscribeReview } from '../lib/subscribeReview'
import { type SubscribeControls, SubscribeFlow } from './subscribe'

/**
 * The subscription flow (`T037`) with the wallet and the API stubbed: the
 * properties that matter are the order of things — re-read before the wallet,
 * the network before "done" — and those live in the flow, not on the screen.
 */

const SUBSCRIBER_ADDRESS = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'

const mocks = vi.hoisted(() => ({
  signAndSend: vi.fn(),
  readNow: vi.fn(),
  latestLifetime: vi.fn(),
  getPlan: vi.fn(),
}))

vi.mock('@solana/react', () => ({ useSignAndSendTransaction: () => mocks.signAndSend }))
vi.mock('../lib/source', () => ({
  source: {
    actions: { readNow: mocks.readNow, latestLifetime: mocks.latestLifetime },
    plans: { get: mocks.getPlan },
  },
}))
vi.mock('./WalletProvider', () => ({ useWalletEnvironment: () => ({ chain: 'solana:devnet' }) }))
vi.mock('./wallet', () => ({
  useWalletConnection: () => ({ account: { address: SUBSCRIBER_ADDRESS }, wallets: [] }),
  accountSigningSupport: () => 'sign-and-send',
  walletAccountAddress: (account: { address: string }) => account.address,
}))

const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const MERCHANT = 'FGHMNoGvR5zP9K5Cs4XrwZhQnAxNrFEQYH3TK22fBkKF'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'

const SUBSCRIBER: PlanSubscriber = {
  address: SUBSCRIBER_ADDRESS,
  authority: 'CivSovG4Kriz5ZMEVm1wbSjqZcqLTGesA3bHxUdLxLsr',
  authorityInitId: null,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  tokenAccount: 'ETWQPJL6dcCrL1T3rAstz2gdGvnf5sYrN3TbR6JWygHN',
  tokenAccountExists: true,
  subscription: 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2',
  subscribed: false,
}

function view(chainOver: Partial<PlanView['chain']> = {}): PlanView {
  return {
    chain: {
      pda: PLAN,
      merchant: MERCHANT,
      planId: '1789990423243',
      mint: USDC,
      amount: '9990000',
      periodSeconds: 2_592_000,
      createdAt: '2026-09-21T11:33:43.000Z',
      status: 'active',
      endsAt: null,
      destinations: [MERCHANT],
      pullers: [MERCHANT],
      ...chainOver,
    },
    catalog: { state: 'unavailable' },
    diverged: [],
    assetSupported: true,
    subscriber: SUBSCRIBER,
    syncedAt: '2026-09-28T12:00:00.000Z',
  }
}

const LIFETIME = {
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
  lastValidBlockHeight: 492_096_495n,
}

let queryClient: QueryClient

function run(review: SubscribeReview) {
  let controls: SubscribeControls | null = null
  render(
    <QueryClientProvider client={queryClient}>
      <SubscribeFlow>
        {(current) => {
          controls = current
          return null
        }}
      </SubscribeFlow>
    </QueryClientProvider>,
  )
  const current = () => {
    if (controls === null) throw new Error('the flow did not render')
    return controls
  }
  act(() => current().subscribe?.(review))
  return current
}

beforeEach(() => {
  queryClient = new QueryClient()
  mocks.latestLifetime.mockResolvedValue(LIFETIME)
  mocks.signAndSend.mockResolvedValue({ signature: new Uint8Array(64).fill(7) })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SubscribeFlow', () => {
  it('the same plan: one signature, then "done" only once the network shows the account', async () => {
    const shown = await reviewSubscription(view())
    mocks.getPlan.mockResolvedValue(view())
    mocks.readNow.mockResolvedValue({ pda: SUBSCRIBER.subscription })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const controls = run(shown)
    await waitFor(() => expect(controls().state.status).toBe('done'))

    expect(mocks.getPlan).toHaveBeenCalledWith(PLAN, SUBSCRIBER_ADDRESS)
    expect(mocks.signAndSend).toHaveBeenCalledTimes(1)
    const [{ transaction }] = mocks.signAndSend.mock.calls[0] as [{ transaction: Uint8Array }]
    const decoded = getTransactionDecoder().decode(transaction)
    expect(Object.keys(decoded.signatures)).toEqual([SUBSCRIBER_ADDRESS])
    expect(mocks.readNow).toHaveBeenCalledWith(SUBSCRIBER.subscription)
    expect(controls().state).toMatchObject({ subscription: SUBSCRIBER.subscription })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['allowances'] })
  })

  it('a plan changed since the screen was drawn never reaches the wallet', async () => {
    const shown = await reviewSubscription(view())
    mocks.getPlan.mockResolvedValue(view({ amount: '19990000' }))

    const controls = run(shown)
    await waitFor(() => expect(controls().state.status).toBe('stopped'))

    expect(controls().state).toEqual({ status: 'stopped', reason: 'changed' })
    expect(mocks.signAndSend).not.toHaveBeenCalled()
    expect(mocks.latestLifetime).not.toHaveBeenCalled()
  })

  it('already subscribed by the time of the click is an answer, not a second signature', async () => {
    const shown = await reviewSubscription(view())
    mocks.getPlan.mockResolvedValue({ ...view(), subscriber: { ...SUBSCRIBER, subscribed: true } })

    const controls = run(shown)
    await waitFor(() => expect(controls().state.status).toBe('stopped'))

    expect(controls().state).toMatchObject({ reason: 'blocked', block: { reason: 'subscribed' } })
    expect(mocks.signAndSend).not.toHaveBeenCalled()
  })

  it('a declined signature is said as a decision, and nothing is polled', async () => {
    const shown = await reviewSubscription(view())
    mocks.getPlan.mockResolvedValue(view())
    mocks.signAndSend.mockRejectedValue(new Error('User rejected the request.'))

    const controls = run(shown)
    await waitFor(() => expect(controls().state.status).toBe('failed'))

    expect(controls().state).toMatchObject({ message: expect.stringContaining('You declined') })
    expect(mocks.readNow).not.toHaveBeenCalled()
  })
})
