import type { UiWallet } from '@wallet-standard/react'
import { useState } from 'react'
import { useWalletEnvironment } from './WalletProvider.js'
import {
  shortenAddress,
  useAllWallets,
  useWalletConnect,
  useWalletConnection,
  useWalletDisconnect,
  walletCanDisconnect,
  walletSigningSupport,
} from './wallet.js'

/**
 * Вхід у застосунок цілком: жодної форми, жодного пароля, жодної реєстрації
 * (`FR-017`). Кнопка на гаманець — і адреса в шапці.
 */

const BUTTON =
  'rounded-md border border-hairline px-3 py-1.5 text-[12px] text-ink/70 transition-colors duration-150 hover:text-ink disabled:opacity-50'

function ConnectButton({ wallet }: { wallet: UiWallet }) {
  const { chain } = useWalletEnvironment()
  const [isConnecting, connect] = useWalletConnect(wallet, chain)
  const [problem, setProblem] = useState<string | null>(null)

  return (
    <span className="flex flex-col items-end">
      <button
        type="button"
        className={BUTTON}
        disabled={isConnecting}
        onClick={async () => {
          setProblem(null)
          try {
            const result = await connect()
            if (result.status === 'no-account-on-chain') {
              setProblem(`${wallet.name} has no account on ${chain}`)
            }
          } catch (error) {
            // Відмову в самому гаманці показуємо, а не ковтаємо: інакше кнопка
            // виглядає зламаною.
            setProblem(error instanceof Error ? error.message : 'wallet refused the connection')
          }
        }}
      >
        {isConnecting ? 'Connecting…' : `Connect ${wallet.name}`}
      </button>
      {problem !== null && <span className="mt-1 text-[11px] text-ink/45">{problem}</span>}
    </span>
  )
}

/**
 * Монтується **лише** для гаманця, який уміє `standard:disconnect`: інакше
 * `useWalletDisconnect` кидає при рендері й забирає з собою весь застосунок
 * (знайдено живим прогоном на гаманці без цієї здатності).
 */
function DisconnectButton({ wallet, label }: { wallet: UiWallet; label: string }) {
  const [isDisconnecting, disconnect] = useWalletDisconnect(wallet)
  return (
    <button
      type="button"
      className={BUTTON}
      disabled={isDisconnecting}
      onClick={() => disconnect()}
    >
      {isDisconnecting ? 'Disconnecting…' : label}
    </button>
  )
}

/**
 * Гаманець не вміє від'єднуватися — вибір знімається в нас. Кнопка тут
 * потрібна саме тому: без неї єдиним способом перестати показувати чужі
 * дозволи лишалося б закрити вкладку.
 */
function ForgetButton() {
  const { forget } = useWalletConnection()
  return (
    <button type="button" className={BUTTON} onClick={() => forget()}>
      Forget this wallet
    </button>
  )
}

export function WalletMenu() {
  const { cluster, chain } = useWalletEnvironment()
  const { wallets, account, address } = useWalletConnection()
  const allWallets = useAllWallets()

  if (account !== undefined && address !== null) {
    const wallet = wallets.find((candidate) =>
      candidate.accounts.some((it) => it.address === account.address),
    )
    const signing = wallet === undefined ? 'none' : walletSigningSupport(wallet)
    return (
      <span className="flex items-center gap-3">
        <span className="flex flex-col items-end">
          <span className="font-mono text-[12px] text-ink">{shortenAddress(address)}</span>
          <span className="text-[11px] text-ink/45">
            {cluster}
            {signing === 'none' && ' · wallet cannot sign — cancelling is unavailable'}
          </span>
        </span>
        {wallet !== undefined && walletCanDisconnect(wallet) ? (
          <DisconnectButton wallet={wallet} label="Disconnect" />
        ) : (
          <ForgetButton />
        )}
      </span>
    )
  }

  if (wallets.length === 0) {
    // Дві різні причини порожнього списку — і кажемо, яка саме.
    return (
      <span className="text-[11px] text-ink/45">
        {allWallets.length === 0
          ? 'No wallet detected. A wallet is the only way in — there are no accounts or passwords here.'
          : `${allWallets.length} wallet(s) detected, none of them works on ${chain}.`}
      </span>
    )
  }

  return (
    <span className="flex flex-wrap items-start gap-2">
      {wallets.map((wallet) => (
        <ConnectButton key={wallet.name} wallet={wallet} />
      ))}
    </span>
  )
}
