import { SECONDS_PER_HOUR } from '@cancelchain/shared'
import type { Address, ReadonlyUint8Array } from '@solana/kit'
import {
  AccountDiscriminator,
  type FixedDelegationArgs,
  getFixedDelegationEncoder,
  getRecurringDelegationEncoder,
  getSubscriptionDelegationEncoder,
  type HeaderArgs,
  type RecurringDelegationArgs,
  SUBSCRIPTION_SIZE,
  type SubscriptionDelegationArgs,
} from '@solana/subscriptions'
import { describe, expect, it } from 'vitest'
import {
  DELEGATION_SIZES,
  decodeDelegation,
  MissingPlanError,
  periodSecondsFromChainHours,
  timestampFromChain,
  toAllowance,
  UndecodableAccountError,
  UnsupportedVersionError,
} from './decode.js'

const PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH' as Address
const OWNER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const MERCHANT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
const PAYER = 'SysvarC1ock11111111111111111111111111111111' as Address
const MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' as Address
const AUTHORITY = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq' as Address
const PLAN_PDA = 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe' as Address

/** 2026-09-02T00:00:00Z — той самий якір, що й у моках `apps/web`. */
const NOW = new Date('2026-09-02T00:00:00.000Z')
const NOW_TS = BigInt(Math.floor(NOW.getTime() / 1000))

const CONTEXT = { slot: 412_345_678, syncedAt: NOW.toISOString(), now: NOW }
const PLAN = { pda: PLAN_PDA, mint: MINT }

function header(discriminator: AccountDiscriminator, overrides: Partial<HeaderArgs> = {}) {
  return {
    discriminator,
    version: 1,
    bump: 254,
    delegator: OWNER,
    delegatee: MERCHANT,
    payer: PAYER,
    initId: 9_007_199_254_740_993n,
    ...overrides,
  } satisfies HeaderArgs
}

/**
 * Суми навмисно більші за `Number.MAX_SAFE_INTEGER` і всі різні. Однакові
 * значення сховали б переплутані поля: якби `capAmount` читався з
 * `amountPulledInPeriod`, тест із двома дев'ятками пройшов би.
 */
const FIXED: FixedDelegationArgs = {
  header: header(AccountDiscriminator.FixedDelegation),
  subscriptionAuthority: AUTHORITY,
  mint: MINT,
  amount: 9_007_199_254_740_995n,
  expiryTs: NOW_TS + 86_400n,
}

const RECURRING: RecurringDelegationArgs = {
  header: header(AccountDiscriminator.RecurringDelegation),
  subscriptionAuthority: AUTHORITY,
  mint: MINT,
  currentPeriodStartTs: NOW_TS - 86_400n,
  periodLengthS: 2_592_000n,
  expiryTs: NOW_TS + 31_536_000n,
  amountPerPeriod: 9_007_199_254_740_997n,
  amountPulledInPeriod: 4_500_000n,
}

/** Ненульове значення саме тут означало б «скасовано до цієї дати», не «протермінується». */
const NO_END = 0n

const SUBSCRIPTION: SubscriptionDelegationArgs = {
  header: header(AccountDiscriminator.SubscriptionDelegation),
  terms: { amount: 11_500_000n, periodHours: 720n, createdAt: NOW_TS - 172_800n },
  amountPulledInPeriod: 1n,
  currentPeriodStartTs: NOW_TS - 86_400n,
  expiresAtTs: NO_END,
}

const encodeFixed = (args: FixedDelegationArgs) => getFixedDelegationEncoder().encode(args)
const encodeRecurring = (args: RecurringDelegationArgs) =>
  getRecurringDelegationEncoder().encode(args)
const encodeSubscription = (args: SubscriptionDelegationArgs) =>
  getSubscriptionDelegationEncoder().encode(args)

function truncate(data: ReadonlyUint8Array, length: number): ReadonlyUint8Array {
  return (data as Uint8Array).slice(0, length)
}

describe('розміри акаунтів', () => {
  it('беруться з кодеків і збігаються з константою SDK', () => {
    expect(DELEGATION_SIZES.subscription).toBe(SUBSCRIPTION_SIZE)
  })

  it('зафіксовані: заголовок 107 байтів плюс тіло', () => {
    expect(DELEGATION_SIZES.fixed).toBe(187)
    expect(DELEGATION_SIZES.recurring).toBe(211)
    expect(DELEGATION_SIZES.subscription).toBe(155)
  })
})

describe('round-trip: закодував → декодував → рівність', () => {
  it('fixed', () => {
    const decoded = decodeDelegation(PDA, encodeFixed(FIXED))
    expect(decoded.kind).toBe('fixed')
    if (decoded.kind !== 'fixed') return
    expect(decoded.data).toEqual(FIXED)
  })

  it('recurring', () => {
    const decoded = decodeDelegation(PDA, encodeRecurring(RECURRING))
    expect(decoded.kind).toBe('recurring')
    if (decoded.kind !== 'recurring') return
    expect(decoded.data).toEqual(RECURRING)
  })

  it('subscription', () => {
    const decoded = decodeDelegation(PDA, encodeSubscription(SUBSCRIPTION))
    expect(decoded.kind).toBe('subscription')
    if (decoded.kind !== 'subscription') return
    expect(decoded.data).toEqual(SUBSCRIPTION)
  })

  /**
   * Правило проєкту: round-trip перевіряється **включно з незаповненими
   * полями**. Кодувальник мовчки пише нуль у пропущене поле, і саме цей нуль
   * має пережити подорож туди-назад і не перетворитися ані на 1970 рік, ані
   * на «значення задане».
   */
  it('нулі в незаповнених полях виживають, а не зникають', () => {
    const empty: RecurringDelegationArgs = {
      ...RECURRING,
      currentPeriodStartTs: 0n,
      expiryTs: 0n,
      amountPulledInPeriod: 0n,
    }
    const decoded = decodeDelegation(PDA, encodeRecurring(empty))
    expect(decoded.kind).toBe('recurring')
    if (decoded.kind !== 'recurring') return
    expect(decoded.data.currentPeriodStartTs).toBe(0n)
    expect(decoded.data.expiryTs).toBe(0n)
    expect(decoded.data.amountPulledInPeriod).toBe(0n)
  })

  it('суми понад 2^53 не втрачають молодших розрядів', () => {
    const decoded = decodeDelegation(PDA, encodeRecurring(RECURRING))
    if (decoded.kind !== 'recurring') throw new Error('unreachable')
    expect(decoded.data.amountPerPeriod).toBe(9_007_199_254_740_997n)
  })

  it('заголовок читається цілком, включно з i64 initId', () => {
    const decoded = decodeDelegation(PDA, encodeFixed(FIXED))
    if (decoded.kind !== 'fixed') throw new Error('unreachable')
    expect(decoded.data.header).toEqual(FIXED.header)
    expect(decoded.version).toBe(1)
  })
})

describe('акаунти, які прочитати не вдалося', () => {
  it('порожні дані — reason "empty", без винятку', () => {
    const decoded = decodeDelegation(PDA, new Uint8Array(0))
    expect(decoded).toEqual({ kind: 'unknown', address: PDA, discriminator: null, reason: 'empty' })
  })

  it.each([
    ['SubscriptionAuthority', AccountDiscriminator.SubscriptionAuthority],
    ['Plan', AccountDiscriminator.Plan],
    ['нічий код 9', 9],
  ])('чужий акаунт (%s) — reason "discriminator"', (_name, discriminator) => {
    const data = new Uint8Array(DELEGATION_SIZES.recurring)
    data[0] = discriminator
    const decoded = decodeDelegation(PDA, data)
    expect(decoded).toMatchObject({ kind: 'unknown', discriminator, reason: 'discriminator' })
  })

  it('обрізаний акаунт — reason "length", а не правдоподібне сміття', () => {
    const decoded = decodeDelegation(PDA, truncate(encodeRecurring(RECURRING), 120))
    expect(decoded).toMatchObject({ kind: 'unknown', reason: 'length' })
  })

  /**
   * Дискримінатор і довжина мають зійтися обидва. Байти фіксованого дозволу з
   * підміненим першим байтом — це рівно та підміна, після якої поля читалися б
   * зі зсувом і давали правдоподібні числа не з тих місць.
   */
  it('дискримінатор не з того типу ловиться довжиною', () => {
    const data = (encodeFixed(FIXED) as Uint8Array).slice()
    data[0] = AccountDiscriminator.RecurringDelegation
    expect(decodeDelegation(PDA, data)).toMatchObject({ kind: 'unknown', reason: 'length' })
  })

  it('toAllowance на нечитабельному акаунті кидає названу помилку', () => {
    const decoded = decodeDelegation(PDA, new Uint8Array(0))
    expect(() => toAllowance(decoded, CONTEXT)).toThrow(UndecodableAccountError)
  })
})

describe('версія акаунта', () => {
  it('чужа версія читається, але в Allowance не перетворюється', () => {
    const args: FixedDelegationArgs = {
      ...FIXED,
      header: header(AccountDiscriminator.FixedDelegation, { version: 2 }),
    }
    const decoded = decodeDelegation(PDA, encodeFixed(args))
    expect(decoded.kind).toBe('fixed')
    expect(decoded.kind !== 'unknown' && decoded.version).toBe(2)
    expect(() => toAllowance(decoded, CONTEXT)).toThrow(UnsupportedVersionError)
  })
})

describe('toAllowance — fixed', () => {
  const allowance = toAllowance(decodeDelegation(PDA, encodeFixed(FIXED)), CONTEXT)

  it('бере власника з delegator, отримувача з delegatee', () => {
    expect(allowance.owner).toBe(OWNER)
    expect(allowance.delegate).toBe(MERCHANT)
  })

  it('стеля — це amount, точним рядком', () => {
    expect(allowance.capAmount).toBe('9007199254740995')
  })

  /** Поля «витрачено» у `FixedDelegation` немає взагалі — нуль тут значить «мережа не зберігає». */
  it('витрачене — нуль, бо акаунт його не містить', () => {
    expect(allowance.spentInPeriod).toBe('0')
  })

  it('періоду немає ані як довжини, ані як початку', () => {
    expect(allowance.periodSeconds).toBeNull()
    expect(allowance.periodStartedAt).toBeNull()
  })

  it('термін дії читається, план і дата закінчення — ні', () => {
    expect(allowance.expiresAt).toBe(new Date(Number(FIXED.expiryTs) * 1000).toISOString())
    expect(allowance.endsAt).toBeNull()
    expect(allowance.planPda).toBeNull()
  })

  it('нульовий термін означає «безстроковий», а не 1970 рік', () => {
    const perpetual = toAllowance(
      decodeDelegation(PDA, encodeFixed({ ...FIXED, expiryTs: 0n })),
      CONTEXT,
    )
    expect(perpetual.expiresAt).toBeNull()
    expect(perpetual.status).toBe('active')
  })

  it('вичерпаний, коли брати вже нічого', () => {
    const spent = toAllowance(decodeDelegation(PDA, encodeFixed({ ...FIXED, amount: 0n })), CONTEXT)
    expect(spent.status).toBe('exhausted')
  })

  it('вичерпаний, коли термін минув', () => {
    const expired = toAllowance(
      decodeDelegation(PDA, encodeFixed({ ...FIXED, expiryTs: NOW_TS - 1n })),
      CONTEXT,
    )
    expect(expired.status).toBe('exhausted')
  })
})

describe('toAllowance — recurring', () => {
  const allowance = toAllowance(decodeDelegation(PDA, encodeRecurring(RECURRING)), CONTEXT)

  it('стеля і витрачене не переплутані місцями', () => {
    expect(allowance.capAmount).toBe('9007199254740997')
    expect(allowance.spentInPeriod).toBe('4500000')
  })

  it('період — секунди прямо з мережі', () => {
    expect(allowance.periodSeconds).toBe(2_592_000)
  })

  it('початок періоду й термін дії читаються', () => {
    expect(allowance.periodStartedAt).toBe(
      new Date(Number(RECURRING.currentPeriodStartTs) * 1000).toISOString(),
    )
    expect(allowance.expiresAt).toBe(new Date(Number(RECURRING.expiryTs) * 1000).toISOString())
  })

  it('плану й дати «не поновлювати» у дозволу поза планом немає', () => {
    expect(allowance.planPda).toBeNull()
    expect(allowance.endsAt).toBeNull()
  })

  it('нульова довжина періоду відхиляється, а не стає нулем секунд', () => {
    const decoded = decodeDelegation(PDA, encodeRecurring({ ...RECURRING, periodLengthS: 0n }))
    expect(() => toAllowance(decoded, CONTEXT)).toThrow(/period length out of range/)
  })
})

describe('toAllowance — subscription', () => {
  const decoded = decodeDelegation(PDA, encodeSubscription(SUBSCRIPTION))

  it('без плану не збирається: у акаунті немає ані міну, ані адреси плану', () => {
    expect(() => toAllowance(decoded, CONTEXT)).toThrow(MissingPlanError)
  })

  it('мін і план беруться з плану, а не вигадуються', () => {
    const allowance = toAllowance(decoded, { ...CONTEXT, plan: PLAN })
    expect(allowance.mint).toBe(MINT)
    expect(allowance.planPda).toBe(PLAN_PDA)
  })

  /** Пастка `PLAN.md`: план рахує годинами, дозвіл — секундами. */
  it('720 годин плану стають 2 592 000 секунд, а не 720', () => {
    const allowance = toAllowance(decoded, { ...CONTEXT, plan: PLAN })
    expect(allowance.periodSeconds).toBe(720 * SECONDS_PER_HOUR)
    expect(allowance.periodSeconds).not.toBe(720)
  })

  it('стеля — сума умов плану, витрачене — з дозволу', () => {
    const allowance = toAllowance(decoded, { ...CONTEXT, plan: PLAN })
    expect(allowance.capAmount).toBe('11500000')
    expect(allowance.spentInPeriod).toBe('1')
  })

  /**
   * `SubscribeData` поля про строк не має взагалі, а `expiresAtTs` заповнює
   * лише `cancelSubscription`. Отже ненульове значення — це «скасовано, діє до»,
   * тобто `endsAt` із `FR-028`, а не «протермінується».
   */
  it('ненульовий expiresAtTs стає endsAt, а expiresAt лишається порожнім', () => {
    const ending = decodeDelegation(
      PDA,
      encodeSubscription({ ...SUBSCRIPTION, expiresAtTs: NOW_TS + 604_800n }),
    )
    const allowance = toAllowance(ending, { ...CONTEXT, plan: PLAN })
    expect(allowance.endsAt).toBe(new Date(Number(NOW_TS + 604_800n) * 1000).toISOString())
    expect(allowance.expiresAt).toBeNull()
    expect(allowance.status).toBe('active')
  })

  it('безстрокова підписка не має дати закінчення', () => {
    const allowance = toAllowance(decoded, { ...CONTEXT, plan: PLAN })
    expect(allowance.endsAt).toBeNull()
  })

  it('після дати закінчення — вичерпана', () => {
    const past = decodeDelegation(
      PDA,
      encodeSubscription({ ...SUBSCRIPTION, expiresAtTs: NOW_TS - 1n }),
    )
    expect(toAllowance(past, { ...CONTEXT, plan: PLAN }).status).toBe('exhausted')
  })
})

describe('статуси, яких декодер не видає ніколи', () => {
  const cases = [
    toAllowance(decodeDelegation(PDA, encodeFixed(FIXED)), CONTEXT),
    toAllowance(decodeDelegation(PDA, encodeRecurring(RECURRING)), CONTEXT),
    toAllowance(decodeDelegation(PDA, encodeSubscription(SUBSCRIPTION)), {
      ...CONTEXT,
      plan: PLAN,
    }),
  ]

  /** Скасований дозвіл — це відсутній акаунт, а не акаунт із прапорцем. */
  it('revoked не виводиться з акаунта', () => {
    for (const allowance of cases) {
      expect(allowance.status).not.toBe('revoked')
    }
  })

  /** Паузи в мережі немає окремо від «скасовано до кінця періоду». */
  it('paused не виводиться з акаунта, і pausedAt завжди порожній', () => {
    for (const allowance of cases) {
      expect(allowance.status).not.toBe('paused')
      expect(allowance.pausedAt).toBeNull()
    }
  })
})

describe('свіжість', () => {
  it('слот і мітка синхронізації беруться з контексту читання', () => {
    const allowance = toAllowance(decodeDelegation(PDA, encodeFixed(FIXED)), CONTEXT)
    expect(allowance.lastSlot).toBe(412_345_678)
    expect(allowance.syncedAt).toBe(NOW.toISOString())
    expect(allowance.pda).toBe(PDA)
  })
})

describe('перетворення окремих величин', () => {
  it('нуль — це «не задано»', () => {
    expect(timestampFromChain(0n)).toBeNull()
  })

  it("від'ємна мітка часу відхиляється", () => {
    expect(() => timestampFromChain(-1n)).toThrow(/cannot be negative/)
  })

  it('мітка часу поза діапазоном дати відхиляється', () => {
    expect(() => timestampFromChain(9_007_199_254_740_993n)).toThrow(/does not fit/)
  })

  it('години плану переводяться в секунди', () => {
    expect(periodSecondsFromChainHours(1n)).toBe(3600)
    expect(periodSecondsFromChainHours(720n)).toBe(2_592_000)
  })

  it('нуль годин відхиляється', () => {
    expect(() => periodSecondsFromChainHours(0n)).toThrow(/out of range/)
  })
})
