import { SOLANA_DEVNET_CHAIN, SOLANA_MAINNET_CHAIN } from '@solana/wallet-standard-chains'
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
} from '@solana/wallet-standard-features'
import { StandardConnect, StandardDisconnect } from '@wallet-standard/features'
import type { UiWallet, UiWalletAccount } from '@wallet-standard/react'
import { describe, expect, it } from 'vitest'
import {
  accountsOnChain,
  clusterFromEnv,
  createWalletFilter,
  createWalletStateSync,
  DEFAULT_CLUSTER,
  explorerTxUrl,
  SELECTED_WALLET_STORAGE_KEY,
  shortenAddress,
  walletAccountAddress,
  walletCanDisconnect,
  walletChainFor,
  walletSigningSupport,
} from './wallet.js'

const OWNER = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44'

/**
 * `UiWallet` несе фірмову властивість-символ, тож літералом його не скласти —
 * у справжньому застосунку об'єкт приходить із реєстру wallet-standard. Форма
 * фікстури звірена з типом, приведення стосується лише марки.
 */
function fakeWallet(overrides: Partial<Omit<UiWallet, '~uiWalletHandle'>> = {}): UiWallet {
  return {
    name: 'Test Wallet',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    version: '1.0.0',
    chains: [SOLANA_DEVNET_CHAIN],
    features: [StandardConnect, StandardDisconnect, SolanaSignAndSendTransaction],
    accounts: [],
    ...overrides,
  } as unknown as UiWallet
}

function fakeAccount(overrides: Partial<Omit<UiWalletAccount, '~uiWalletHandle'>> = {}) {
  return {
    address: OWNER,
    chains: [SOLANA_DEVNET_CHAIN],
    features: [SolanaSignAndSendTransaction],
    icon: undefined,
    label: undefined,
    publicKey: new Uint8Array(32),
    ...overrides,
  } as unknown as UiWalletAccount
}

describe('walletChainFor', () => {
  it('devnet → solana:devnet', () => {
    expect(walletChainFor('devnet')).toBe('solana:devnet')
  })

  it('mainnet-beta → solana:mainnet — назви кластера й мережі не збігаються', () => {
    expect(walletChainFor('mainnet-beta')).toBe('solana:mainnet')
  })
})

describe('clusterFromEnv', () => {
  it('незадана змінна — devnet', () => {
    expect(clusterFromEnv({})).toBe(DEFAULT_CLUSTER)
    expect(clusterFromEnv({ VITE_SOLANA_CLUSTER: '' })).toBe(DEFAULT_CLUSTER)
  })

  it('відома назва береться як є', () => {
    expect(clusterFromEnv({ VITE_SOLANA_CLUSTER: 'testnet' })).toBe('testnet')
  })

  it('невідома назва падає, а не підмінюється devnet мовчки', () => {
    // `mainnet` замість `mainnet-beta` інакше показував би devnet-дані під
    // виглядом справжніх грошей.
    expect(() => clusterFromEnv({ VITE_SOLANA_CLUSTER: 'mainnet' })).toThrow(/unknown/)
  })
})

describe('createWalletFilter', () => {
  const keep = createWalletFilter(SOLANA_DEVNET_CHAIN)

  it('лишає гаманець нашої мережі з standard:connect', () => {
    expect(keep(fakeWallet())).toBe(true)
  })

  it('прибирає гаманець з іншої мережі', () => {
    expect(keep(fakeWallet({ chains: [SOLANA_MAINNET_CHAIN] }))).toBe(false)
  })

  it('прибирає гаманець без standard:connect — підключитися до нього нічим', () => {
    expect(keep(fakeWallet({ features: [SolanaSignAndSendTransaction] }))).toBe(false)
  })

  it('лишає гаманець, який не вміє підписувати: читання дозволів підпису не потребує', () => {
    expect(keep(fakeWallet({ features: [StandardConnect] }))).toBe(true)
  })
})

describe('walletSigningSupport', () => {
  it('signAndSendTransaction має пріоритет', () => {
    expect(
      walletSigningSupport(
        fakeWallet({ features: [SolanaSignAndSendTransaction, SolanaSignTransaction] }),
      ),
    ).toBe('sign-and-send')
  })

  it('лише signTransaction — підпис є, надсилання за нами', () => {
    expect(walletSigningSupport(fakeWallet({ features: [SolanaSignTransaction] }))).toBe('sign')
  })

  it('нічого з двох — скасування неможливе, і це треба назвати', () => {
    expect(walletSigningSupport(fakeWallet({ features: [StandardConnect] }))).toBe('none')
  })
})

describe('walletCanDisconnect', () => {
  it('розрізняє наявність standard:disconnect', () => {
    expect(walletCanDisconnect(fakeWallet())).toBe(true)
    expect(walletCanDisconnect(fakeWallet({ features: [StandardConnect] }))).toBe(false)
  })
})

describe('accountsOnChain', () => {
  it('лишає лише акаунти нашої мережі', () => {
    const ours = fakeAccount()
    const theirs = fakeAccount({ chains: [SOLANA_MAINNET_CHAIN] })
    const wallet = fakeWallet({ accounts: [ours, theirs] })
    expect(accountsOnChain(wallet, SOLANA_DEVNET_CHAIN)).toEqual([ours])
  })
})

describe('walletAccountAddress', () => {
  it('повертає адресу як branded-тип kit', () => {
    expect(walletAccountAddress(fakeAccount())).toBe(OWNER)
  })

  it('зіпсована адреса падає тут, а не в запиті до мережі', () => {
    expect(() => walletAccountAddress(fakeAccount({ address: 'not-an-address' }))).toThrow()
  })
})

describe('shortenAddress', () => {
  it('обрізає з обох боків — підробку видно', () => {
    expect(shortenAddress(OWNER)).toBe('De1e…vR44')
  })

  it('коротке значення лишає як є', () => {
    expect(shortenAddress('abc')).toBe('abc')
  })
})

describe('createWalletStateSync', () => {
  function memoryStorage(): Storage {
    const map = new Map<string, string>()
    return {
      get length() {
        return map.size
      },
      clear: () => map.clear(),
      getItem: (key) => map.get(key) ?? null,
      key: (index) => [...map.keys()][index] ?? null,
      removeItem: (key) => void map.delete(key),
      setItem: (key, value) => void map.set(key, value),
    }
  }

  function throwingStorage(): Storage {
    const boom = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    return {
      length: 0,
      clear: boom,
      getItem: boom,
      key: boom,
      removeItem: boom,
      setItem: boom,
    }
  }

  it('зберігає, читає й видаляє вибір під одним ключем', () => {
    const storage = memoryStorage()
    const sync = createWalletStateSync(storage)
    expect(sync.getSelectedWallet()).toBeNull()
    sync.storeSelectedWallet(`Test Wallet:${OWNER}`)
    expect(storage.getItem(SELECTED_WALLET_STORAGE_KEY)).toBe(`Test Wallet:${OWNER}`)
    sync.deleteSelectedWallet()
    expect(sync.getSelectedWallet()).toBeNull()
  })

  it('сховище, що кидає (приватне вікно), не валить застосунок', () => {
    const sync = createWalletStateSync(throwingStorage())
    expect(sync.getSelectedWallet()).toBeNull()
    expect(() => sync.storeSelectedWallet('x')).not.toThrow()
    expect(() => sync.deleteSelectedWallet()).not.toThrow()
  })

  it('сховища немає взагалі — те саме', () => {
    const sync = createWalletStateSync(null)
    expect(sync.getSelectedWallet()).toBeNull()
    expect(() => sync.storeSelectedWallet('x')).not.toThrow()
  })
})

/** Посилання на транзакцію — `T030`. */
describe('explorerTxUrl', () => {
  const SIGNATURE =
    '5wHu1qwD4kLwYbtcSNVXrGwEA5gXtWFCbGwYRnYQ2rMFcvCqDbwWLKJHVsUqM3zJ7z3rHmxsHTvQ4rC1BEuFyRxk'

  it('names the cluster, because the same signature means nothing on another one', () => {
    expect(explorerTxUrl(SIGNATURE, 'devnet')).toBe(
      `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
    )
  })

  it('has no link for a local validator instead of one that opens nothing', () => {
    expect(explorerTxUrl(SIGNATURE, 'localnet')).toBeNull()
  })

  it('does not ask the explorer for a cluster it defaults to', () => {
    expect(explorerTxUrl(SIGNATURE, 'mainnet-beta')).toBe(
      `https://explorer.solana.com/tx/${SIGNATURE}`,
    )
  })
})
