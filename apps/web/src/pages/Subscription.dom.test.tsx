// @vitest-environment jsdom
import type { AllowanceDetail } from '@cancelchain/shared'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERMISSIONS } from '../lib/mockData'
import type { AllowanceState } from '../lib/useAllowance'
import { detailFromAllowance, detailFromPermission } from '../lib/view'
import Subscription from './Subscription'

/**
 * Екран картки (`T024`). Перевіряється не верстка, а те, що на екрані є всі
 * п'ять полів `FR-002` одночасно (`SC-005`) і що жодне з них не вигадує
 * значення, якого немає: «витрачено» разового дозволу мережа не зберігає, і
 * нуль на цьому місці був би твердженням про чужі гроші.
 */

const PDA = '3amcyam5KhjbWJLAMNPiAwpYPcV1atWSppEZK1ABoWBR'
const OWNER = '4DYhzGx6J2xgJWs7nSCnTXgBdEnoQ9VnKfarJVz2Jj96'
const MERCHANT = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq'
const PLAN = 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const OTHER_MINT = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

const DAY_SECONDS = 86_400
const NOW = new Date('2026-09-02T10:00:00.000Z')

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
    chainState: chainState(),
    diverged: false,
    ...over,
  }
}

function ready(over: Partial<Card> = {}, refreshFailed: string | null = null): AllowanceState {
  return {
    status: 'ready',
    detail: detailFromAllowance(card(over), NOW),
    refreshing: false,
    refreshFailed,
  }
}

type Actions = Partial<{
  onPause: (id: string) => void
  onDontRenew: (id: string) => void
  onCancelNow: (id: string) => void
  onResume: (id: string) => void
  onKeep: (id: string) => void
}>

function show(state: AllowanceState, actions: Actions = {}) {
  render(<Subscription state={state} onBack={() => {}} {...actions} />)
}

afterEach(cleanup)

describe('the state of the card', () => {
  it('says it is reading, instead of showing an empty card', () => {
    show({ status: 'loading' })
    expect(screen.getByText(/Reading this permission/)).toBeTruthy()
  })

  it('separates "there is no such permission" from "we failed to load"', () => {
    show({ status: 'missing' })
    const text = screen.getByText(/There is no permission at this address/).textContent ?? ''
    expect(text).toContain('an answer, not a failure to load')
  })

  it('repeats the named failure instead of showing a blank card', () => {
    show({ status: 'error', message: 'We could not reach CancelChain.' })
    expect(screen.getByText('We could not reach CancelChain.')).toBeTruthy()
  })

  it('says the shown state is older than the failed re-read', () => {
    show(ready({}, 'CancelChain answered 500'))
    expect(screen.getByText(/The latest re-read failed/)).toBeTruthy()
  })
})

describe('the five fields of FR-002, on one screen (SC-005)', () => {
  it('shows all five without going anywhere else', () => {
    show(ready())

    expect(screen.getByText('Recipient')).toBeTruthy()
    expect(screen.getByText(MERCHANT)).toBeTruthy()
    expect(screen.getByText('Ceiling')).toBeTruthy()
    expect(screen.getByText('24.00 USDC')).toBeTruthy()
    expect(screen.getByText('Period')).toBeTruthy()
    expect(screen.getByText('30 days')).toBeTruthy()
    expect(screen.getByText('Spent this period')).toBeTruthy()
    expect(screen.getByText('12.00 USDC')).toBeTruthy()
    expect(screen.getByText('Next charge')).toBeTruthy()
    expect(screen.getByText(/6 Sep 2026/)).toBeTruthy()
  })

  it('keeps all five when the wallet has never been asked for a signature', () => {
    // Жодна дія тут не потрібна: п'ять полів — це читання, і воно не залежить
    // від того, чи є на екрані кнопки.
    show(ready())
    for (const label of ['Recipient', 'Ceiling', 'Period', 'Spent this period', 'Next charge']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
  })
})

describe('a one-off permission', () => {
  const oneOff = () =>
    ready({
      kind: 'fixed',
      periodSeconds: null,
      periodStartedAt: null,
      spentInPeriod: '0',
      capAmount: '11500000',
      chainState: chainState({ periodStartedAt: null, spentInPeriod: '0', capAmount: '11500000' }),
    })

  it('says what the network does not record, in words', () => {
    show(oneOff())
    expect(screen.getByText('The network does not record it')).toBeTruthy()
    expect(screen.getByText(/unknown, not zero/)).toBeTruthy()
    // Нуль на місці «витрачено» був би твердженням, якого ніхто не робив.
    expect(screen.queryByText('0.00 USDC')).toBeNull()
  })

  it('draws no consent strip over an amount nobody knows', () => {
    show(oneOff())
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('calls its ceiling what is left of it, and its period none', () => {
    show(oneOff())
    expect(screen.getByText('Ceiling — what is left')).toBeTruthy()
    expect(screen.getByText('One-off — no period')).toBeTruthy()
    expect(screen.getByText('Any time')).toBeTruthy()
  })
})

describe('a period the network still calls current but which has ended', () => {
  const stale = () =>
    ready({
      periodStartedAt: '2026-06-01T00:00:00.000Z',
      chainState: chainState({ periodStartedAt: '2026-06-01T00:00:00.000Z' }),
    })

  it('does not draw a full strip over a ceiling that resets on the next charge', () => {
    show(stale())
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('says the next charge can happen at any moment', () => {
    show(stale())
    expect(screen.getByText('Any time now')).toBeTruthy()
    // Те саме речення стоїть і в періоді, і у «витрачено»: обидва стосуються
    // періоду, якого вже немає.
    expect(screen.getAllByText(/has already ended\./).length).toBeGreaterThan(0)
  })
})

describe('an allowance in an asset CancelChain does not settle', () => {
  const foreign = () =>
    ready({
      mint: OTHER_MINT,
      assetSupported: false,
      capAmount: '500',
      spentInPeriod: '200',
      chainState: chainState({ capAmount: '500', spentInPeriod: '200' }),
    })

  it('offers nothing but cancelling, and says so', () => {
    show(foreign(), { onPause: vi.fn(), onDontRenew: vi.fn(), onCancelNow: vi.fn() })
    expect(screen.getByText(/offers nothing here but cancelling/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel now' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Don't renew/ })).toBeNull()
  })

  it('does not explain smallest units for a source that knows the decimals', () => {
    // Мок свій актив знає й показує «500 CPRL». Речення про найменші одиниці
    // пояснювало б там те, чого на екрані не сталося.
    const permission = PERMISSIONS.find((entry) => entry.id === 'copperline-games')
    expect(permission).toBeDefined()
    const detail = detailFromPermission(permission as (typeof PERMISSIONS)[number])
    show({ status: 'ready', detail, refreshing: false, refreshFailed: null })

    expect(screen.getByText(/offers nothing here but cancelling/)).toBeTruthy()
    expect(screen.queryByText(/smallest units/)).toBeNull()
  })

  it('shows its amounts in the smallest units it can name', () => {
    show(foreign())
    expect(screen.getAllByText(/500 of /).length).toBeGreaterThan(0)
    expect(screen.getByText(/does not know its decimals/)).toBeTruthy()
  })
})

describe('what the network says about the card', () => {
  it('shows a disagreement with the stored copy instead of hiding it', () => {
    show(ready({ diverged: true }))
    expect(screen.getByText(/disagreed with the network/)).toBeTruthy()
  })

  it('says the account is gone rather than showing a stored "active"', () => {
    show(ready({ status: 'revoked', chainState: null, diverged: true }))
    expect(screen.getByText(/no account for this permission on the network/)).toBeTruthy()
    expect(screen.getByText('Never — this permission is cancelled')).toBeTruthy()
  })

  it('names the moment and the slot it was read at', () => {
    show(ready())
    expect(screen.getByText(/Read from the network at .*slot 400000000/)).toBeTruthy()
  })
})

describe('activity', () => {
  it('does not pass an unread feed off as an empty history', () => {
    show(ready())
    expect(screen.getByText(/not a history that is empty/)).toBeTruthy()
  })

  it('shows the demo feed when the source has one', () => {
    const permission = PERMISSIONS[0]
    expect(permission).toBeDefined()
    const detail = detailFromPermission(permission as (typeof PERMISSIONS)[number])
    show({ status: 'ready', detail, refreshing: false, refreshFailed: null })

    const first = detail.activity?.[0]
    expect(first).toBeDefined()
    expect(
      screen.getAllByText((first as { description: string }).description).length,
    ).toBeGreaterThan(0)
  })
})

describe('actions', () => {
  const subscription = () => ready({ kind: 'subscription', planPda: PLAN, expiresAt: null })

  it('offers pause and end-scheduling only for a plan subscription', () => {
    show(subscription(), { onPause: vi.fn(), onDontRenew: vi.fn(), onCancelNow: vi.fn() })
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Don't renew/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel now' })).toBeTruthy()
  })

  it('says why a permission given directly has fewer of them', () => {
    show(ready(), { onPause: vi.fn(), onDontRenew: vi.fn(), onCancelNow: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    expect(screen.getByText(/given directly, not through a plan/)).toBeTruthy()
  })

  it('offers nothing on a permission that is already cancelled', () => {
    show(ready({ status: 'revoked', chainState: null }), { onCancelNow: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Cancel now' })).toBeNull()
  })

  it('shows no button at all when there is nothing behind it', () => {
    // На справжніх даних скасування ще немає (`T025`, `T026`), і кнопка, яка
    // нічого не робить, гірша за її відсутність.
    show(subscription())
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /My subscriptions/ })).toBeTruthy()
  })
})
