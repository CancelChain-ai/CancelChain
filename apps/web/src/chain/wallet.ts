import { CLUSTERS, type Cluster } from '@cancelchain/chain'
import { type Address, assertIsAddress } from '@solana/kit'
import { useSelectedWalletAccount } from '@solana/react'
import {
  SOLANA_DEVNET_CHAIN,
  SOLANA_LOCALNET_CHAIN,
  SOLANA_MAINNET_CHAIN,
  SOLANA_TESTNET_CHAIN,
  type SolanaChain,
} from '@solana/wallet-standard-chains'
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
} from '@solana/wallet-standard-features'
import { StandardConnect, StandardDisconnect } from '@wallet-standard/features'
import {
  type UiWallet,
  type UiWalletAccount,
  useConnect,
  useDisconnect,
  useWallets,
} from '@wallet-standard/react'
import { useCallback, useMemo } from 'react'

/**
 * Підключення гаманця — **єдиний спосіб входу** (`FR-017`). Облікових записів,
 * паролів і персональних даних тут немає й бути не може: усе, що зберігається
 * між сесіями, — рядок `"<назва гаманця>:<адреса>"`, щоб на наступному відкритті
 * не питати вибір удруге. Ані `label` акаунта (гаманець дозволяє назвати його
 * як завгодно, у тому числі іменем людини), ані чогось іншого ми не пишемо
 * нікуди й нікуди не надсилаємо.
 *
 * Стандарт — wallet-standard через `@solana/react`, **не** wallet-adapter
 * (`PLAN.md` → стек).
 */

/**
 * Ідентифікатори мереж беруться з `@solana/wallet-standard-chains`, а не
 * пишуться рядками: збіг із тим, що оголошує гаманець, не має права розійтися
 * при оновленні пакета.
 */
export const WALLET_CHAIN_BY_CLUSTER = {
  devnet: SOLANA_DEVNET_CHAIN,
  testnet: SOLANA_TESTNET_CHAIN,
  'mainnet-beta': SOLANA_MAINNET_CHAIN,
  localnet: SOLANA_LOCALNET_CHAIN,
} as const satisfies Record<Cluster, SolanaChain>

export function walletChainFor(cluster: Cluster): SolanaChain {
  return WALLET_CHAIN_BY_CLUSTER[cluster]
}

export const DEFAULT_CLUSTER: Cluster = 'devnet'

function isCluster(value: string): value is Cluster {
  return (CLUSTERS as readonly string[]).includes(value)
}

/**
 * Мережа з оточення збірки. Незадана — devnet: продукт розробляється на ньому, і
 * жоден `SC-*` не потребує mainnet. А от **невідома** назва не підмінюється
 * мовчки: `VITE_SOLANA_CLUSTER=mainnet` (замість `mainnet-beta`) інакше показував
 * би devnet-дані під виглядом справжніх грошей.
 */
export function clusterFromEnv(env: Record<string, string | undefined>): Cluster {
  const value = env.VITE_SOLANA_CLUSTER
  if (value === undefined || value === '') return DEFAULT_CLUSTER
  if (!isCluster(value)) {
    throw new Error(`unknown VITE_SOLANA_CLUSTER: ${value}. Expected one of ${CLUSTERS.join(', ')}`)
  }
  return value
}

/** Чим гаманець може підписати транзакцію відкликання (`FR-003`). */
export type SigningSupport = 'sign-and-send' | 'sign' | 'none'

export function walletSigningSupport(wallet: UiWallet): SigningSupport {
  if (wallet.features.includes(SolanaSignAndSendTransaction)) return 'sign-and-send'
  if (wallet.features.includes(SolanaSignTransaction)) return 'sign'
  return 'none'
}

export function walletCanDisconnect(wallet: UiWallet): boolean {
  return wallet.features.includes(StandardDisconnect)
}

/**
 * Що гаманець мусить уміти, щоб узагалі потрапити в список: працювати в нашій
 * мережі й підтримувати `standard:connect`.
 *
 * Уміння підписувати сюди свідомо **не** входить. Гаманець без підпису все одно
 * показує дозволи — читання їх не потребує (`FR-001`, `FR-006`), — а сховати
 * його означало б залишити людину з порожнім екраном без пояснення. Замість
 * цього `walletSigningSupport` називає обмеження вголос, і скасування (`FR-003`)
 * скаже про нього в момент дії.
 */
export function createWalletFilter(chain: SolanaChain): (wallet: UiWallet) => boolean {
  return (wallet) => wallet.chains.includes(chain) && wallet.features.includes(StandardConnect)
}

/** Акаунти гаманця, що працюють у нашій мережі. */
export function accountsOnChain(wallet: UiWallet, chain: SolanaChain): readonly UiWalletAccount[] {
  return wallet.accounts.filter((account) => account.chains.includes(chain))
}

/**
 * Адреса акаунта як branded-тип kit. Перевірка справжня (`assertIsAddress`
 * рахує довжину й base58), тож зіпсована адреса падає тут, а не перетворюється
 * на запит до мережі за неіснуючим ключем.
 */
export function walletAccountAddress(account: UiWalletAccount): Address {
  const { address } = account
  assertIsAddress(address)
  return address
}

/**
 * Адреса для показу: перші й останні символи. Base58-адресу цілком ніхто не
 * звіряє очима, а обрізана з обох боків підробка помітна — на відміну від
 * обрізаної з одного.
 */
export function shortenAddress(address: string, edge = 4): string {
  return address.length <= edge * 2 + 1
    ? address
    : `${address.slice(0, edge)}…${address.slice(-edge)}`
}

export const SELECTED_WALLET_STORAGE_KEY = 'cancelchain:selected-wallet'

export type WalletStateSync = {
  getSelectedWallet: () => string | null
  storeSelectedWallet: (accountKey: string) => void
  deleteSelectedWallet: () => void
}

/**
 * Сховище вибору гаманця. Кожен доступ у `try/catch`: у приватному вікні Safari
 * і при вимкнених даних сайту звертання до `localStorage` **кидає**, і застосунок,
 * який цього не переживає, не відкривається взагалі — заради зручності, без якої
 * можна жити.
 */
export function createWalletStateSync(storage: Storage | null): WalletStateSync {
  return {
    getSelectedWallet: () => {
      try {
        return storage?.getItem(SELECTED_WALLET_STORAGE_KEY) ?? null
      } catch {
        return null
      }
    },
    storeSelectedWallet: (accountKey) => {
      try {
        storage?.setItem(SELECTED_WALLET_STORAGE_KEY, accountKey)
      } catch {
        // Вибір просто не переживе перезавантаження. Це не привід падати.
      }
    },
    deleteSelectedWallet: () => {
      try {
        storage?.removeItem(SELECTED_WALLET_STORAGE_KEY)
      } catch {
        // Те саме: нічого не зберегли — нічого й видаляти.
      }
    },
  }
}

/** `null`, якщо сховище недоступне (приватне вікно, вимкнені дані сайту). */
export function browserStorage(): Storage | null {
  try {
    // Саме `window.localStorage`, а не `globalThis.localStorage`: під Node 22
    // існує власний глобальний `localStorage`, недоступний без прапорця, і він
    // перекриває той, що дає документ.
    if (typeof window !== 'undefined') return window.localStorage ?? null
    return null
  } catch {
    return null
  }
}

/**
 * Один екземпляр на застосунок: провайдер тримає `stateSync` у залежностях
 * ефекту, і новий об'єкт на кожен рендер ганяв би його по колу.
 */
export const walletStateSync = createWalletStateSync(browserStorage())

/** Адреса підключеного гаманця або `null`. Це і є вся «сесія» користувача. */
export function useWalletOwner(): Address | null {
  const [account] = useSelectedWalletAccount()
  return useMemo(() => (account ? walletAccountAddress(account) : null), [account])
}

export type WalletConnection = {
  /** Гаманці, що пройшли `createWalletFilter` — у порядку реєстрації в браузері. */
  wallets: readonly UiWallet[]
  account: UiWalletAccount | undefined
  address: Address | null
  select: (account: UiWalletAccount | undefined) => void
  /** Забути вибір, не питаючи гаманець про від'єднання. */
  forget: () => void
}

export function useWalletConnection(): WalletConnection {
  const [account, setAccount, wallets] = useSelectedWalletAccount()
  const select = useCallback((next: UiWalletAccount | undefined) => setAccount(next), [setAccount])
  const forget = useCallback(() => setAccount(undefined), [setAccount])
  const address = useMemo(() => (account ? walletAccountAddress(account) : null), [account])
  return { wallets, account, address, select, forget }
}

/**
 * Список гаманців **до** фільтра — потрібен лише для чесного порожнього стану:
 * «розширення є, але воно не працює в devnet» — це інша розмова, ніж «гаманців
 * не знайдено».
 */
export function useAllWallets(): readonly UiWallet[] {
  return useWallets()
}

export type ConnectResult =
  | { status: 'connected'; account: UiWalletAccount }
  /** Гаманець відповів, але жоден акаунт не працює в нашій мережі. */
  | { status: 'no-account-on-chain' }

/**
 * Підключення: питаємо гаманець про дозвіл і одразу вибираємо акаунт, який
 * працює в нашій мережі. Відмову користувача (`connect` кидає) не ковтаємо —
 * її показує той, хто викликав, інакше кнопка мовчки нічого не робить.
 */
export function useWalletConnect(
  wallet: UiWallet,
  chain: SolanaChain,
): [isConnecting: boolean, connect: () => Promise<ConnectResult>] {
  const [isConnecting, connect] = useConnect(wallet)
  const [, setAccount] = useSelectedWalletAccount()
  const run = useCallback(async (): Promise<ConnectResult> => {
    const accounts = await connect()
    const account = accounts.find((candidate) => candidate.chains.includes(chain))
    if (account === undefined) return { status: 'no-account-on-chain' }
    setAccount(account)
    return { status: 'connected', account }
  }, [connect, chain, setAccount])
  return [isConnecting, run]
}

/**
 * Від'єднання. Вибір знімається **перед** запитом до гаманця: якщо розширення
 * не має `standard:disconnect` або відмовить, застосунок усе одно мусить
 * перестати показувати чужі дозволи — це видимість чужих грошей, а не налаштування.
 */
export function useWalletDisconnect(
  wallet: UiWallet,
): [isDisconnecting: boolean, disconnect: () => Promise<void>] {
  const [isDisconnecting, disconnect] = useDisconnect(wallet)
  const [, setAccount] = useSelectedWalletAccount()
  const run = useCallback(async () => {
    setAccount(undefined)
    if (!walletCanDisconnect(wallet)) return
    await disconnect()
  }, [disconnect, setAccount, wallet])
  return [isDisconnecting, run]
}
