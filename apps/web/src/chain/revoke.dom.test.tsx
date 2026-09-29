// @vitest-environment jsdom
import {
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CancelControls, CancelFlow } from './revoke'

/**
 * The cancel flow with the wallet and the API stubbed (T037a). What matters is
 * which transaction reaches the wallet — `cancelSubscription` for a live plan
 * subscription, `revokeDelegation` otherwise, nothing at all while a cancelled
 * subscription runs out its period — and that the end date shown afterwards is
 * the one read back from the network.
 */

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const SUBSCRIPTION = 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2'
const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const DELEGATION = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH'
const CHAIN_END = '2026-10-28T17:07:36.000Z'

/**
 * Instruction discriminators of the Subscriptions program. The web app does not
 * depend on the SDK directly; `packages/chain/src/revoke.test.ts` pins these
 * against it, so a drift fails there first.
 */
const CANCEL_SUBSCRIPTION = 12
const REVOKE_DELEGATION = 3

const mocks = vi.hoisted(() => ({
  signAndSend: vi.fn(),
  readNow: vi.fn(),
  latestLifetime: vi.fn(),
}))

vi.mock('@solana/react', () => ({ useSignAndSendTransaction: () => mocks.signAndSend }))
vi.mock('../lib/source', () => ({
  source: { actions: { readNow: mocks.readNow, latestLifetime: mocks.latestLifetime } },
}))
vi.mock('./WalletProvider', () => ({ useWalletEnvironment: () => ({ chain: 'solana:devnet' }) }))
vi.mock('./wallet', () => ({
  useWalletConnection: () => ({ account: { address: OWNER }, wallets: [] }),
  accountSigningSupport: () => 'sign-and-send',
  walletAccountAddress: (account: { address: string }) => account.address,
}))

const LIFETIME = {
  blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
  lastValidBlockHeight: 492_096_495n,
}

/** Only the fields the flow reads — the rest of the response does not decide anything here. */
function subscription(endsAt: string | null) {
  return {
    pda: SUBSCRIPTION,
    owner: OWNER,
    kind: 'subscription',
    planPda: PLAN,
    endsAt,
    chainState: { slot: 1 },
  }
}

const RECURRING = {
  pda: DELEGATION,
  owner: OWNER,
  kind: 'recurring',
  planPda: null,
  endsAt: null,
  chainState: { slot: 1 },
}

let queryClient: QueryClient

function run(id: string) {
  let controls: CancelControls | null = null
  render(
    <QueryClientProvider client={queryClient}>
      <CancelFlow>
        {(current) => {
          controls = current
          return null
        }}
      </CancelFlow>
    </QueryClientProvider>,
  )
  const current = () => {
    if (controls === null) throw new Error('the flow did not render')
    return controls
  }
  act(() => current().cancel?.(id))
  return current
}

/** The instruction the wallet was handed, identified from the bytes it received. */
function signedInstruction(): number | undefined {
  const [[{ transaction }]] = mocks.signAndSend.mock.calls as [[{ transaction: Uint8Array }]]
  const { messageBytes } = getTransactionDecoder().decode(transaction)
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(messageBytes),
  )
  expect(message.instructions).toHaveLength(1)
  const [instruction] = message.instructions
  if (instruction === undefined || instruction.data === undefined) throw new Error('no data')
  return instruction.data[0]
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

describe('CancelFlow — plan subscriptions (T037a)', () => {
  it('a live subscription gets cancelSubscription, and the date shown is the one the chain wrote', async () => {
    mocks.readNow
      .mockResolvedValueOnce(subscription(null))
      .mockResolvedValueOnce(subscription(CHAIN_END))
    const controls = run(SUBSCRIPTION)

    await waitFor(() => expect(controls().state.status).toBe('scheduled'))
    expect(mocks.signAndSend).toHaveBeenCalledTimes(1)
    expect(signedInstruction()).toBe(CANCEL_SUBSCRIPTION)
    expect(controls().state).toMatchObject({
      status: 'scheduled',
      id: SUBSCRIPTION,
      endsAt: CHAIN_END,
    })
  })

  it('a cancelled subscription inside its period reaches no wallet at all', async () => {
    mocks.readNow.mockResolvedValue(subscription('2999-01-01T00:00:00.000Z'))
    const controls = run(SUBSCRIPTION)

    await waitFor(() => expect(controls().state.status).toBe('scheduled'))
    expect(controls().state).toMatchObject({ signature: null })
    expect(mocks.signAndSend).not.toHaveBeenCalled()
    expect(mocks.latestLifetime).not.toHaveBeenCalled()
  })

  it('a subscription past its date is closed with revokeDelegation', async () => {
    mocks.readNow.mockResolvedValueOnce(subscription('2000-01-01T00:00:00.000Z'))
    mocks.readNow.mockResolvedValueOnce(null)
    const controls = run(SUBSCRIPTION)

    await waitFor(() => expect(controls().state.status).toBe('done'))
    expect(signedInstruction()).toBe(REVOKE_DELEGATION)
  })
})

describe('CancelFlow — delegations and what "gone" means', () => {
  it('a recurring delegation is still closed at once with revokeDelegation', async () => {
    mocks.readNow.mockResolvedValueOnce(RECURRING).mockResolvedValueOnce(null)
    const controls = run(DELEGATION)

    await waitFor(() => expect(controls().state.status).toBe('done'))
    expect(signedInstruction()).toBe(REVOKE_DELEGATION)
  })

  it('a cached row with no account on chain is gone, not something to sign', async () => {
    mocks.readNow.mockResolvedValue({ ...RECURRING, status: 'revoked', chainState: null })
    const controls = run(DELEGATION)

    await waitFor(() => expect(controls().state.status).toBe('gone'))
    expect(mocks.signAndSend).not.toHaveBeenCalled()
  })

  it('closing counts as confirmed only on the network, also when the store keeps the row', async () => {
    mocks.readNow
      .mockResolvedValueOnce(RECURRING)
      .mockResolvedValueOnce({ ...RECURRING, status: 'revoked', chainState: null })
    const controls = run(DELEGATION)

    await waitFor(() => expect(controls().state.status).toBe('done'))
  })
})
