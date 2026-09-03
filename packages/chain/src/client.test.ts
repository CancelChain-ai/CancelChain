import { describe, expect, it } from 'vitest'
import {
  CLUSTERS,
  chainConfigFromEnv,
  chainConfigSchema,
  createChainClient,
  deriveWsUrl,
  MainnetNotAllowedError,
  PROGRAM_ADDRESS,
} from './client.js'

const DEVNET = {
  cluster: 'devnet',
  rpcUrl: 'https://devnet.helius-rpc.com/?api-key=test',
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
} as const

describe('PROGRAM_ADDRESS', () => {
  it('це адреса Subscriptions Delegation Program', () => {
    expect(PROGRAM_ADDRESS).toBe('De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44')
  })
})

describe('deriveWsUrl', () => {
  it('https → wss зі збереженням шляху й ключа API', () => {
    expect(deriveWsUrl('https://devnet.helius-rpc.com/?api-key=abc')).toBe(
      'wss://devnet.helius-rpc.com/?api-key=abc',
    )
  })

  it('http → ws зі збереженням порту', () => {
    expect(deriveWsUrl('http://127.0.0.1:8899/')).toBe('ws://127.0.0.1:8899/')
  })
})

describe('chainConfigSchema', () => {
  it('приймає devnet-конфігурацію без wsUrl', () => {
    expect(chainConfigSchema.parse(DEVNET).wsUrl).toBeUndefined()
  })

  it('приймає всі чотири кластери', () => {
    for (const cluster of CLUSTERS) {
      expect(chainConfigSchema.parse({ ...DEVNET, cluster }).cluster).toBe(cluster)
    }
  })

  it('відхиляє невідомий кластер', () => {
    expect(() => chainConfigSchema.parse({ ...DEVNET, cluster: 'mainnet' })).toThrow()
  })

  it('відхиляє ws-адресу в полі rpcUrl', () => {
    expect(() => chainConfigSchema.parse({ ...DEVNET, rpcUrl: 'wss://example.com' })).toThrow(
      /http\(s\) URL/,
    )
  })

  /** Найчастіша помилка конфігурації: та сама https-адреса скопійована в обидві змінні. */
  it('відхиляє http-адресу в полі wsUrl', () => {
    expect(() => chainConfigSchema.parse({ ...DEVNET, wsUrl: DEVNET.rpcUrl })).toThrow(
      /ws\(s\) URL/,
    )
  })

  it('відхиляє рядок, що взагалі не є URL', () => {
    expect(() => chainConfigSchema.parse({ ...DEVNET, rpcUrl: 'devnet.helius-rpc.com' })).toThrow()
  })

  it('відхиляє міну, що не є base58-адресою', () => {
    expect(() => chainConfigSchema.parse({ ...DEVNET, usdcMint: 'REPLACE_ME' })).toThrow()
  })
})

describe('chainConfigFromEnv', () => {
  it('читає змінні з переданої мапи, а не з process.env', () => {
    const config = chainConfigFromEnv({
      SOLANA_CLUSTER: 'devnet',
      SOLANA_RPC_URL: DEVNET.rpcUrl,
      SOLANA_WS_URL: 'wss://devnet.helius-rpc.com/?api-key=test',
      USDC_MINT: DEVNET.usdcMint,
    })
    expect(config.cluster).toBe('devnet')
    expect(config.wsUrl).toBe('wss://devnet.helius-rpc.com/?api-key=test')
  })

  it('падає на порожньому оточенні, а не повертає напівзаповнений конфіг', () => {
    expect(() => chainConfigFromEnv({})).toThrow()
  })
})

describe('createChainClient', () => {
  it('дає rpc, підписки, адресу програми й міну', () => {
    const client = createChainClient(DEVNET)
    expect(client.cluster).toBe('devnet')
    expect(client.programAddress).toBe(PROGRAM_ADDRESS)
    expect(client.usdcMint).toBe(DEVNET.usdcMint)
    expect(typeof client.rpc.getAccountInfo).toBe('function')
    expect(typeof client.rpc.getProgramAccounts).toBe('function')
    expect(typeof client.rpc.getSignaturesForAddress).toBe('function')
    expect(typeof client.rpcSubscriptions.logsNotifications).toBe('function')
  })

  /**
   * Сервер не має гаманця (`FR-016`, `FR-017`), тож клієнт не повинен уміти
   * підписувати чи надсилати. Плагіна `subscriptionsProgram()` тут немає саме
   * тому — його вимоги включають надсилання транзакцій.
   */
  it('не вміє підписувати й надсилати транзакції', () => {
    const client = createChainClient(DEVNET)
    expect(client).not.toHaveProperty('signAndSendTransaction')
    expect(client).not.toHaveProperty('sendTransaction')
    expect(client).not.toHaveProperty('payer')
    expect(client).not.toHaveProperty('subscriptions')
  })

  it('виводить wsUrl із rpcUrl, коли той не заданий', () => {
    expect(() => createChainClient(DEVNET)).not.toThrow()
  })

  it('відхиляє mainnet без явного опту', () => {
    expect(() => createChainClient({ ...DEVNET, cluster: 'mainnet-beta' })).toThrow(
      MainnetNotAllowedError,
    )
  })

  it('пускає mainnet лише з allowMainnet: true', () => {
    const client = createChainClient({ ...DEVNET, cluster: 'mainnet-beta' }, { allowMainnet: true })
    expect(client.cluster).toBe('mainnet-beta')
  })

  it('валідує вхід сам, а не покладається на виклик через схему', () => {
    expect(() => createChainClient({ ...DEVNET, rpcUrl: 'not a url' })).toThrow()
  })
})
