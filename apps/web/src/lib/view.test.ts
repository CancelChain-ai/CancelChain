import type { AllowanceDetail, ListedAllowance } from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { PERMISSIONS } from './mockData'
import {
  allowedTotal,
  cardFields,
  detailFromAllowance,
  detailFromPermission,
  everyPeriod,
  formatDay,
  formatMoney,
  formatPeriod,
  nextChargeAt,
  scaleAmount,
  shortDay,
  viewFromAllowance as toView,
  USDC_DECIMALS,
  viewFromPermission,
} from './view'

/**
 * Модель показу — місце, де байти акаунта перетворюються на слова на екрані.
 * Кожна перевірка тут про одне: щоб перетворення нічого не додало від себе.
 */

const PDA = '3amcyam5KhjbWJLAMNPiAwpYPcV1atWSppEZK1ABoWBR'
const OWNER = '4DYhzGx6J2xgJWs7nSCnTXgBdEnoQ9VnKfarJVz2Jj96'
const MERCHANT = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq'
const PLAN = 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const OTHER_MINT = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

const DAY_SECONDS = 86_400
const HOUR_SECONDS = 3_600

/**
 * Момент, відносно якого судиться `periodElapsed`. Тримається явно: інакше
 * половина перевірок нижче почала б падати від того, що настав інший день.
 */
const NOW = new Date('2026-09-02T10:00:00.000Z')

function viewFromAllowance(allowance: ListedAllowance, now = NOW) {
  return toView(allowance, now)
}

function listed(over: Partial<ListedAllowance> = {}): ListedAllowance {
  return {
    pda: PDA,
    owner: OWNER,
    delegate: MERCHANT,
    mint: USDC,
    kind: 'recurring',
    capAmount: '24000000',
    periodSeconds: 30 * DAY_SECONDS,
    spentInPeriod: '12000000',
    periodStartedAt: '2026-08-07T00:00:00.000Z',
    expiresAt: null,
    pausedAt: null,
    endsAt: null,
    status: 'active',
    planPda: null,
    lastSlot: 400_000_000,
    syncedAt: '2026-09-02T10:00:00.000Z',
    assetSupported: true,
    ...over,
  }
}

describe('scaleAmount', () => {
  it('keeps two decimals on a round amount', () => {
    expect(scaleAmount(24_000_000n, USDC_DECIMALS)).toBe('24.00')
    expect(scaleAmount(0n, USDC_DECIMALS)).toBe('0.00')
    expect(scaleAmount(11_500_000n, USDC_DECIMALS)).toBe('11.50')
  })

  it('keeps every significant digit the asset can carry', () => {
    expect(scaleAmount(1_234_567n, USDC_DECIMALS)).toBe('1.234567')
    expect(scaleAmount(1n, USDC_DECIMALS)).toBe('0.000001')
  })

  it('does not lose the low digits of a u64', () => {
    // Через `Number` цей рядок закінчувався б нулями — і стеля дозволу
    // виявилася б іншим числом, ніж у мережі.
    expect(scaleAmount(18_446_744_073_709_551_615n, USDC_DECIMALS)).toBe('18446744073709.551615')
  })

  it('leaves an asset without decimals alone', () => {
    expect(scaleAmount(500n, 0)).toBe('500')
  })
})

describe('formatPeriod', () => {
  it('names the largest unit that divides the period exactly', () => {
    expect(formatPeriod(30 * DAY_SECONDS)).toBe('30 days')
    expect(formatPeriod(DAY_SECONDS)).toBe('1 day')
    // На devnet такий період існує — днями він виглядав би як «0.0416 дня».
    expect(formatPeriod(HOUR_SECONDS)).toBe('1 hour')
    expect(formatPeriod(12 * HOUR_SECONDS)).toBe('12 hours')
    expect(formatPeriod(90 * 60)).toBe('90 minutes')
    expect(formatPeriod(45)).toBe('45 seconds')
  })

  it('does not round a period that fits no whole unit', () => {
    expect(formatPeriod(30 * DAY_SECONDS - 1)).toBe('2591999 seconds')
  })

  it('drops the "1" in the phrase', () => {
    expect(everyPeriod(HOUR_SECONDS)).toBe('every hour')
    expect(everyPeriod(30 * DAY_SECONDS)).toBe('every 30 days')
  })
})

describe('formatMoney', () => {
  it('names the asset when it is the settlement one', () => {
    expect(formatMoney({ amount: 24_000_000n, decimals: USDC_DECIMALS, label: 'USDC' })).toBe(
      '24.00 USDC',
    )
  })

  it('shows an unknown asset in its smallest units, without inventing a scale', () => {
    expect(formatMoney({ amount: 500n, decimals: null, label: 'EtWT…rZBG' })).toBe(
      '500 of EtWT…rZBG',
    )
  })
})

describe('formatDay', () => {
  it('writes the date the way the rest of the screens do', () => {
    expect(formatDay(new Date(2026, 8, 6))).toBe('6 Sep 2026')
    expect(shortDay(new Date(2026, 8, 6))).toBe('6 Sep')
  })
})

describe('nextChargeAt', () => {
  it('is the period start plus the period length', () => {
    const at = nextChargeAt({
      status: 'active',
      periodSeconds: 30 * DAY_SECONDS,
      periodStartedAt: '2026-08-07T00:00:00.000Z',
      endsAt: null,
    })
    expect(at?.toISOString()).toBe('2026-09-06T00:00:00.000Z')
  })

  it('does not exist without a period', () => {
    expect(
      nextChargeAt({ status: 'active', periodSeconds: null, periodStartedAt: null, endsAt: null }),
    ).toBeNull()
  })

  it('does not exist once the allowance is set not to renew', () => {
    expect(
      nextChargeAt({
        status: 'active',
        periodSeconds: 30 * DAY_SECONDS,
        periodStartedAt: '2026-08-07T00:00:00.000Z',
        endsAt: '2026-09-27T00:00:00.000Z',
      }),
    ).toBeNull()
  })

  it('does not exist for an allowance that is not active', () => {
    for (const status of ['revoked', 'exhausted', 'paused'] as const) {
      expect(
        nextChargeAt({
          status,
          periodSeconds: 30 * DAY_SECONDS,
          periodStartedAt: '2026-08-07T00:00:00.000Z',
          endsAt: null,
        }),
      ).toBeNull()
    }
  })
})

describe('viewFromAllowance', () => {
  it('carries the amounts as the smallest units of the settlement asset', () => {
    const view = viewFromAllowance(listed())
    expect(view.cap).toEqual({ amount: 24_000_000n, decimals: USDC_DECIMALS, label: 'USDC' })
    expect(view.used).toEqual({ amount: 12_000_000n, decimals: USDC_DECIMALS, label: 'USDC' })
    expect(view.periodSeconds).toBe(30 * DAY_SECONDS)
    expect(view.nextCharge?.toISOString()).toBe('2026-09-06T00:00:00.000Z')
  })

  it('never invents a merchant name', () => {
    // Ім'я мерчанта в акаунті дозволу не лежить. Порожнє поле честніше за
    // будь-який рядок, який можна було б тут поставити.
    expect(viewFromAllowance(listed()).title).toBeNull()
  })

  it('says the network does not record what a one-off allowance has spent', () => {
    const view = viewFromAllowance(
      listed({
        kind: 'fixed',
        periodSeconds: null,
        periodStartedAt: null,
        spentInPeriod: '0',
        expiresAt: '2026-12-01T00:00:00.000Z',
      }),
    )
    // Саме `null`, а не нуль: нуль читався б як «нічого не витрачено».
    expect(view.used).toBeNull()
    expect(view.periodSeconds).toBeNull()
    expect(view.nextCharge).toBeNull()
    expect(view.expiresOn?.toISOString()).toBe('2026-12-01T00:00:00.000Z')
  })

  it('points a plan subscription at its plan, not at a wallet', () => {
    const view = viewFromAllowance(listed({ kind: 'subscription', delegate: PLAN, planPda: PLAN }))
    expect(view.counterparty).toBe('Gwip…qXBe')
    expect(view.counterpartyLabel).toBe('Merchant plan')
    expect(view.kindLabel).toBe('Plan subscription')
  })

  it('shows an allowance in an unsupported asset without guessing its decimals', () => {
    const view = viewFromAllowance(
      listed({ mint: OTHER_MINT, assetSupported: false, capAmount: '500', spentInPeriod: '500' }),
    )
    expect(view.assetSupported).toBe(false)
    expect(view.cap).toEqual({ amount: 500n, decimals: null, label: 'EtWT…rZBG' })
    expect(formatMoney(view.cap)).toBe('500 of EtWT…rZBG')
  })

  it('separates "set not to renew" from an expiry the user did not choose', () => {
    const ending = viewFromAllowance(
      listed({ kind: 'subscription', planPda: PLAN, endsAt: '2026-09-27T00:00:00.000Z' }),
    )
    expect(ending.endsOn?.toISOString()).toBe('2026-09-27T00:00:00.000Z')
    expect(ending.expiresOn).toBeNull()

    const expiring = viewFromAllowance(listed({ expiresAt: '2026-09-27T00:00:00.000Z' }))
    expect(expiring.endsOn).toBeNull()
    expect(expiring.expiresOn?.toISOString()).toBe('2026-09-27T00:00:00.000Z')
  })
})

describe('a period the network still calls current but which has ended', () => {
  const stale = listed({
    periodSeconds: HOUR_SECONDS,
    periodStartedAt: '2026-05-26T18:28:35.000Z',
    spentInPeriod: '100000',
    capAmount: '100000',
  })

  it('is marked, because the ceiling resets on the next charge and not by the clock', () => {
    const view = viewFromAllowance(stale)
    expect(view.periodElapsed).toBe(true)
    // Витрачене лишається прочитаним як є — воно просто стосується іншого періоду.
    expect(view.used?.amount).toBe(100_000n)
  })

  it('is not marked while the period is still running', () => {
    expect(viewFromAllowance(listed()).periodElapsed).toBe(false)
  })

  it('is judged against the moment passed in, not the wall clock', () => {
    const before = new Date('2026-05-26T18:40:00.000Z')
    expect(viewFromAllowance(stale, before).periodElapsed).toBe(false)
  })

  it('does not apply to an allowance without a period', () => {
    const fixed = listed({ kind: 'fixed', periodSeconds: null, periodStartedAt: null })
    expect(viewFromAllowance(fixed).periodElapsed).toBe(false)
  })
})

describe('allowedTotal', () => {
  it('adds up the ceilings of active allowances in the settlement asset', () => {
    const total = allowedTotal([
      viewFromAllowance(listed({ capAmount: '24000000' })),
      viewFromAllowance(listed({ pda: OWNER, capAmount: '11500000' })),
    ])
    expect(total.amount).toBe(35_500_000n)
    expect(total.count).toBe(2)
    expect(scaleAmount(total.amount, total.decimals)).toBe('35.50')
  })

  it('leaves out an unsupported asset instead of inventing a rate', () => {
    const total = allowedTotal([
      viewFromAllowance(listed({ capAmount: '24000000' })),
      viewFromAllowance(listed({ mint: OTHER_MINT, assetSupported: false, capAmount: '500' })),
    ])
    expect(total.amount).toBe(24_000_000n)
    expect(total.count).toBe(1)
  })

  it('leaves out everything that cannot charge right now', () => {
    const total = allowedTotal([
      viewFromAllowance(listed({ status: 'exhausted' })),
      viewFromAllowance(listed({ status: 'revoked' })),
    ])
    expect(total.amount).toBe(0n)
    expect(total.count).toBe(0)
  })
})

describe('viewFromPermission', () => {
  it('brings the M0 mock to the same model without touching it', () => {
    const before = JSON.stringify(PERMISSIONS)
    const views = PERMISSIONS.map(viewFromPermission)
    expect(views).toHaveLength(PERMISSIONS.length)
    expect(JSON.stringify(PERMISSIONS)).toBe(before)
  })

  it('splits the mock "unsupported" state into a status and an asset', () => {
    const permission = PERMISSIONS.find((p) => p.state === 'unsupported')
    expect(permission).toBeDefined()
    const view = viewFromPermission(permission as (typeof PERMISSIONS)[number])
    // У мережі це незалежні речі: чужий актив буває і в цілком активного дозволу.
    expect(view.status).toBe('active')
    expect(view.assetSupported).toBe(false)
  })

  it('reads the mock display dates back as dates', () => {
    const ending = PERMISSIONS.find((p) => p.state === 'ending')
    const view = viewFromPermission(ending as (typeof PERMISSIONS)[number])
    expect(view.endsOn).toBeInstanceOf(Date)
    expect(formatDay(view.endsOn as Date)).toBe(ending?.endsOn)
    expect(view.nextCharge).toBeNull()
  })

  it('keeps the mock ceilings exact in the smallest units', () => {
    const halcyon = PERMISSIONS.find((p) => p.ceiling === 11.5)
    const view = viewFromPermission(halcyon as (typeof PERMISSIONS)[number])
    expect(view.cap.amount).toBe(11_500_000n)
    expect(formatMoney(view.cap)).toBe('11.50 USDC')
  })
})

/**
 * Картка одного дозволу (`T024`). Перевіряється рівно те, чим вона
 * відрізняється від рядка списку: повні адреси, звірка з мережею і п'ять полів
 * `FR-002`, які мусять бути на екрані **всі** й **разом** (`SC-005`).
 */

type Card = AllowanceDetail & { assetSupported: boolean }

function chainState(over: Partial<NonNullable<Card['chainState']>> = {}) {
  return {
    status: 'active' as const,
    capAmount: '24000000',
    spentInPeriod: '12000000',
    periodStartedAt: '2026-08-07T00:00:00.000Z',
    pausedAt: null,
    endsAt: null,
    slot: 400_000_000,
    ...over,
  }
}

function card(over: Partial<Card> = {}): Card {
  return { ...listed(), chainState: chainState(), diverged: false, ...over }
}

/** Разовий дозвіл: періоду немає, а «витрачено» мережа не зберігає взагалі. */
function oneOff(over: Partial<Card> = {}): Card {
  return card({
    kind: 'fixed',
    periodSeconds: null,
    periodStartedAt: null,
    spentInPeriod: '0',
    capAmount: '11500000',
    chainState: chainState({ periodStartedAt: null, spentInPeriod: '0', capAmount: '11500000' }),
    ...over,
  })
}

function fieldsOf(detail: ReturnType<typeof detailFromAllowance>) {
  return Object.fromEntries(cardFields(detail).map((field) => [field.key, field]))
}

describe('detailFromAllowance', () => {
  it('keeps the addresses whole, where the list shortens them', () => {
    const detail = detailFromAllowance(card(), NOW)
    // Скорочене лишається для заголовка, повне — для звірки.
    expect(detail.counterparty).not.toBe(MERCHANT)
    expect(detail.counterpartyAddress).toBe(MERCHANT)
    expect(detail.address).toBe(PDA)
    expect(detail.ownerAddress).toBe(OWNER)
    expect(detail.mintAddress).toBe(USDC)
  })

  it('points a plan subscription at its plan, not at the merchant wallet', () => {
    const detail = detailFromAllowance(
      card({ kind: 'subscription', planPda: PLAN, expiresAt: null }),
      NOW,
    )
    expect(detail.counterpartyAddress).toBe(PLAN)
    expect(detail.counterpartyLabel).toBe('Merchant plan')
  })

  it('judges the period by the moment the state was read, not by the clock now', () => {
    // Без другого аргументу відліком є `syncedAt` відповіді: картка, яка
    // пролежала на екрані, не має судити прочитане іншим годинником.
    const detail = detailFromAllowance(
      card({ syncedAt: '2026-08-20T10:00:00.000Z', periodSeconds: 30 * DAY_SECONDS }),
    )
    expect(detail.periodElapsed).toBe(false)
    expect(detail.syncedAt.toISOString()).toBe('2026-08-20T10:00:00.000Z')
  })

  it('says the account is gone from the network instead of hiding it', () => {
    const detail = detailFromAllowance(
      card({ chainState: null, status: 'revoked', diverged: true }),
      NOW,
    )
    expect(detail.networkState).toBe('absent')
    expect(detail.diverged).toBe(true)
    expect(detail.slot).toBe(400_000_000)
  })

  it('has no activity feed yet — and null is not an empty history', () => {
    expect(detailFromAllowance(card(), NOW).activity).toBeNull()
  })
})

describe('detailFromPermission', () => {
  it('brings the demo feed with it and says there is no network behind it', () => {
    const permission = PERMISSIONS[0]
    expect(permission).toBeDefined()
    const detail = detailFromPermission(permission as (typeof PERMISSIONS)[number])

    expect(detail.networkState).toBe('none')
    expect(detail.slot).toBeNull()
    expect(detail.address).toBeNull()
    expect(detail.activity).not.toBeNull()
    expect(detail.activity?.length).toBe(
      (permission as (typeof PERMISSIONS)[number]).detail.activity.length,
    )
  })
})

describe('the five fields of FR-002 (SC-005)', () => {
  it('gives five fields, always, in the same order', () => {
    for (const input of [card(), oneOff(), card({ status: 'revoked', chainState: null })]) {
      const fields = cardFields(detailFromAllowance(input, NOW))
      expect(fields).toHaveLength(5)
      expect(fields.map((field) => field.key)).toEqual([
        'recipient',
        'cap',
        'period',
        'used',
        'nextCharge',
      ])
    }
  })

  it('shows the recipient in full, and says what that address is', () => {
    const fields = fieldsOf(detailFromAllowance(card(), NOW))
    expect(fields.recipient?.value).toBe(MERCHANT)
    expect(fields.recipient?.note).toBe('Merchant wallet')
  })

  it('says a one-off permission spends an unknown amount — not zero', () => {
    const fields = fieldsOf(detailFromAllowance(oneOff(), NOW))
    expect(fields.used?.known).toBe(false)
    expect(fields.used?.value).toBe('The network does not record it')
    expect(fields.used?.value).not.toContain('0')
    expect(fields.used?.note).toContain('unknown, not zero')
  })

  it('calls the ceiling of a one-off permission what is left of it', () => {
    const fields = fieldsOf(detailFromAllowance(oneOff(), NOW))
    expect(fields.cap?.label).toBe('Ceiling — what is left')
    expect(fields.cap?.value).toBe('11.50 USDC')
    expect(fields.period?.value).toBe('One-off — no period')
    // Разовий дозвіл можуть списати будь-якої миті — «не заплановано» тут
    // читалося б як «нічого не станеться».
    expect(fields.nextCharge?.value).toBe('Any time')
  })

  it('keeps the period in the unit that divides it whole', () => {
    const hourly = card({ periodSeconds: HOUR_SECONDS })
    expect(fieldsOf(detailFromAllowance(hourly, NOW)).period?.value).toBe('1 hour')
    expect(fieldsOf(detailFromAllowance(card(), NOW)).period?.value).toBe('30 days')
  })

  it('does not promise a date for a permission that is already cancelled', () => {
    const fields = fieldsOf(detailFromAllowance(card({ status: 'revoked', chainState: null }), NOW))
    expect(fields.nextCharge?.value).toBe('Never — this permission is cancelled')
  })

  it('says "any time now" for a period the network still calls current', () => {
    // Стеля скидається списанням, а не за годинником: дата в минулому означає
    // «будь-якої миті», а не «прострочено».
    const stale = card({
      periodStartedAt: '2026-06-01T00:00:00.000Z',
      chainState: chainState({ periodStartedAt: '2026-06-01T00:00:00.000Z' }),
    })
    const fields = fieldsOf(detailFromAllowance(stale, NOW))
    expect(fields.nextCharge?.value).toBe('Any time now')
    expect(fields.period?.note).toContain('has already ended')
    expect(fields.used?.note).toContain('already ended')
  })

  it('names the end date instead of a next charge when it will not renew', () => {
    const ending = card({
      kind: 'subscription',
      planPda: PLAN,
      endsAt: '2026-10-01T00:00:00.000Z',
      chainState: chainState({ endsAt: '2026-10-01T00:00:00.000Z' }),
    })
    const fields = fieldsOf(detailFromAllowance(ending, NOW))
    expect(fields.nextCharge?.value).toContain('1 Oct 2026')
    expect(fields.nextCharge?.note).toContain('will not renew')
  })

  it('schedules nothing while a subscription is paused', () => {
    const paused = card({
      kind: 'subscription',
      planPda: PLAN,
      status: 'paused',
      pausedAt: '2026-08-20T00:00:00.000Z',
    })
    expect(fieldsOf(detailFromAllowance(paused, NOW)).nextCharge?.value).toBe(
      'Nothing scheduled — it is paused',
    )
  })

  it('shows a foreign asset in smallest units and says why', () => {
    const foreign = card({ mint: OTHER_MINT, assetSupported: false, capAmount: '500' })
    const fields = fieldsOf(detailFromAllowance(foreign, NOW))
    expect(fields.cap?.value).toContain('500 of ')
    expect(fields.cap?.note).toContain('does not know its decimals')
  })

  it('gives the next charge a time, and says the network does not store it', () => {
    const fields = fieldsOf(detailFromAllowance(card(), NOW))
    expect(fields.nextCharge?.value).toContain('6 Sep 2026')
    expect(fields.nextCharge?.note).toContain('does not store this date')
  })

  it('explains a permission that cannot charge again', () => {
    const spent = oneOff({ status: 'exhausted', capAmount: '0', chainState: null })
    const fields = fieldsOf(detailFromAllowance(spent, NOW))
    expect(fields.nextCharge?.value).toBe('Never')
    expect(fields.nextCharge?.note).toContain('Nothing is left')
  })
})
