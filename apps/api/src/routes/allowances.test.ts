import {
  type AllowanceReadOne,
  type AllowanceReadResult,
  type ReadAllowance,
  toAddress,
} from '@cancelchain/chain'
import type { Allowance } from '@cancelchain/shared'
import {
  allowanceDetailSchema,
  allowanceSchema,
  apiErrorSchema,
  getAllowanceResponseSchema,
  listAllowancesResponseSchema,
  listedAllowanceSchema,
} from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app.js'
import { createLogger } from '../logger.js'
import { reconcile } from './allowances.js'
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

/** Те, що віддає читання мережі: `Allowance` плюс позначка активу (`FR-020`). */
type Listed = AllowanceReadResult['allowances'][number]

function allowance(overrides: Partial<Listed> = {}): Listed {
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

const NO_ACCOUNT: AllowanceReadOne = {
  slot: SLOT,
  syncedAt: SYNCED_AT,
  allowance: null,
  unreadable: null,
}

function app(allowances: Partial<AppDeps['allowances']> = {}) {
  return createApp({
    logger: createLogger('silent'),
    health: HEALTH,
    allowances: {
      list: async () => result(),
      get: async () => NO_ACCOUNT,
      cached: async () => null,
      settlementMint: USDC,
      ...allowances,
    },
  })
}

const get = (list: AppDeps['allowances']['list'], query = `?owner=${OWNER}`) =>
  app({ list }).request(`/v1/allowances${query}`)

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

const SUB_PDA = 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe'
const PAUSED_AT = '2026-08-20T00:00:00.000Z'
const ENDS_AT = '2026-10-01T00:00:00.000Z'

/** Підписка за планом — єдиний вид дозволу, який узагалі можна поставити на паузу. */
function subscription(overrides: Partial<Allowance> = {}): Allowance {
  return allowanceSchema.parse({
    ...allowance({
      pda: SUB_PDA,
      kind: 'subscription',
      periodSeconds: 2_592_000,
      periodStartedAt: '2026-09-01T00:00:00.000Z',
      spentInPeriod: '11500000',
      planPda: PDA,
    }),
    ...overrides,
  })
}

const onChain = (chain: ReadAllowance | null, slot = SLOT): AllowanceReadOne => ({
  slot,
  syncedAt: SYNCED_AT,
  allowance: chain,
  unreadable: null,
})

const card = (deps: Partial<AppDeps['allowances']>, pda = PDA) =>
  app(deps).request(`/v1/allowances/${pda}`)

describe('GET /v1/allowances/:pda — звірка з мережею', () => {
  it('віддає форму allowanceDetailSchema зі shared', async () => {
    const res = await card({ get: async () => onChain(allowance()) })

    expect(res.status).toBe(200)
    const body = getAllowanceResponseSchema.parse(await res.json())
    expect(body.pda).toBe(PDA)
    expect(body.assetSupported).toBe(true)
    expect(body.diverged).toBe(false)
    expect(body.chainState).toMatchObject({ status: 'active', slot: SLOT })
  })

  it('дозволу немає ані в мережі, ані в сховищі — NOT_FOUND', async () => {
    const res = await card({ get: async () => onChain(null), cached: async () => null })

    expect(res.status).toBe(404)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('NOT_FOUND')
  })

  it('невалідна адреса — INVALID_INPUT, до мережі не ходимо', async () => {
    let asked = 0
    const res = await card(
      {
        get: async () => {
          asked += 1
          return onChain(allowance())
        },
      },
      'not-an-address',
    )

    expect(res.status).toBe(400)
    expect(asked).toBe(0)
  })

  /**
   * Акаунт у мережі є, але цей збірник його не читає. `NOT_FOUND` тут був би
   * брехнею рівно про те, що людина шукає, тож іде названа категорія.
   */
  it('нечитаний акаунт — не NOT_FOUND, а названа причина', async () => {
    const res = await card({
      get: async () => ({
        slot: SLOT,
        syncedAt: SYNCED_AT,
        allowance: null,
        unreadable: { address: toAddress(PDA), reason: 'version', detail: 'account version 2' },
      }),
    })

    expect(res.status).toBe(500)
    const body = apiErrorSchema.parse(await res.json())
    expect(body.error.code).toBe('INTERNAL')
    expect(body.error.details).toEqual({ reason: 'version' })
  })
})

describe('пріоритет стану мережі — FR-025', () => {
  /** Найдорожчий випадок звірки: `SC-009`. */
  it('акаунта в мережі немає, а в кеші «активний» — картка каже «скасовано»', async () => {
    const res = await card({
      get: async () => onChain(null),
      cached: async () => allowanceSchema.parse(allowance({ status: 'active' })),
    })

    const body = allowanceDetailSchema.parse(await res.json())
    expect(body.status).toBe('revoked')
    expect(body.chainState).toBeNull()
    expect(body.diverged).toBe(true)
  })

  it('кеш уже знав про скасування — розбіжності немає', async () => {
    const res = await card({
      get: async () => onChain(null),
      cached: async () => allowanceSchema.parse(allowance({ status: 'revoked' })),
    })

    const body = allowanceDetailSchema.parse(await res.json())
    expect(body.status).toBe('revoked')
    expect(body.diverged).toBe(false)
  })

  it('числа беруться з мережі, а не зі сховища', async () => {
    const res = await card({
      get: async () => onChain(allowance({ spentInPeriod: '9000000' })),
      cached: async () => allowanceSchema.parse(allowance({ spentInPeriod: '0' })),
    })

    const body = allowanceDetailSchema.parse(await res.json())
    expect(body.spentInPeriod).toBe('9000000')
    expect(body.chainState?.spentInPeriod).toBe('9000000')
    expect(body.diverged).toBe(true)
  })

  it('розбіжність у стелі теж видно', async () => {
    const res = await card({
      get: async () => onChain(allowance({ capAmount: '25000000' })),
      cached: async () => allowanceSchema.parse(allowance({ capAmount: '10000000' })),
    })

    expect(allowanceDetailSchema.parse(await res.json()).diverged).toBe(true)
  })

  it('кеша немає — розбіжності немає, бо звіряти нема з чим', async () => {
    const res = await card({
      get: async () => onChain(allowance()),
      cached: async () => null,
    })

    expect(allowanceDetailSchema.parse(await res.json()).diverged).toBe(false)
  })
})

describe('пауза — наша мітка, а не стан мережі', () => {
  /**
   * Мережа тримає паузу й «не поновлювати» в одному полі `expiresAtTs`, тож із
   * мережі підписка на паузі читається як `active`. Якби звірка порівнювала
   * статус буквально, **кожна** пауза виглядала б збоєм.
   */
  it('пауза в кеші не робить картку розбіжною', async () => {
    const chain = { ...subscription({ endsAt: ENDS_AT }), assetSupported: true }
    const res = await card(
      {
        get: async () => onChain(chain),
        cached: async () =>
          subscription({ status: 'paused', pausedAt: PAUSED_AT, endsAt: ENDS_AT }),
      },
      SUB_PDA,
    )

    const body = allowanceDetailSchema.parse(await res.json())
    expect(body.diverged).toBe(false)
    expect(body.status).toBe('paused')
    expect(body.pausedAt).toBe(PAUSED_AT)
    // Мережа паузи не зберігає — і картка про це не бреше.
    expect(body.chainState?.status).toBe('active')
    expect(body.chainState?.pausedAt).toBeNull()
  })

  /** Пріоритет мережі сильніший за нашу мітку: вичерпаний не буває «на паузі». */
  it('мережа каже «вичерпано» — мітка паузи не накладається', async () => {
    const chain = {
      ...subscription({ status: 'exhausted', endsAt: ENDS_AT }),
      assetSupported: true,
    }
    const res = await card(
      {
        get: async () => onChain(chain),
        cached: async () =>
          subscription({ status: 'paused', pausedAt: PAUSED_AT, endsAt: ENDS_AT }),
      },
      SUB_PDA,
    )

    const body = allowanceDetailSchema.parse(await res.json())
    expect(body.status).toBe('exhausted')
    expect(body.pausedAt).toBeNull()
  })

  it('акаунта в мережі немає — мітка паузи знімається разом зі станом', async () => {
    const res = await card(
      {
        get: async () => onChain(null),
        cached: async () => subscription({ status: 'paused', pausedAt: PAUSED_AT }),
      },
      SUB_PDA,
    )

    const body = allowanceDetailSchema.parse(await res.json())
    expect(body.status).toBe('revoked')
    expect(body.pausedAt).toBeNull()
    expect(body.diverged).toBe(true)
  })
})

describe('reconcile', () => {
  it('нічого нема ніде — null, а не порожня картка', () => {
    expect(reconcile({ cached: null, chain: null, slot: SLOT, settlementMint: USDC })).toBeNull()
  })

  it('слот картки — слот звірки, а не збережений', () => {
    const cached = allowanceSchema.parse(allowance({ lastSlot: 1 }))
    const detail = reconcile({ cached, chain: null, slot: SLOT, settlementMint: USDC })
    expect(detail?.lastSlot).toBe(SLOT)
  })

  /**
   * Дії живуть у картці, тож позначка активу потрібна саме тут — і рахується
   * вона з розрахункового міну, а не береться з читання мережі: скасований
   * дозвіл приходить зі сховища, читати в мережі вже нічого.
   */
  it('позначка активу є й на картці, і в скасованого дозволу теж', () => {
    const supported = reconcile({
      cached: null,
      chain: allowance(),
      slot: SLOT,
      settlementMint: USDC,
    })
    expect(supported?.assetSupported).toBe(true)

    const foreign = reconcile({
      cached: allowanceSchema.parse(allowance({ mint: OTHER_MINT })),
      chain: null,
      slot: SLOT,
      settlementMint: USDC,
    })
    expect(foreign?.status).toBe('revoked')
    expect(foreign?.assetSupported).toBe(false)
  })
})

describe('сховище недосяжне', () => {
  /**
   * Правда про дозвіл лежить у мережі, тож недосяжний кеш може забрати лише
   * прапорець `diverged`, а не саму картку. Знайдено живим прогоном проти
   * devnet: із непіднятою базою ручка віддавала `500` там, де мала віддати
   * стан мережі.
   */
  it('картка віддає стан мережі, а не 500', async () => {
    const res = await card({
      get: async () => onChain(allowance()),
      cached: () => Promise.reject(new Error('connection refused')),
    })

    expect(res.status).toBe(200)
    const body = getAllowanceResponseSchema.parse(await res.json())
    expect(body.status).toBe('active')
    expect(body.diverged).toBe(false)
  })

  /** А от читання мережі впасти може: без нього показувати нічого. */
  it('мережа недосяжна — INTERNAL, збережений стан не підміна', async () => {
    const res = await card({
      get: () => Promise.reject(new Error('rpc timeout')),
      cached: async () => allowanceSchema.parse(allowance()),
    })

    expect(res.status).toBe(500)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('INTERNAL')
  })
})
