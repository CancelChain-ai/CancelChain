import { NotAPlanError, PlanNotFoundError, type PlanSnapshot, toAddress } from '@cancelchain/chain'
import type { Plan, PlanSubscriber } from '@cancelchain/shared'
import { apiErrorSchema, getPlanViewResponseSchema } from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app.js'
import { createLogger } from '../logger.js'
import type { PlansDeps } from './plans.js'

const MERCHANT = toAddress('FGHMNoGvR5zP9K5Cs4XrwZhQnAxNrFEQYH3TK22fBkKF')
const SUBSCRIBER = toAddress('4DYhzGx6zWLmFDCBLJfCyRpTBnJnbfLqzHz7BvUJBFHU')
const PLAN_PDA = toAddress('EwH6mqofjSWnzLRaMraBneQx3MyKsjqCfz2tREZUM2mg')
const MINT = toAddress('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const TOKEN_PROGRAM = toAddress('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const AUTHORITY = toAddress('6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH')
const SUBSCRIPTION = toAddress('Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr')
const SLOT = 312_345_678
const SYNCED_AT = '2026-09-26T12:00:00.000Z'
const CREATED_AT = '2026-09-21T12:00:00.000Z'

function snapshot(overrides: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    pda: PLAN_PDA,
    owner: MERCHANT,
    status: 'active',
    planId: 1_789_990_423_243n,
    mint: MINT,
    amount: 9_990_000n,
    periodHours: 720,
    createdAt: CREATED_AT,
    endsAt: null,
    destinations: [MERCHANT],
    pullers: [MERCHANT],
    metadataUri: '',
    ...overrides,
  }
}

const ROW: Plan = {
  pda: PLAN_PDA,
  merchant: MERCHANT,
  planId: '1789990423243',
  name: 'Studio monthly',
  amount: '9990000',
  periodSeconds: 720 * 3600,
  mint: MINT,
  createdAt: CREATED_AT,
}

const SUBSCRIBER_STATE: PlanSubscriber = {
  address: SUBSCRIBER,
  authority: AUTHORITY,
  authorityInitId: '7',
  tokenProgram: TOKEN_PROGRAM,
  tokenAccount: AUTHORITY,
  tokenAccountExists: true,
  subscription: SUBSCRIPTION,
  subscribed: false,
}

function app(overrides: Partial<PlansDeps> = {}) {
  const asked: string[] = []
  const plans: PlansDeps = {
    plan: async () => snapshot(),
    catalog: async () => ROW,
    subscriber: async ({ subscriber }) => {
      asked.push(subscriber)
      return SUBSCRIBER_STATE
    },
    settlementMint: MINT,
    now: () => new Date(SYNCED_AT),
    ...overrides,
  }
  const deps: AppDeps = {
    logger: createLogger('silent'),
    health: {
      ping: async () => {},
      currentSlot: async () => SLOT,
      cachedAt: async () => null,
      startedAt: Date.parse(SYNCED_AT),
      now: () => Date.parse(SYNCED_AT),
    },
    allowances: {
      list: async () => ({ slot: SLOT, syncedAt: SYNCED_AT, allowances: [], unreadable: [] }),
      get: async () => ({ slot: SLOT, syncedAt: SYNCED_AT, allowance: null, unreadable: null }),
      cached: async () => null,
      settlementMint: MINT,
    },
    signatures: { history: async () => ({ items: [], syncedAt: SYNCED_AT, more: false }) },
    merchants: {
      jwtSecret: 'test-secret-at-least-32-characters',
      domain: 'localhost',
      plan: async () => snapshot(),
      save: async () => {},
      verifySignature: async () => false,
    },
    plans,
    blockhash: {
      latestBlockhash: async () => ({
        blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
        lastValidBlockHeight: 492_096_495n,
        slot: SLOT,
      }),
    },
    rateLimit: { limit: 1000 },
  }
  return { app: createApp(deps), asked }
}

async function view(response: Response) {
  expect(response.status).toBe(200)
  return getPlanViewResponseSchema.parse(await response.json())
}

describe('GET /v1/plans/:pda', () => {
  it('answers without a token: the subscriber is not a merchant', async () => {
    const { app: server } = app()
    const body = await view(await server.request(`/v1/plans/${PLAN_PDA}`))
    expect(body.chain).toEqual({
      pda: PLAN_PDA,
      merchant: MERCHANT,
      planId: '1789990423243',
      mint: MINT,
      amount: '9990000',
      periodSeconds: 2_592_000,
      createdAt: CREATED_AT,
      status: 'active',
      endsAt: null,
      destinations: [MERCHANT],
      pullers: [MERCHANT],
    })
    expect(body.catalog).toEqual({ state: 'named', plan: ROW })
    expect(body.diverged).toEqual([])
    expect(body.assetSupported).toBe(true)
    expect(body.syncedAt).toBe(SYNCED_AT)
  })

  it('a plan in another mint is marked, not dropped', async () => {
    const { app: server } = app({ settlementMint: TOKEN_PROGRAM })
    const body = await view(await server.request(`/v1/plans/${PLAN_PDA}`))
    expect(body.assetSupported).toBe(false)
    expect(body.chain.mint).toBe(MINT)
  })

  it('a catalog row that no longer matches the chain is named field by field', async () => {
    const { app: server } = app({
      plan: async () => snapshot({ amount: 99_900_000n, createdAt: '2026-09-25T08:00:00.000Z' }),
    })
    const body = await view(await server.request(`/v1/plans/${PLAN_PDA}`))
    expect(body.diverged).toEqual(['amount', 'createdAt'])
    // The chain is still what the response carries as the plan.
    expect(body.chain.amount).toBe('99900000')
    expect(body.catalog).toEqual({ state: 'named', plan: ROW })
  })

  it('no catalog row is "unnamed", with nothing to diverge from', async () => {
    const { app: server } = app({ catalog: async () => null })
    const body = await view(await server.request(`/v1/plans/${PLAN_PDA}`))
    expect(body.catalog).toEqual({ state: 'unnamed' })
    expect(body.diverged).toEqual([])
  })

  it('storage down is "unavailable", not "unnamed", and the chain part still arrives', async () => {
    const { app: server } = app({
      catalog: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6543')
      },
    })
    const body = await view(await server.request(`/v1/plans/${PLAN_PDA}`))
    expect(body.catalog).toEqual({ state: 'unavailable' })
    expect(body.chain.pda).toBe(PLAN_PDA)
  })

  it('no plan on the chain is 404, whatever the catalog holds', async () => {
    for (const error of [
      new PlanNotFoundError(PLAN_PDA),
      new NotAPlanError(PLAN_PDA, 'it belongs to someone else'),
    ]) {
      const { app: server } = app({
        plan: async () => {
          throw error
        },
      })
      const response = await server.request(`/v1/plans/${PLAN_PDA}`)
      expect(response.status).toBe(404)
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe('NOT_FOUND')
    }
  })

  it('a failing chain read is not dressed up as 404', async () => {
    const { app: server } = app({
      plan: async () => {
        throw new Error('429 Too Many Requests')
      },
    })
    expect((await server.request(`/v1/plans/${PLAN_PDA}`)).status).toBe(500)
  })

  it('the subscriber part comes only when asked for, and for that wallet', async () => {
    const { app: server, asked } = app()
    expect((await view(await server.request(`/v1/plans/${PLAN_PDA}`))).subscriber).toBeNull()
    expect(asked).toEqual([])

    const body = await view(await server.request(`/v1/plans/${PLAN_PDA}?subscriber=${SUBSCRIBER}`))
    expect(body.subscriber).toEqual(SUBSCRIBER_STATE)
    expect(asked).toEqual([SUBSCRIBER])
  })

  it('refuses a malformed address in the path or the query', async () => {
    const { app: server } = app()
    expect((await server.request('/v1/plans/not-a-plan')).status).toBe(400)
    expect((await server.request(`/v1/plans/${PLAN_PDA}?subscriber=nope`)).status).toBe(400)
  })
})
