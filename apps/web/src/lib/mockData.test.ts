import { describe, expect, it } from 'vitest'
import {
  allowedTotal,
  CHARGE_ATTEMPTS,
  DEMO_TODAY,
  formatAmount,
  MERCHANT,
  PERMISSIONS,
  type Permission,
  SUBSCRIBE_GRANT,
  SUBSCRIBE_OFFER,
} from './mockData'

/**
 * Моки на екрані читаються як факти, тож розійтися між собою вони не мають права:
 * порожня смужка згоди поруч зі списанням у тому ж періоді або стрічка глибша за
 * власний підпис — це не косметика, а неправда, сказана з екрана.
 *
 * Правила описані в шапці `mockData.ts`. Тут вони перевіряються.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const DAY_MS = 86_400_000

/** '6 Sep 2026' → Date. Кидає на будь-якому іншому написанні. */
function parseDate(value: string): Date {
  const match = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(value)
  if (!match) throw new Error(`not a display date: ${value}`)
  const [, day, month, year] = match
  const monthIndex = MONTHS.indexOf(month as string)
  if (monthIndex < 0) throw new Error(`unknown month: ${month}`)
  return new Date(Date.UTC(Number(year), monthIndex, Number(day)))
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS)
}

const today = parseDate(DEMO_TODAY)

/** Кожна картка, включно з тією, що з'являється після «Allow this». */
const everyPermission: Permission[] = [...PERMISSIONS, SUBSCRIBE_GRANT]

/** Дата, після якої період вважається поточним. */
function periodStart(permission: Permission): Date {
  return parseDate(permission.detail.periodStarted)
}

function charges(permission: Permission) {
  return permission.detail.activity
    .filter((event) => event.description === 'Charged')
    .map((event) => ({ at: parseDate(event.date), amount: event.amount ?? 0 }))
    .sort((a, b) => b.at.getTime() - a.at.getTime())
}

describe.each(everyPermission.map((p) => [p.merchant, p] as const))('%s', (_name, permission) => {
  it('ends its period exactly one period after it started', () => {
    const boundary = permission.nextCharge ?? permission.nextChargeOnResume ?? permission.endsOn
    expect(boundary, 'a live permission must say when its period ends').toBeDefined()
    expect(daysBetween(periodStart(permission), parseDate(boundary as string))).toBe(
      permission.periodDays,
    )
  })

  it('charges one period apart', () => {
    const dates = charges(permission)
    for (let i = 0; i + 1 < dates.length; i += 1) {
      const [newer, older] = [dates[i], dates[i + 1]]
      if (!newer || !older) continue
      expect(daysBetween(older.at, newer.at)).toBe(permission.periodDays)
    }
  })

  it('spends this period exactly what the charges in it add up to', () => {
    const start = periodStart(permission)
    const spent = charges(permission)
      .filter((charge) => charge.at.getTime() >= start.getTime())
      .reduce((sum, charge) => sum + charge.amount, 0)
    expect(spent).toBeCloseTo(permission.usedThisPeriod, 6)
  })

  it('never spends past its own ceiling', () => {
    expect(permission.usedThisPeriod).toBeLessThanOrEqual(permission.ceiling)
  })

  it('keeps its feed inside the ninety days the screen promises', () => {
    // Підпис під стрічкою каже «Showing the last 90 days». Подія, старша за це,
    // робить напис неправдою — рівно те, проти чого FR-029 і SC-013.
    expect(permission.detail.activity.length).toBeGreaterThan(0)
    for (const event of permission.detail.activity) {
      const age = daysBetween(parseDate(event.date), today)
      expect(age, `${event.date} — ${event.description}`).toBeLessThanOrEqual(90)
      expect(age, `${event.date} is in the future`).toBeGreaterThanOrEqual(0)
    }
  })

  it('lists its feed newest first', () => {
    const dates = permission.detail.activity.map((event) => parseDate(event.date).getTime())
    expect([...dates].sort((a, b) => b - a)).toEqual(dates)
  })

  it('was given no later than the period it is in', () => {
    expect(parseDate(permission.detail.givenOn).getTime()).toBeLessThanOrEqual(
      periodStart(permission).getTime(),
    )
  })

  it('offers pause and a scheduled end only through a plan', () => {
    if (permission.viaPlan) {
      expect(permission.planName, 'a plan permission names its plan').toBeTruthy()
    } else {
      expect(permission.planName).toBeUndefined()
      expect(permission.endsOn, 'FR-028 is plan-only').toBeUndefined()
      expect(permission.nextChargeOnResume, 'FR-011 is plan-only').toBeUndefined()
      expect(permission.state).not.toBe('paused')
      expect(permission.state).not.toBe('ending')
    }
  })

  it('says nothing about a next charge while paused or ending', () => {
    if (permission.state === 'paused') {
      expect(permission.nextCharge).toBeNull()
      expect(permission.nextChargeOnResume).toBeTruthy()
    }
    if (permission.state === 'ending') {
      expect(permission.nextCharge).toBeNull()
      expect(permission.endsOn).toBeTruthy()
    }
  })
})

describe('the header total', () => {
  it('is the sum of the active ceilings, never a typed-in number', () => {
    const total = allowedTotal(PERMISSIONS)
    expect(total.amount).toBeCloseTo(104.5, 6)
    expect(total.count).toBe(6)
    expect(formatAmount(total.amount, 'USDC')).toBe('104.50 USDC')
  })

  it('counts neither the paused one nor the one in an asset we do not manage', () => {
    const counted = PERMISSIONS.filter(
      (p) => p.asset === 'USDC' && (p.state === 'active' || p.state === 'ending'),
    )
    expect(counted.map((p) => p.merchant)).not.toContain('Grainfield Coffee')
    expect(counted.map((p) => p.merchant)).not.toContain('Copperline Games')
  })

  it('moves on its own when the subscribe screen grants a permission', () => {
    const after = allowedTotal([SUBSCRIBE_GRANT, ...PERMISSIONS])
    expect(after.amount).toBeCloseTo(113.5, 6)
    expect(after.count).toBe(7)
  })
})

describe('the subscribe offer', () => {
  it('is a merchant the wallet has not already allowed', () => {
    expect(PERMISSIONS.map((p) => p.merchant)).not.toContain(SUBSCRIBE_OFFER.merchant)
  })

  it('grants exactly what it showed before the signature', () => {
    expect(SUBSCRIBE_GRANT.merchant).toBe(SUBSCRIBE_OFFER.merchant)
    expect(SUBSCRIBE_GRANT.ceiling).toBe(SUBSCRIBE_OFFER.ceiling)
    expect(SUBSCRIBE_GRANT.periodDays).toBe(SUBSCRIBE_OFFER.periodDays)
    expect(SUBSCRIBE_GRANT.recipient).toBe(SUBSCRIBE_OFFER.recipient)
    expect(SUBSCRIBE_GRANT.usedThisPeriod).toBe(0)
  })
})

describe('the merchant panel', () => {
  it('derives the expected revenue from the plan and the count', () => {
    expect(MERCHANT.expectedThisPeriod).toBeCloseTo(
      MERCHANT.activePermissions * MERCHANT.plan.ceiling,
      6,
    )
  })

  it('gives every rejection a reason in plain words, never a code', () => {
    for (const attempt of CHARGE_ATTEMPTS.filter((a) => a.rejected)) {
      expect(attempt.result).toMatch(/^Rejected — .+/)
      expect(attempt.result).not.toMatch(/error|unknown|0x|code/i)
      expect(attempt.amount).toBeNull()
    }
  })
})

describe('what the demo may not claim', () => {
  // Демо, у якому підписка справжньої компанії показана як керована звідси,
  // робить неправдиве твердження про цю компанію.
  const REAL_COMPANIES = [
    'netflix',
    'spotify',
    'notion',
    'adobe',
    'apple',
    'google',
    'amazon',
    'microsoft',
    'dropbox',
    'github',
    'figma',
    'slack',
    'zoom',
    'disney',
    'hulu',
    'patreon',
    'substack',
    'openai',
    'anthropic',
    'uber',
    'stripe',
  ]

  it('names no real company anywhere on screen', () => {
    const text = [
      ...everyPermission.map((p) => `${p.merchant} ${p.planName ?? ''}`),
      MERCHANT.name,
      MERCHANT.plan.name,
      MERCHANT.plan.link,
      SUBSCRIBE_OFFER.merchant,
      SUBSCRIBE_OFFER.plan,
    ]
      .join(' ')
      .toLowerCase()

    for (const company of REAL_COMPANIES) {
      expect(text, company).not.toContain(company)
    }
  })

  it('shows no fiat symbol — every amount names its asset', () => {
    for (const permission of everyPermission) {
      const shown = formatAmount(permission.ceiling, permission.asset)
      expect(shown).not.toMatch(/[$€£]/)
      expect(shown).toContain(permission.asset)
    }
  })
})
