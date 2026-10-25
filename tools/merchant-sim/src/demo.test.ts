import { createKeyPairSignerFromBytes, getBase58Encoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { KeypairPathError, MainnetForbiddenError } from './config.js'
import {
  DEFAULT_API_URL,
  DEFAULT_APP_URL,
  DemoConfigError,
  type DemoState,
  demoConfigFromEnv,
  liveRecurring,
  newKeypairBytes,
  ownerKeyBase58,
  parseDemoState,
  planIsSpent,
  subscribeLink,
  usdc,
} from './demo.js'
import { KeypairFileError } from './keypair.js'

const OWNER = '7nE9GvcwsqzYcPUYfm5gxzCKfmPkzvGWmKpxMrjgjdmj'
const MERCHANT = 'Hf3TgGe2pXvSn9ZsUEoT6bpaZmyJbVaJXg6ZTUPa8Lp8'
const OTHER = '4DYhzGx6EpbZq6g1cZG8x7VJ4JpFNtpXVU7NJ4ek4o7T'
const PDA_1 = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
const PDA_2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PLAN = 'So11111111111111111111111111111111111111112'

const ENV = {
  SOLANA_CLUSTER: 'devnet',
  SOLANA_RPC_URL: 'https://devnet.example.org/?api-key=k',
  USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  MERCHANT_SIM_KEYPAIR_PATH: '/keys/merchant-devnet.keypair.json',
  DEMO_OWNER_KEYPAIR_PATH: '/keys/demo-owner-devnet.keypair.json',
}

describe('demoConfigFromEnv', () => {
  it('defaults to the deployed stand and keeps the state next to the owner key', () => {
    const config = demoConfigFromEnv(ENV)
    expect(config.ownerKeypairPath).toBe('/keys/demo-owner-devnet.keypair.json')
    expect(config.statePath).toBe('/keys/demo-owner-devnet.demo.json')
    expect(config.appUrl).toBe(DEFAULT_APP_URL)
    expect(config.apiUrl).toBe(DEFAULT_API_URL)
    expect(config.authDomain).toBe('cancelchain-ai.github.io')
  })

  it('takes what the environment names, and the auth domain from the app by default', () => {
    const config = demoConfigFromEnv({
      ...ENV,
      DEMO_STATE_PATH: '/elsewhere/run.json',
      DEMO_APP_URL: 'http://localhost:5173/app/',
      DEMO_API_URL: 'http://localhost:8787///',
    })
    expect(config.statePath).toBe('/elsewhere/run.json')
    expect(config.apiUrl).toBe('http://localhost:8787')
    expect(config.authDomain).toBe('localhost:5173')
    expect(demoConfigFromEnv({ ...ENV, DEMO_AUTH_DOMAIN: 'a.example' }).authDomain).toBe(
      'a.example',
    )
  })

  it('refuses an owner key that is missing, outside the ignored pattern, or the merchant key', () => {
    expect(() => demoConfigFromEnv({ ...ENV, DEMO_OWNER_KEYPAIR_PATH: '' })).toThrow(
      KeypairPathError,
    )
    expect(() =>
      demoConfigFromEnv({ ...ENV, DEMO_OWNER_KEYPAIR_PATH: '/keys/owner.json' }),
    ).toThrow(/\.keypair\.json/)
    expect(() =>
      demoConfigFromEnv({ ...ENV, DEMO_OWNER_KEYPAIR_PATH: ENV.MERCHANT_SIM_KEYPAIR_PATH }),
    ).toThrow(/grant permissions to itself/)
  })

  it('takes the merchant locks: no mainnet', () => {
    expect(() => demoConfigFromEnv({ ...ENV, SOLANA_CLUSTER: 'mainnet-beta' })).toThrow(
      MainnetForbiddenError,
    )
  })

  it('refuses a URL that does not parse', () => {
    expect(() => demoConfigFromEnv({ ...ENV, DEMO_API_URL: 'not a url' })).toThrow(DemoConfigError)
  })
})

const STATE: DemoState = {
  owner: OWNER,
  secondRecipient: OTHER,
  a: PDA_1,
  b: null,
  plan: PLAN,
  planNamed: true,
}

describe('parseDemoState', () => {
  it('reads the state written for this owner', () => {
    expect(parseDemoState(JSON.stringify(STATE), OWNER)).toEqual(STATE)
  })

  it('starts over on no file, a damaged file, another owner or a missing field', () => {
    expect(parseDemoState(null, OWNER)).toBeNull()
    expect(parseDemoState('{', OWNER)).toBeNull()
    expect(parseDemoState(JSON.stringify(STATE), MERCHANT)).toBeNull()
    const { planNamed: _, ...short } = STATE
    expect(parseDemoState(JSON.stringify(short), OWNER)).toBeNull()
  })
})

const recurring = (pda: string, delegate: string, status: 'active' | 'exhausted' = 'active') => ({
  pda,
  kind: 'recurring' as const,
  delegate,
  status,
  planPda: null,
})

describe('liveRecurring', () => {
  it('keeps the recorded permission when it is still active', () => {
    const held = [recurring(PDA_2, MERCHANT), recurring(PDA_1, MERCHANT)]
    expect(liveRecurring(held, MERCHANT, PDA_1)).toBe(PDA_1)
  })

  it('adopts another active one to the same recipient when the recorded one is gone', () => {
    expect(liveRecurring([recurring(PDA_2, MERCHANT)], MERCHANT, PDA_1)).toBe(PDA_2)
  })

  it('finds none for another recipient, another kind or an inactive permission', () => {
    expect(liveRecurring([recurring(PDA_1, OTHER)], MERCHANT, null)).toBeNull()
    expect(liveRecurring([recurring(PDA_1, MERCHANT, 'exhausted')], MERCHANT, PDA_1)).toBeNull()
    expect(
      liveRecurring([{ ...recurring(PDA_1, MERCHANT), kind: 'fixed' }], MERCHANT, PDA_1),
    ).toBeNull()
  })
})

describe('planIsSpent', () => {
  const subscription = {
    pda: PDA_2,
    kind: 'subscription' as const,
    delegate: PLAN,
    status: 'revoked' as const,
    planPda: PLAN,
  }

  it('needs a plan when there is none or the owner already holds a subscription to it', () => {
    expect(planIsSpent([], null)).toBe(true)
    expect(planIsSpent([subscription], PLAN)).toBe(true)
  })

  it('keeps a plan the owner has not subscribed to', () => {
    expect(planIsSpent([recurring(PDA_1, MERCHANT)], PLAN)).toBe(false)
    expect(planIsSpent([{ ...subscription, planPda: OTHER }], PLAN)).toBe(false)
  })
})

describe('owner key', () => {
  it('makes a key the solana-keygen way: the bytes load and the public half matches', async () => {
    const bytes = newKeypairBytes()
    expect(bytes).toHaveLength(64)
    // kit signs and verifies with the pair: a public half that is not the seed's throws.
    const signer = await createKeyPairSignerFromBytes(bytes)
    expect(getBase58Encoder().encode(signer.address)).toEqual(bytes.slice(32))
  })

  it('exports all 64 bytes as one base58 string, and refuses a file that is not a key', () => {
    const bytes = newKeypairBytes()
    const exported = ownerKeyBase58(JSON.stringify([...bytes]))
    expect(Uint8Array.from(getBase58Encoder().encode(exported))).toEqual(bytes)
    expect(() => ownerKeyBase58('[1,2,3]')).toThrow(KeypairFileError)
  })
})

describe('display', () => {
  it('shows USDC to the cent and links the plan by its address', () => {
    expect(usdc(9_990_000n)).toBe('9.99')
    expect(usdc('4500000')).toBe('4.50')
    expect(usdc(0n)).toBe('0.00')
    expect(subscribeLink(DEFAULT_APP_URL, PLAN)).toBe(`${DEFAULT_APP_URL}?plan=${PLAN}`)
  })
})
