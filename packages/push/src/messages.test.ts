import { describe, expect, it } from 'vitest'
import {
  AT_TOKEN,
  pushMessageSchema,
  rejectedMessage,
  upcomingMessage,
  welcomeMessage,
} from './messages.js'

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const PDA = 'CKjAhy63Z6QsK1StE57hufCiXyFqBqHHh6P4mM8q5yB2'
const PLAN = 'EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg'
const MERCHANT = 'FGHMNoNNq3aMvTxrfeNRzS6SwE7SKZp6UyZ7FMjjf3nk'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const OTHER_MINT = 'So11111111111111111111111111111111111111112'

describe('welcomeMessage', () => {
  it('names the wallet the browser now follows', () => {
    const message = welcomeMessage(OWNER)
    expect(pushMessageSchema.parse(message)).toEqual(message)
    expect(message.body).toContain('CuXt…vnSR')
    expect(message.allowance).toBeNull()
  })
})

describe('upcomingMessage', () => {
  const charge = {
    pda: PDA,
    kind: 'subscription' as const,
    delegate: MERCHANT,
    planPda: PLAN,
    mint: USDC,
    usdcMint: USDC,
    capAmount: 10_000_000n,
    dueAt: '2026-10-07T12:00:00.000Z',
  }

  it('says when, who and up to how much — the time left to the browser', () => {
    const message = upcomingMessage(charge)
    expect(pushMessageSchema.parse(message)).toEqual(message)
    expect(message.title).toBe(`Charge due ${AT_TOKEN}`)
    expect(message.body).toBe(
      'Merchant plan EwH6…M2mg may take up to 10.00 USDC. Cancel before then and the attempt will be refused.',
    )
    expect(message.at).toBe(charge.dueAt)
    expect(message.allowance).toBe(PDA)
  })

  it('names a recurring permission by the merchant wallet', () => {
    const message = upcomingMessage({ ...charge, kind: 'recurring', planPda: null })
    expect(message.body).toMatch(/^Merchant wallet FGHM…f3nk may take up to/)
  })

  it('does not give an unknown asset decimals it may not have', () => {
    const message = upcomingMessage({ ...charge, mint: OTHER_MINT, capAmount: 2_500n })
    expect(message.body).toContain('up to 2500 of So11…1112.')
  })

  it('keeps one notification per permission on screen', () => {
    expect(upcomingMessage(charge).tag).toBe(upcomingMessage(charge).tag)
    expect(upcomingMessage(charge).tag).not.toBe(upcomingMessage({ ...charge, pda: PLAN }).tag)
  })
})

describe('rejectedMessage', () => {
  const refusal = {
    pda: PDA,
    kind: 'subscription' as const,
    delegate: MERCHANT,
    planPda: PLAN,
    mint: USDC,
    usdcMint: USDC,
    amount: 10_000_000n,
    reason: 'revoked' as const,
    blockTime: '2026-10-06T09:30:00.000Z',
  }

  it('says who tried what, and why the chain refused, in the feed words', () => {
    const message = rejectedMessage(refusal)
    expect(pushMessageSchema.parse(message)).toEqual(message)
    expect(message.title).toBe('Charge refused')
    expect(message.body).toBe(
      `Merchant plan EwH6…M2mg tried 10.00 USDC at ${AT_TOKEN}: Permission cancelled.`,
    )
    expect(message.at).toBe(refusal.blockTime)
  })

  it('says so when the amount is unknown, and when the reason is', () => {
    const message = rejectedMessage({ ...refusal, amount: null, reason: null })
    expect(message.body).toBe(
      `Merchant plan EwH6…M2mg tried to charge at ${AT_TOKEN}: Rejected by the network — reason not recognised.`,
    )
  })
})
