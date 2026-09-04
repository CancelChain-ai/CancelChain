// @vitest-environment jsdom
import { SOLANA_DEVNET_CHAIN, SOLANA_MAINNET_CHAIN } from '@solana/wallet-standard-chains'
import { SolanaSignAndSendTransaction } from '@solana/wallet-standard-features'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { getWallets } from '@wallet-standard/app'
import type {
  IdentifierArray,
  IdentifierString,
  Wallet,
  WalletAccount,
  WalletIcon,
} from '@wallet-standard/base'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WalletMenu } from './WalletMenu.js'
import { WalletProvider } from './WalletProvider.js'
import { SELECTED_WALLET_STORAGE_KEY } from './wallet.js'

/**
 * Перевірка через **справжній реєстр wallet-standard**, а не через мок наших
 * же хуків: без розширення в браузері це єдиний спосіб довести, що шлях
 * «реєстр → фільтр → підключення → адреса» справді сходиться.
 */

const OWNER = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44'
const OTHER_OWNER = 'SysvarC1ock11111111111111111111111111111111'
/** Гаманець дозволяє назвати акаунт як завгодно — у тому числі іменем людини. */
const PERSONAL_LABEL = 'Jane Roe — main account'

type Listener = () => void

class FakeWallet implements Wallet {
  readonly version = '1.0.0' as const
  readonly icon: WalletIcon = 'data:image/svg+xml;base64,PHN2Zy8+'
  readonly name: string
  readonly chains: IdentifierArray
  #accounts: readonly WalletAccount[] = []
  #listeners = new Set<Listener>()
  #address: string

  constructor(name: string, chain: IdentifierString, address = OWNER) {
    this.name = name
    this.chains = [chain]
    this.#address = address
  }

  get accounts(): readonly WalletAccount[] {
    return this.#accounts
  }

  get features() {
    return {
      'standard:connect': {
        version: '1.0.0' as const,
        connect: async () => {
          this.#accounts = [
            {
              address: this.#address,
              publicKey: new Uint8Array(32),
              chains: this.chains,
              features: [SolanaSignAndSendTransaction],
              label: PERSONAL_LABEL,
            },
          ]
          this.#emit()
          return { accounts: this.#accounts }
        },
      },
      'standard:disconnect': {
        version: '1.0.0' as const,
        disconnect: async () => {
          this.#accounts = []
          this.#emit()
        },
      },
      'standard:events': {
        version: '1.0.0' as const,
        on: (_event: 'change', listener: Listener) => {
          this.#listeners.add(listener)
          return () => this.#listeners.delete(listener)
        },
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0' as const,
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async () => [],
      },
    }
  }

  #emit() {
    for (const listener of this.#listeners) listener()
  }
}

let unregister: (() => void) | null = null

function registerWallets(...wallets: Wallet[]): void {
  unregister = getWallets().register(...wallets)
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  unregister?.()
  unregister = null
  window.localStorage.clear()
})

function renderMenu() {
  return render(
    <WalletProvider cluster="devnet">
      <WalletMenu />
    </WalletProvider>,
  )
}

describe('підключення гаманця', () => {
  it('гаманець нашої мережі з’являється кнопкою підключення', () => {
    registerWallets(new FakeWallet('Test Wallet', SOLANA_DEVNET_CHAIN))
    renderMenu()
    expect(screen.getByRole('button', { name: 'Connect Test Wallet' })).toBeTruthy()
  })

  it('підключення показує адресу — і це вся «сесія»', async () => {
    registerWallets(new FakeWallet('Test Wallet', SOLANA_DEVNET_CHAIN))
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Test Wallet' }))
    expect(await screen.findByText('De1e…vR44')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy()
  })

  it('між сесіями зберігається лише «назва гаманця:адреса» — жодних персональних даних', async () => {
    registerWallets(new FakeWallet('Test Wallet', SOLANA_DEVNET_CHAIN))
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Test Wallet' }))
    await screen.findByText('De1e…vR44')

    const stored = window.localStorage.getItem(SELECTED_WALLET_STORAGE_KEY)
    expect(stored).toBe(`Test Wallet:${OWNER}`)
    // `label` акаунта гаманець дає довільний, у тому числі з іменем людини.
    expect(stored).not.toContain(PERSONAL_LABEL)
    expect(window.localStorage.length).toBe(1)
  })

  it('від’єднання прибирає адресу й вибір зі сховища', async () => {
    registerWallets(new FakeWallet('Test Wallet', SOLANA_DEVNET_CHAIN))
    renderMenu()
    fireEvent.click(screen.getByRole('button', { name: 'Connect Test Wallet' }))
    await screen.findByText('De1e…vR44')

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByRole('button', { name: 'Connect Test Wallet' })).toBeTruthy()
    expect(window.localStorage.getItem(SELECTED_WALLET_STORAGE_KEY)).toBeNull()
  })

  it('відновлює вибір із попередньої сесії, не питаючи вдруге', async () => {
    const wallet = new FakeWallet('Test Wallet', SOLANA_DEVNET_CHAIN)
    // Гаманець уже авторизований у цьому браузері: акаунти є до рендера.
    await wallet.features['standard:connect'].connect()
    window.localStorage.setItem(SELECTED_WALLET_STORAGE_KEY, `Test Wallet:${OWNER}`)
    registerWallets(wallet)

    renderMenu()
    expect(await screen.findByText('De1e…vR44')).toBeTruthy()
  })

  it('чужий збережений вибір не підставляє чужу адресу', async () => {
    const wallet = new FakeWallet('Test Wallet', SOLANA_DEVNET_CHAIN)
    await wallet.features['standard:connect'].connect()
    window.localStorage.setItem(SELECTED_WALLET_STORAGE_KEY, `Test Wallet:${OTHER_OWNER}`)
    registerWallets(wallet)

    renderMenu()
    expect(screen.queryByText('De1e…vR44')).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect Test Wallet' })).toBeTruthy()
  })
})

describe('гаманець не тієї мережі', () => {
  it('не пропонується до підключення, і причина названа', () => {
    registerWallets(new FakeWallet('Mainnet Only', SOLANA_MAINNET_CHAIN))
    renderMenu()
    expect(screen.queryByRole('button', { name: 'Connect Mainnet Only' })).toBeNull()
    expect(screen.getByText(/none of them works on solana:devnet/)).toBeTruthy()
  })

  it('гаманців немає взагалі — інший текст, ніж «є, але не та мережа»', () => {
    renderMenu()
    expect(screen.getByText(/No wallet detected/)).toBeTruthy()
  })
})
