import type { Cluster } from '@cancelchain/chain'
import { SelectedWalletAccountContextProvider } from '@solana/react'
import type { SolanaChain } from '@solana/wallet-standard-chains'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { clusterFromEnv, createWalletFilter, walletChainFor, walletStateSync } from './wallet.js'

/**
 * Оточення гаманця для всього застосунку. Мережа читається один раз зі змінних
 * збірки — вона не може змінитися в рантаймі, і робити з неї стан означало б
 * обіцяти перемикач, якого немає.
 */

export type WalletEnvironment = {
  cluster: Cluster
  chain: SolanaChain
}

const WalletEnvironmentContext = createContext<WalletEnvironment | null>(null)

export function useWalletEnvironment(): WalletEnvironment {
  const value = useContext(WalletEnvironmentContext)
  if (value === null) throw new Error('useWalletEnvironment requires <WalletProvider>')
  return value
}

export type WalletProviderProps = {
  children: ReactNode
  /** Перевизначення для тестів; у застосунку береться з `import.meta.env`. */
  cluster?: Cluster
}

export function WalletProvider({ children, cluster }: WalletProviderProps) {
  const environment = useMemo<WalletEnvironment>(() => {
    const resolved = cluster ?? clusterFromEnv(import.meta.env)
    return { cluster: resolved, chain: walletChainFor(resolved) }
  }, [cluster])
  // Фільтр мусить бути стабільним: провайдер тримає його в залежностях `useMemo`,
  // і нова функція на кожен рендер перебирала б список гаманців без причини.
  const filterWallets = useMemo(() => createWalletFilter(environment.chain), [environment.chain])

  return (
    <WalletEnvironmentContext.Provider value={environment}>
      <SelectedWalletAccountContextProvider
        filterWallets={filterWallets}
        stateSync={walletStateSync}
      >
        {children}
      </SelectedWalletAccountContextProvider>
    </WalletEnvironmentContext.Provider>
  )
}
