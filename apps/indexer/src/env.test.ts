import { DirectDatabaseConnectionError } from '@cancelchain/db'
import { describe, expect, it } from 'vitest'
import { indexerConfigFromEnv } from './env.js'

const CHAIN = {
  SOLANA_CLUSTER: 'devnet',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  DATABASE_URL: 'postgresql://user:pass@db.example.supabase.com:6543/postgres',
}
const DIRECT = 'postgresql://user:pass@db.example.supabase.com:5432/postgres'

describe('indexerConfigFromEnv', () => {
  it('defaults to the WebSocket path and info logs', () => {
    expect(indexerConfigFromEnv(CHAIN)).toMatchObject({ useWs: true, logLevel: 'info' })
  })

  it('reads "false" as false — not as a truthy string', () => {
    expect(indexerConfigFromEnv({ ...CHAIN, INDEXER_USE_WS: 'false' }).useWs).toBe(false)
  })

  it('announces a charge 24 hours ahead unless told otherwise (T043)', () => {
    expect(indexerConfigFromEnv(CHAIN).pushUpcomingLeadHours).toBe(24)
    expect(
      indexerConfigFromEnv({ ...CHAIN, PUSH_UPCOMING_LEAD_HOURS: '' }).pushUpcomingLeadHours,
    ).toBe(24)
    expect(
      indexerConfigFromEnv({ ...CHAIN, PUSH_UPCOMING_LEAD_HOURS: '6' }).pushUpcomingLeadHours,
    ).toBe(6)
    expect(() => indexerConfigFromEnv({ ...CHAIN, PUSH_UPCOMING_LEAD_HOURS: '0' })).toThrow()
    expect(() => indexerConfigFromEnv({ ...CHAIN, PUSH_UPCOMING_LEAD_HOURS: 'soon' })).toThrow()
  })

  it('refuses anything but true or false', () => {
    expect(() => indexerConfigFromEnv({ ...CHAIN, INDEXER_USE_WS: '0' })).toThrow()
  })

  it('refuses to start without a database — events would go nowhere', () => {
    expect(() => indexerConfigFromEnv({ ...CHAIN, DATABASE_URL: undefined })).toThrow()
  })

  it('refuses a direct connection unless it is opted into, like the API', () => {
    expect(() => indexerConfigFromEnv({ ...CHAIN, DATABASE_URL: DIRECT })).toThrow(
      DirectDatabaseConnectionError,
    )
    expect(
      indexerConfigFromEnv({ ...CHAIN, DATABASE_URL: DIRECT, ALLOW_DIRECT_DATABASE: 'true' })
        .allowDirectDatabase,
    ).toBe(true)
  })

  it('refuses to start without a chain endpoint', () => {
    expect(() => indexerConfigFromEnv({ SOLANA_CLUSTER: 'devnet' })).toThrow()
  })
})
