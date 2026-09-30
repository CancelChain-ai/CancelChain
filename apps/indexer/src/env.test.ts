import { describe, expect, it } from 'vitest'
import { indexerConfigFromEnv } from './env.js'

const CHAIN = {
  SOLANA_CLUSTER: 'devnet',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
}

describe('indexerConfigFromEnv', () => {
  it('defaults to the WebSocket path and info logs', () => {
    expect(indexerConfigFromEnv(CHAIN)).toMatchObject({ useWs: true, logLevel: 'info' })
  })

  it('reads "false" as false — not as a truthy string', () => {
    expect(indexerConfigFromEnv({ ...CHAIN, INDEXER_USE_WS: 'false' }).useWs).toBe(false)
  })

  it('refuses anything but true or false', () => {
    expect(() => indexerConfigFromEnv({ ...CHAIN, INDEXER_USE_WS: '0' })).toThrow()
  })

  it('refuses to start without a chain endpoint', () => {
    expect(() => indexerConfigFromEnv({ SOLANA_CLUSTER: 'devnet' })).toThrow()
  })
})
