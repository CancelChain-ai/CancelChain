import { U64_MAX } from '@cancelchain/shared'
import type { Address, Blockhash, Instruction } from '@solana/kit'
import { createNoopSigner } from '@solana/kit'
import {
  identifySubscriptionsInstruction,
  parseCreateFixedDelegationInstruction,
  parseCreateRecurringDelegationInstruction,
  parseInitSubscriptionAuthorityInstruction,
  SubscriptionsInstruction,
  UNKNOWN_INIT_ID,
} from '@solana/subscriptions'
import { describe, expect, it } from 'vitest'
import { PROGRAM_ADDRESS } from './client.js'
import { timestampFromChain } from './decode.js'
import {
  buildGrantInstruction,
  buildGrantTransaction,
  buildInitAuthorityInstruction,
  findGrantedAllowance,
  GrantAmountError,
  type GrantBounds,
  GrantExpiryError,
  GrantInitIdMismatchError,
  GrantNonceError,
  GrantPeriodError,
  timestampToChain,
} from './grant.js'
import { findSubscriptionAuthority } from './pda.js'

const OWNER = '4DYhzGx6zWLmFDCBLJfCyRpTBnJnbfLqzHz7BvUJBFHU' as Address
const MERCHANT = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq' as Address
const SPONSOR = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' as Address
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const USER_ATA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH' as Address
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address

const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' as Blockhash
const LIFETIME = { blockhash: BLOCKHASH, lastValidBlockHeight: 492_096_495n }

const NOW = new Date('2026-09-02T12:00:00.000Z')
const NEXT_MONTH = '2026-10-02T12:00:00.000Z'
const NEXT_WEEK = '2026-09-09T12:00:00.000Z'

const CAP = 25_000_000n
const NONCE = 7n
const INIT_ID = 4_211_337n

const delegator = createNoopSigner(OWNER)
const sponsor = createNoopSigner(SPONSOR)

const FIXED: GrantBounds = {
  capAmount: CAP,
  delegatee: MERCHANT,
  expiresAt: NEXT_MONTH,
  kind: 'fixed',
}

const RECURRING: GrantBounds = {
  capAmount: CAP,
  delegatee: MERCHANT,
  expiresAt: NEXT_MONTH,
  kind: 'recurring',
  periodSeconds: 2_592_000,
  startsAt: NEXT_WEEK,
}

type Parsable = Parameters<typeof parseCreateFixedDelegationInstruction>[0]

function parsable(instruction: Instruction): Parsable {
  if (!('accounts' in instruction) || instruction.accounts === undefined) {
    throw new Error('instruction carries no accounts')
  }
  if (!('data' in instruction) || instruction.data === undefined) {
    throw new Error('instruction carries no data')
  }
  return instruction as Parsable
}

const grant = (
  bounds: GrantBounds,
  extra: Partial<Parameters<typeof buildGrantInstruction>[0]> = {},
) =>
  buildGrantInstruction({
    authorityInitId: INIT_ID,
    bounds,
    delegator,
    nonce: NONCE,
    now: NOW,
    tokenMint: MINT,
    ...extra,
  })

describe('вибір інструкції', () => {
  it('кожен тип меж — своя інструкція програми', async () => {
    expect(identifySubscriptionsInstruction(parsable(await grant(FIXED)))).toBe(
      SubscriptionsInstruction.CreateFixedDelegation,
    )
    expect(identifySubscriptionsInstruction(parsable(await grant(RECURRING)))).toBe(
      SubscriptionsInstruction.CreateRecurringDelegation,
    )
  })

  it('адреса програми — наша, і береться з SDK', async () => {
    expect((await grant(FIXED)).programAddress).toBe(PROGRAM_ADDRESS)
  })
})

describe('round-trip: закодував → декодував → рівність', () => {
  it('fixed: усі межі повертаються тими самими', async () => {
    const parsed = parseCreateFixedDelegationInstruction(parsable(await grant(FIXED)))
    expect(parsed.data.fixedDelegation).toEqual({
      amount: CAP,
      expectedSubscriptionAuthorityInitId: INIT_ID,
      expiryTs: timestampToChain(NEXT_MONTH),
      nonce: NONCE,
    })
  })

  it('recurring: період і початок теж повертаються тими самими', async () => {
    const parsed = parseCreateRecurringDelegationInstruction(parsable(await grant(RECURRING)))
    expect(parsed.data.recurringDelegation).toEqual({
      amountPerPeriod: CAP,
      expectedSubscriptionAuthorityInitId: INIT_ID,
      expiryTs: timestampToChain(NEXT_MONTH),
      nonce: NONCE,
      periodLengthS: 2_592_000n,
      startTs: timestampToChain(NEXT_WEEK),
    })
  })

  it('дата, показана людині, і дата в мережі — та сама дата', async () => {
    // Пара `timestampToChain` / `timestampFromChain` мусить бути взаємно
    // зворотною: інакше на екрані одне число, в акаунті інше.
    for (const iso of [NEXT_MONTH, NEXT_WEEK, '2030-01-01T00:00:00.000Z']) {
      expect(timestampFromChain(timestampToChain(iso))).toBe(iso)
    }
    expect(timestampToChain(null)).toBe(0n)
    expect(timestampFromChain(0n)).toBeNull()
  })

  it('акаунти інструкції — саме ті, що деривуються з меж', async () => {
    const parsed = parseCreateFixedDelegationInstruction(parsable(await grant(FIXED)))
    const authority = await findSubscriptionAuthority({ tokenMint: MINT, user: OWNER })
    const pda = await findGrantedAllowance({
      delegatee: MERCHANT,
      delegator: OWNER,
      nonce: NONCE,
      tokenMint: MINT,
    })
    expect(parsed.accounts.delegator.address).toBe(OWNER)
    expect(parsed.accounts.subscriptionAuthority.address).toBe(authority.address)
    expect(parsed.accounts.delegationAccount.address).toBe(pda.address)
    expect(parsed.accounts.delegatee.address).toBe(MERCHANT)
  })
})

describe('незаповнені поля', () => {
  it('«без дати закінчення» їде нулем — і нуль означає саме це', async () => {
    const parsed = parseCreateFixedDelegationInstruction(
      parsable(await grant({ ...FIXED, expiresAt: null })),
    )
    expect(parsed.data.fixedDelegation.expiryTs).toBe(0n)
    // Не 1970 рік: зворотне перетворення повертає «не задано».
    expect(timestampFromChain(parsed.data.fixedDelegation.expiryTs)).toBeNull()
  })

  it('«почати щойно сяде» їде нулем, і дата закінчення при цьому обов’язкова', async () => {
    const parsed = parseCreateRecurringDelegationInstruction(
      parsable(await grant({ ...RECURRING, startsAt: null })),
    )
    expect(parsed.data.recurringDelegation.startTs).toBe(0n)
    expect(parsed.data.recurringDelegation.expiryTs).not.toBe(0n)
  })

  it('спонсора немає — акаунта спонсора в інструкції теж немає', async () => {
    const parsed = parseCreateFixedDelegationInstruction(parsable(await grant(FIXED)))
    expect(parsed.accounts.payer).toBeUndefined()
  })

  it('спонсор заданий — він у інструкції, і це видно', async () => {
    const parsed = parseCreateFixedDelegationInstruction(
      parsable(await grant(FIXED, { payer: sponsor })),
    )
    expect(parsed.accounts.payer?.address).toBe(SPONSOR)
  })
})

describe('сторож несвіжості авторитету', () => {
  it('відомий initId їде в інструкцію як є', async () => {
    const parsed = parseCreateFixedDelegationInstruction(parsable(await grant(FIXED)))
    expect(parsed.data.fixedDelegation.expectedSubscriptionAuthorityInitId).toBe(INIT_ID)
  })

  it('«у цій самій транзакції» — це сентинел SDK, а не вигадане нами число', async () => {
    const parsed = parseCreateFixedDelegationInstruction(
      parsable(await grant(FIXED, { authorityInitId: 'same-transaction' })),
    )
    expect(parsed.data.fixedDelegation.expectedSubscriptionAuthorityInitId).toBe(UNKNOWN_INIT_ID)
  })
})

describe('межі перевіряються до підпису', () => {
  it('нульова або від’ємна стеля не проходить', async () => {
    await expect(grant({ ...FIXED, capAmount: 0n })).rejects.toThrow(GrantAmountError)
    await expect(grant({ ...FIXED, capAmount: -1n })).rejects.toThrow(GrantAmountError)
    await expect(grant({ ...FIXED, capAmount: U64_MAX + 1n })).rejects.toThrow(GrantAmountError)
  })

  it('період мусить бути цілим додатним', async () => {
    await expect(grant({ ...RECURRING, periodSeconds: 0 })).rejects.toThrow(GrantPeriodError)
    await expect(grant({ ...RECURRING, periodSeconds: 1.5 })).rejects.toThrow(GrantPeriodError)
  })

  it('дата закінчення в минулому не проходить', async () => {
    await expect(grant({ ...FIXED, expiresAt: '2026-08-01T00:00:00.000Z' })).rejects.toThrow(
      GrantExpiryError,
    )
  })

  it('«почати щойно сяде» без дати закінчення не проходить — це правило програми', async () => {
    await expect(grant({ ...RECURRING, expiresAt: null, startsAt: null })).rejects.toThrow(
      /RecurringDelegationStartOnLandingRequiresExpiry/,
    )
  })

  it('початок не раніше кінця не проходить', async () => {
    await expect(
      grant({ ...RECURRING, expiresAt: NEXT_WEEK, startsAt: NEXT_MONTH }),
    ).rejects.toThrow(GrantExpiryError)
  })

  it('nonce поза u64 не проходить', async () => {
    await expect(grant(FIXED, { nonce: U64_MAX + 1n })).rejects.toThrow(GrantNonceError)
  })

  it('епоха як дата — не «не задано», а помилка', () => {
    expect(() => timestampToChain('1970-01-01T00:00:00.000Z')).toThrow(RangeError)
    expect(() => timestampToChain('не дата')).toThrow(RangeError)
  })
})

describe('транзакція видачі', () => {
  const transaction = (extra: Partial<Parameters<typeof buildGrantTransaction>[0]> = {}) =>
    buildGrantTransaction({
      authorityInitId: INIT_ID,
      bounds: FIXED,
      delegator,
      lifetime: LIFETIME,
      nonce: NONCE,
      now: NOW,
      tokenMint: MINT,
      ...extra,
    })

  const initAuthority = { tokenProgram: TOKEN_PROGRAM, userAta: USER_ATA }

  it('без ініціалізації авторитету — рівно одна інструкція', async () => {
    const built = await transaction()
    expect(built.message.instructions).toHaveLength(1)
    expect(built.message.feePayer.address).toBe(OWNER)
  })

  it('перша видача — дві інструкції, і авторитет іде першим', async () => {
    const built = await transaction({ authorityInitId: 'same-transaction', initAuthority })
    expect(built.message.instructions).toHaveLength(2)
    const [first, second] = built.message.instructions
    if (first === undefined || second === undefined) throw new Error('instructions went missing')
    expect(identifySubscriptionsInstruction(parsable(first))).toBe(
      SubscriptionsInstruction.InitSubscriptionAuthority,
    )
    expect(identifySubscriptionsInstruction(parsable(second))).toBe(
      SubscriptionsInstruction.CreateFixedDelegation,
    )
  })

  it('сторож не вимикається без причини', async () => {
    // 'same-transaction' без ініціалізації — вимкнений сторож задарма.
    await expect(transaction({ authorityInitId: 'same-transaction' })).rejects.toThrow(
      GrantInitIdMismatchError,
    )
    // Ініціалізація з конкретним initId — очікування того, чого ще немає.
    await expect(transaction({ initAuthority })).rejects.toThrow(GrantInitIdMismatchError)
  })

  it('спонсор платить комісію, коли він є', async () => {
    const built = await transaction({ payer: sponsor })
    expect(built.message.feePayer.address).toBe(SPONSOR)
  })
})

describe('buildInitAuthorityInstruction', () => {
  it('кладе токен-акаунт власника й токен-програму міну', async () => {
    const parsed = parseInitSubscriptionAuthorityInstruction(
      parsable(
        await buildInitAuthorityInstruction({
          owner: delegator,
          tokenMint: MINT,
          tokenProgram: TOKEN_PROGRAM,
          userAta: USER_ATA,
        }),
      ),
    )
    expect(parsed.accounts.owner.address).toBe(OWNER)
    expect(parsed.accounts.tokenMint.address).toBe(MINT)
    expect(parsed.accounts.tokenProgram.address).toBe(TOKEN_PROGRAM)
    expect(parsed.accounts.userAta.address).toBe(USER_ATA)
  })
})
