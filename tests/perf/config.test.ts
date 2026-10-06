import { describe, expect, it } from 'vitest'
import {
  assertKeyedRpc,
  DEFAULT_API_URL,
  DEFAULT_APP_URL,
  PerfConfigError,
  perfConfigFromEnv,
} from './config.js'

const env = {
  SOLANA_CLUSTER: 'devnet',
  SOLANA_RPC_URL: 'https://devnet.example-rpc.test/?api-key=secret-key-value',
  USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  MERCHANT_SIM_KEYPAIR_PATH: '/keys/merchant.keypair.json',
  PERF_OWNER_KEYPAIR_PATH: '/keys/owner.keypair.json',
}

describe('assertKeyedRpc', () => {
  it('refuses the public devnet node and names the host', () => {
    expect(() => assertKeyedRpc('https://api.devnet.solana.com')).toThrow(
      /api\.devnet\.solana\.com/,
    )
  })

  it('never prints the key of a node it refuses', () => {
    const messages = [
      'https://api.devnet.solana.com/?api-key=secret-key-value',
      'not a url secret-key-value',
    ].map((url) => {
      try {
        assertKeyedRpc(url)
        return null
      } catch (error) {
        return error instanceof PerfConfigError ? error.message : `other: ${String(error)}`
      }
    })
    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message).not.toBeNull()
      expect(message).not.toContain('secret-key-value')
      expect(message).not.toMatch(/^other:/)
    }
  })

  it('lets a keyed node through', () => {
    expect(() => assertKeyedRpc(env.SOLANA_RPC_URL)).not.toThrow()
  })
})

describe('perfConfigFromEnv', () => {
  it('points at the deployed stand unless told otherwise', () => {
    const config = perfConfigFromEnv(env)
    expect(config.appUrl).toBe(DEFAULT_APP_URL)
    expect(config.apiUrl).toBe(DEFAULT_API_URL)
    expect(config.ownerKeypairPath).toBe('/keys/owner.keypair.json')
  })

  it('needs the owner key: the merchant cannot grant or revoke for the owner', () => {
    expect(() => perfConfigFromEnv({ ...env, PERF_OWNER_KEYPAIR_PATH: '' })).toThrow(
      /PERF_OWNER_KEYPAIR_PATH/,
    )
  })

  it('refuses the public node before anything is sent', () => {
    expect(() =>
      perfConfigFromEnv({ ...env, SOLANA_RPC_URL: 'https://api.devnet.solana.com' }),
    ).toThrow(PerfConfigError)
  })

  it('drops a trailing slash from the API, keeps the app URL as given', () => {
    const config = perfConfigFromEnv({
      ...env,
      PERF_API_URL: 'http://localhost:8890/',
      PERF_APP_URL: 'http://localhost:5183/app/',
    })
    expect(config.apiUrl).toBe('http://localhost:8890')
    expect(config.appUrl).toBe('http://localhost:5183/app/')
  })
})
