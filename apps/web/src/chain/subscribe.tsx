import { buildSubscribeTransaction } from '@cancelchain/chain'
import { getBase58Decoder } from '@solana/kit'
import { useSignAndSendTransaction } from '@solana/react'
import type { SolanaChain } from '@solana/wallet-standard-chains'
import { useQueryClient } from '@tanstack/react-query'
import type { UiWalletAccount } from '@wallet-standard/react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { describeFailure } from '../lib/api'
import { source } from '../lib/source'
import {
  type ReviewBlock,
  recheckOffer,
  reviewSubscription,
  type SubscribeReview,
} from '../lib/subscribeReview'
import { useWalletEnvironment } from './WalletProvider'
import { accountSigningSupport, useWalletConnection, walletAccountAddress } from './wallet'

/**
 * The subscription flow — `T037`, `FR-007`, measured by `SC-010`: at most three
 * clicks, one signature, and the subscription visible in the list in under
 * 10 seconds without a manual refresh.
 *
 * **One click here, one signature.** "Allow this" starts everything; the only
 * other click is the wallet's own approval. The transaction carries one
 * signature slot, the subscriber's — a property of `buildSubscribeTransaction`,
 * not a promise of this file.
 *
 * **Four steps, each one visible**, as in `revoke.tsx`:
 *
 * 1. `checking` — the plan is read from the network **again** and the offer
 *    rebuilt. The screen may have been open for minutes; if anything it showed
 *    is no longer true, nothing goes to the wallet (`recheckOffer`).
 * 2. `preparing` — the transaction lifetime from `/v1/blockhash`.
 * 3. `signing` — the transaction is in the wallet.
 * 4. `confirming` — **by reading the network**, not by trusting the wallet. The
 *    wallet returns a signature, not a fact; the fact is the subscription
 *    account existing, and that is what is asked for.
 *
 * On success the permission list is invalidated, so the dashboard reads the
 * network again the moment it is shown — nobody has to press refresh.
 */

export type SubscribeStep = 'checking' | 'preparing' | 'signing' | 'confirming'

export type SubscribeState =
  | { status: 'idle' }
  | { status: 'working'; step: SubscribeStep }
  /**
   * The re-read plan differs from the one on the screen, or is gone, or blocks
   * the subscription. Nothing was signed; the screen now shows the fresh state.
   */
  | { status: 'stopped'; reason: 'changed' | 'missing' }
  | { status: 'stopped'; reason: 'blocked'; block: ReviewBlock }
  | { status: 'done'; subscription: string; signature: string }
  /** The wallet says it sent it, and the account has not appeared yet. Not a failure. */
  | { status: 'unconfirmed'; subscription: string; signature: string }
  | { status: 'failed'; message: string }

export type SubscribeControls = {
  state: SubscribeState
  /** `null` — signing is not possible here; why is in `unavailable`. */
  subscribe: ((review: SubscribeReview) => void) | null
  unavailable: string | null
  dismiss: () => void
}

const IDLE: SubscribeState = { status: 'idle' }

/**
 * How long to keep reading the network for the new account. The budget is
 * `SC-010`'s 10 s; the wait runs a little past it so that a slow slot is
 * reported as "not seen yet" rather than cut off inside the budget.
 */
export const CONFIRM_ATTEMPTS = 15
export const CONFIRM_DELAY_MS = 1_000

const STEP_LABELS: Record<SubscribeStep, string> = {
  checking: 'Reading the plan from the network again…',
  preparing: 'Preparing the transaction…',
  signing: 'Waiting for your wallet to sign and send it…',
  confirming: 'Sent. Waiting for the network to show the subscription…',
}

export function subscribeStepLabel(step: SubscribeStep): string {
  return STEP_LABELS[step]
}

/** A person declining the signature is a decision, not a product failure. */
export function describeSubscribeFailure(error: unknown): string {
  if (error instanceof Error) {
    const text = `${error.name} ${error.message}`.toLowerCase()
    if (text.includes('reject') || text.includes('declined') || text.includes('denied')) {
      return 'You declined the signature in your wallet. Nothing was sent and nothing changed.'
    }
    if (error.name.startsWith('Subscribe')) {
      // The builder named the problem before the signature; its words are more exact.
      return error.message
    }
  }
  return describeFailure(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type FlowProps = {
  account: UiWalletAccount
  chain: SolanaChain
  children: (controls: SubscribeControls) => ReactNode
}

const Flow = ({ account, chain, children }: FlowProps) => {
  const signAndSend = useSignAndSendTransaction(account, chain)
  const queryClient = useQueryClient()
  const [state, setState] = useState<SubscribeState>(IDLE)
  const running = useRef(false)

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['allowances'] })
    void queryClient.invalidateQueries({ queryKey: ['plan'] })
  }, [queryClient])

  const subscribe = useCallback(
    (shown: SubscribeReview) => {
      const actions = source.actions
      const plans = source.plans
      if (actions === null || plans === null || running.current) return
      running.current = true
      const subscriber = walletAccountAddress(account)

      void (async () => {
        try {
          setState({ status: 'working', step: 'checking' })
          const view = await plans.get(shown.plan, subscriber)
          const recheck = recheckOffer(shown, view === null ? null : await reviewSubscription(view))
          if (recheck.status !== 'same') {
            setState(
              recheck.status === 'blocked'
                ? { status: 'stopped', reason: 'blocked', block: recheck.block }
                : { status: 'stopped', reason: recheck.status },
            )
            // The screen must now show what the network holds, not what it showed.
            refresh()
            return
          }
          const { subscription } = recheck.transaction

          setState({ status: 'working', step: 'preparing' })
          const lifetime = await actions.latestLifetime()
          const built = buildSubscribeTransaction({
            instructions: recheck.transaction.instructions,
            lifetime,
          })

          setState({ status: 'working', step: 'signing' })
          const { signature } = await signAndSend({ transaction: built.wireTransaction })
          const base58 = getBase58Decoder().decode(signature)

          setState({ status: 'working', step: 'confirming' })
          for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
            if ((await actions.readNow(subscription)) !== null) {
              setState({ status: 'done', subscription, signature: base58 })
              refresh()
              return
            }
            await sleep(CONFIRM_DELAY_MS)
          }
          setState({ status: 'unconfirmed', subscription, signature: base58 })
          refresh()
        } catch (error) {
          setState({ status: 'failed', message: describeSubscribeFailure(error) })
          // The transaction may have landed before something of ours broke.
          refresh()
        } finally {
          running.current = false
        }
      })()
    },
    [account, refresh, signAndSend],
  )

  return <>{children({ state, subscribe, unavailable: null, dismiss: () => setState(IDLE) })}</>
}

function unavailableControls(reason: string): SubscribeControls {
  return { state: IDLE, subscribe: null, unavailable: reason, dismiss: () => {} }
}

/** The boundary the wallet hooks live behind — a component for the same reason as `CancelFlow`. */
export const SubscribeFlow = ({
  children,
}: {
  children: (controls: SubscribeControls) => ReactNode
}) => {
  const { chain } = useWalletEnvironment()
  const { account, wallets } = useWalletConnection()

  if (source.actions === null || source.plans === null) {
    return <>{children(unavailableControls('This screen is a demo — nothing here is signed.'))}</>
  }
  if (account === undefined) {
    return <>{children(unavailableControls('Connect a wallet to subscribe.'))}</>
  }
  const signing = accountSigningSupport(account, wallets)
  if (signing !== 'sign-and-send') {
    return (
      <>
        {children(
          unavailableControls(
            signing === 'sign'
              ? 'This wallet signs but does not send. CancelChain has no node of its own in the ' +
                  'browser, so it cannot broadcast a transaction the wallet hands back.'
              : 'This wallet cannot sign, so subscribing is unavailable here.',
          ),
        )}
      </>
    )
  }

  return (
    <Flow account={account} chain={chain}>
      {children}
    </Flow>
  )
}
