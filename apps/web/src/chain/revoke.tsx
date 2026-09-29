import {
  buildCancelSubscriptionTransaction,
  buildRevokeTransaction,
  revokeActionFor,
} from '@cancelchain/chain'
import { getBase58Decoder } from '@solana/kit'
import { useSignAndSendTransaction } from '@solana/react'
import type { SolanaChain } from '@solana/wallet-standard-chains'
import { useQueryClient } from '@tanstack/react-query'
import type { UiWalletAccount } from '@wallet-standard/react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { describeFailure } from '../lib/api'
import { source } from '../lib/source'
import { useWalletEnvironment } from './WalletProvider'
import { accountSigningSupport, useWalletConnection, walletAccountAddress } from './wallet'

/**
 * Потік скасування — `FR-003`, `FR-019`, `FR-026`, і `SC-002` міряє саме його.
 *
 * **Два кліки, один підпис.** Клік «Cancel» відкриває підтвердження, клік
 * «Cancel this permission» запускає все інше; підпис у транзакції рівно один —
 * це властивість білдера (`packages/chain/src/revoke.ts`), а не обіцянка цього
 * файлу. Третього кліку тут не з'являється ні за яких умов: усе між другим
 * кліком і закритим акаунтом відбувається саме.
 *
 * **Чотири кроки, і кожен видно.**
 *
 * 1. `checking` — стан звіряється з мережею **перед дією** (`FR-024`). Дозвіл,
 *    якого вже немає, не доходить до гаманця взагалі: підписувати нічого, і
 *    це відповідь, а не помилка.
 * 2. `preparing` — час життя транзакції з `/v1/blockhash`.
 * 3. `signing` — транзакція в гаманці. Далі все залежить від людини.
 * 4. `confirming` — **перечитуванням мережі**, а не довірою до гаманця. Гаманець
 *    повертає підпис, а не факт; факт — це зниклий акаунт, і саме його ми
 *    питаємо. Поки акаунт на місці, скасування не оголошується.
 */

export type RevokeStep = 'checking' | 'preparing' | 'signing' | 'confirming'

/**
 * Which transaction the flow is signing (T037a). `close` is `revokeDelegation`;
 * `cancel-subscription` is `cancelSubscription`, which leaves the account in
 * place and sets the date charges stop. `null` while the flow still checks.
 */
export type SignedAction = 'close' | 'cancel-subscription'

export type CancelState =
  | { status: 'idle' }
  | { status: 'working'; id: string; step: RevokeStep; action: SignedAction | null }
  /** Акаунта вже не було до підпису. Нічого не підписано й нічого не сталося. */
  | { status: 'gone'; id: string }
  | { status: 'done'; id: string; signature: string }
  /**
   * A plan subscription whose charges stop at `endsAt`, as read back from the
   * account. `signature: null` — it was already cancelled before anything was
   * signed, so nothing was sent; the button should not have been there.
   */
  | { status: 'scheduled'; id: string; endsAt: string; signature: string | null }
  /**
   * Гаманець сказав, що надіслав, а акаунт лишився на місці. Це **не** успіх і
   * не збій: транзакція могла не долетіти, а могла ще летіти.
   */
  | { status: 'unconfirmed'; id: string; signature: string; action: SignedAction }
  | { status: 'failed'; id: string; message: string }

export type CancelControls = {
  state: CancelState
  /** `null` — скасувати неможливо. Чому саме — в `unavailable`. */
  cancel: ((id: string) => void) | null
  /** Причина, яку показують замість кнопки. `null` — скасування доступне. */
  unavailable: string | null
  dismiss: () => void
}

const IDLE: CancelState = { status: 'idle' }

/** Скільки разів перечитати мережу, перш ніж перестати чекати. */
export const CONFIRM_ATTEMPTS = 8
export const CONFIRM_DELAY_MS = 1_500

const STEP_LABELS: Record<RevokeStep, string> = {
  checking: 'Checking this permission against the network…',
  preparing: 'Preparing the transaction…',
  signing: 'Waiting for your wallet to sign and send it…',
  confirming: 'Sent. Waiting for the network to drop the permission…',
}

export function stepLabel(step: RevokeStep, action: SignedAction | null = null): string {
  if (step === 'confirming' && action === 'cancel-subscription') {
    return 'Sent. Waiting for the network to record the date charges stop…'
  }
  return STEP_LABELS[step]
}

/**
 * Невдача → рядок для екрана. Відмова людини підписати — не збій продукту, і
 * червоне «щось пішло не так» на власне рішення передумати було б брехнею.
 */
export function describeRevokeFailure(error: unknown): string {
  if (error instanceof Error) {
    const text = `${error.name} ${error.message}`.toLowerCase()
    if (text.includes('reject') || text.includes('declined') || text.includes('denied')) {
      return 'You declined the signature in your wallet. Nothing was sent and nothing changed.'
    }
    if (error.name.startsWith('Revoke')) {
      // Білдер назвав розбіжність до підпису — його текст точніший за наш.
      return error.message
    }
  }
  return describeFailure(error)
}

/**
 * The account as the network has it, or `null` when it is gone. With a store
 * behind the API a closed account comes back as its cached row marked `revoked`
 * with `chainState: null` — not as a 404 — and that too means gone.
 */
async function readOnChain(
  readNow: NonNullable<typeof source.actions>['readNow'],
  id: string,
): Promise<Awaited<ReturnType<typeof readNow>>> {
  const read = await readNow(id)
  return read === null || read.chainState === null ? null : read
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type FlowProps = {
  account: UiWalletAccount
  chain: SolanaChain
  children: (controls: CancelControls) => ReactNode
}

const Flow = ({ account, chain, children }: FlowProps) => {
  const signAndSend = useSignAndSendTransaction(account, chain)
  const queryClient = useQueryClient()
  const [state, setState] = useState<CancelState>(IDLE)
  /** Один потік за раз: два підписи поспіль людина все одно не дає. */
  const running = useRef(false)

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['allowances'] })
    void queryClient.invalidateQueries({ queryKey: ['allowance'] })
  }, [queryClient])

  const cancel = useCallback(
    (id: string) => {
      const actions = source.actions
      if (actions === null || running.current) return
      running.current = true
      const authority = walletAccountAddress(account)

      void (async () => {
        try {
          setState({ status: 'working', id, step: 'checking', action: null })
          const current = await readOnChain(actions.readNow, id)
          if (current === null) {
            setState({ status: 'gone', id })
            refresh()
            return
          }
          // Decided on the state just read, not on the card: the card may be
          // older than a cancellation made from another tab or wallet.
          const next = revokeActionFor(current)
          if (next.kind === 'wait') {
            setState({ status: 'scheduled', id, endsAt: next.until.toISOString(), signature: null })
            refresh()
            return
          }
          const action: SignedAction = next.kind

          setState({ status: 'working', id, step: 'preparing', action })
          const lifetime = await actions.latestLifetime()
          const input = { allowance: current, authority, lifetime }
          const built =
            action === 'close'
              ? buildRevokeTransaction(input)
              : await buildCancelSubscriptionTransaction(input)

          setState({ status: 'working', id, step: 'signing', action })
          const { signature } = await signAndSend({ transaction: built.wireTransaction })
          const base58 = getBase58Decoder().decode(signature)

          setState({ status: 'working', id, step: 'confirming', action })
          for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
            const seen = await readOnChain(actions.readNow, id)
            if (seen === null) {
              // Closed — also the answer after `cancelSubscription` if the plan
              // was gone and someone closed the account in the meantime.
              setState({ status: 'done', id, signature: base58 })
              refresh()
              return
            }
            if (action === 'cancel-subscription' && seen.endsAt !== null) {
              // The date is the one the program wrote, not the one we predicted.
              setState({ status: 'scheduled', id, endsAt: seen.endsAt, signature: base58 })
              refresh()
              return
            }
            await sleep(CONFIRM_DELAY_MS)
          }
          // Ані успіх, ані невдача. Кажемо рівно це — і лишаємо підпис, щоб
          // людині було що подивитися в оглядачі.
          setState({ status: 'unconfirmed', id, signature: base58, action })
          refresh()
        } catch (error) {
          setState({ status: 'failed', id, message: describeRevokeFailure(error) })
          // Перечитуємо однаково: транзакція могла долетіти до того, як
          // зламалося щось наше, і показувати старий список було б гірше.
          refresh()
        } finally {
          running.current = false
        }
      })()
    },
    [account, refresh, signAndSend],
  )

  return <>{children({ state, cancel, unavailable: null, dismiss: () => setState(IDLE) })}</>
}

function unavailableControls(reason: string): CancelControls {
  return { state: IDLE, cancel: null, unavailable: reason, dismiss: () => {} }
}

/**
 * Межа, за якою живуть хуки гаманця.
 *
 * Компонент, а не хук, з однієї причини: `useSignAndSendTransaction` вимагає
 * акаунт, а акаунта може не бути — і викликати хук умовно не можна. Умовним тут
 * стає **рендер**, що правилам не суперечить.
 */
export const CancelFlow = ({ children }: { children: (controls: CancelControls) => ReactNode }) => {
  const { chain } = useWalletEnvironment()
  const { account, wallets } = useWalletConnection()

  if (source.actions === null) {
    return <>{children(unavailableControls('This screen is a demo — nothing here is signed.'))}</>
  }
  if (account === undefined) {
    return <>{children(unavailableControls('Connect a wallet to cancel a permission.'))}</>
  }
  // Asked of the wallet, not the account — see `accountSigningSupport`.
  const signing = accountSigningSupport(account, wallets)
  if (signing !== 'sign-and-send') {
    return (
      <>
        {children(
          unavailableControls(
            signing === 'sign'
              ? 'This wallet signs but does not send. CancelChain has no node of its own in the ' +
                  'browser, so it cannot broadcast a transaction the wallet hands back.'
              : 'This wallet cannot sign, so cancelling is unavailable here. Reading permissions ' +
                  'never needs a signature — cancelling always does.',
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
