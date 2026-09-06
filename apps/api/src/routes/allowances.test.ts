import { type AllowanceReadResult, toAddress } from '@cancelchain/chain'
import {
  apiErrorSchema,
  listAllowancesResponseSchema,
  listedAllowanceSchema,
} from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app.js'
import { createLogger } from '../logger.js'
import type { HealthDeps } from './health.js'

const OWNER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const MERCHANT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const OTHER_MINT = 'So11111111111111111111111111111111111111112'
const PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH'
const OTHER_PDA = 'Stake11111111111111111111111111111111111111'
const JUNK_PDA = 'Vote111111111111111111111111111111111111111'

const SYNCED_AT = '2026-09-02T12:00:00.000Z'
const SLOT = 412_345_678

const HEALTH: HealthDeps = {
  ping: async () => {},
  currentSlot: async () => SLOT,
  cachedAt: async () => null,
  startedAt: Date.parse(SYNCED_AT),
}

type Allowance = AllowanceReadResult['allowances'][number]

function allowance(overrides: Partial<Allowance> = {}): Allowance {
  return {
    pda: PDA,
    owner: OWNER,
    delegate: MERCHANT,
    mint: USDC,
    kind: 'fixed',
    capAmount: '25000000',
    periodSeconds: null,
    spentInPeriod: '0',
    periodStartedAt: null,
    expiresAt: null,
    pausedAt: null,
    endsAt: null,
    status: 'active',
    planPda: null,
    lastSlot: SLOT,
    syncedAt: SYNCED_AT,
    assetSupported: true,
    ...overrides,
  }
}

function result(overrides: Partial<AllowanceReadResult> = {}): AllowanceReadResult {
  return { slot: SLOT, syncedAt: SYNCED_AT, allowances: [], unreadable: [], ...overrides }
}

function app(list: AppDeps['allowances']['list'], overrides: Partial<AppDeps> = {}) {
  return createApp({
    logger: createLogger('silent'),
    health: HEALTH,
    allowances: { list },
    ...overrides,
  })
}

const get = (list: AppDeps['allowances']['list'], query = `?owner=${OWNER}`) =>
  app(list).request(`/v1/allowances${query}`)

describe('GET /v1/allowances', () => {
  it('віддає рівно ту форму, яку описує listAllowancesResponseSchema зі shared', async () => {
    const res = await get(async () => result({ allowances: [allowance()] }))

    expect(res.status).toBe(200)
    const body = listAllowancesResponseSchema.parse(await res.json())
    expect(body.items).toHaveLength(1)
    expect(body.syncedAt).toBe(SYNCED_AT)
    expect(body.unreadable).toEqual([])
  })

  it('питає рівно того власника, що в запиті', async () => {
    const asked: string[] = []
    await get(async (owner) => {
      asked.push(owner)
      return result()
    })

    expect(asked).toEqual([OWNER])
  })

  it('порожній гаманець — порожній список, а не помилка', async () => {
    const res = await get(async () => result())

    expect(res.status).toBe(200)
    expect(listAllowancesResponseSchema.parse(await res.json()).items).toEqual([])
  })

  it('невалідна адреса власника — INVALID_INPUT, до мережі не ходимо', async () => {
    let asked = 0
    const res = await get(async () => {
      asked += 1
      return result()
    }, '?owner=not-an-address')

    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('INVALID_INPUT')
    expect(asked).toBe(0)
  })

  it('власника не передали — INVALID_INPUT', async () => {
    const res = await get(async () => result(), '')

    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('INVALID_INPUT')
  })

  it('відмова мережі не тече назовні текстом — INTERNAL', async () => {
    const res = await get(() => Promise.reject(new Error('https://rpc.example/?api-key=secret')))

    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(apiErrorSchema.parse(JSON.parse(raw)).error.code).toBe('INTERNAL')
    expect(raw).not.toContain('secret')
  })
})

describe('позначка активу доходить до клієнта — FR-020', () => {
  it('assetSupported не губиться на межі API', async () => {
    const res = await get(async () =>
      result({
        allowances: [
          allowance(),
          allowance({ pda: OTHER_PDA, mint: OTHER_MINT, assetSupported: false }),
        ],
      }),
    )

    const body = listAllowancesResponseSchema.parse(await res.json())
    expect(body.items.map((item) => [item.pda, item.assetSupported])).toEqual([
      [PDA, true],
      [OTHER_PDA, false],
    ])
  })

  /**
   * `allowanceSchema` зрізає невідомі ключі, тож без `listedAllowanceSchema`
   * позначка зникла б **мовчки** — відповідь лишалася б валідною, а дозвіл у
   * чужому активі виглядав би звичайним.
   */
  it('схема списку описує позначку, а не зрізає її', () => {
    const parsed = listedAllowanceSchema.parse(allowance({ assetSupported: false }))
    expect(parsed.assetSupported).toBe(false)
  })
})

describe('нечитані акаунти доходять до клієнта — FR-006', () => {
  it('віддаються категорією, а список від цього не коротшає мовчки', async () => {
    const res = await get(async () =>
      result({
        allowances: [allowance()],
        unreadable: [
          { address: toAddress(JUNK_PDA), reason: 'version', detail: 'account version 2' },
          { address: toAddress(OTHER_PDA), reason: 'plan', detail: 'needs its plan' },
        ],
      }),
    )

    const body = listAllowancesResponseSchema.parse(await res.json())
    expect(body.items).toHaveLength(1)
    expect(body.unreadable).toEqual([
      { address: JUNK_PDA, reason: 'version' },
      { address: OTHER_PDA, reason: 'plan' },
    ])
  })

  /** Діагностика лишається в лозі: назовні йде категорія, не текст помилки. */
  it('текст помилки назовні не йде', async () => {
    const res = await get(async () =>
      result({
        unreadable: [
          {
            address: toAddress(JUNK_PDA),
            reason: 'fields',
            detail: 'period length out of range: 0',
          },
        ],
      }),
    )

    expect(await res.text()).not.toContain('period length out of range')
  })
})

describe('stale', () => {
  /**
   * До індексатора (`T038`) кешу не існує: відповідь щойно прочитана з мережі.
   * `false` тут — твердження «це не кеш», а не заглушка.
   */
  it('поки джерело — мережа, список не буває несвіжим', async () => {
    const res = await get(async () => result({ allowances: [allowance()] }))

    expect(listAllowancesResponseSchema.parse(await res.json()).stale).toBe(false)
  })
})
