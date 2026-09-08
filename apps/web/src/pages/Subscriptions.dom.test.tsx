// @vitest-environment jsdom
import type { ListedAllowance } from '@cancelchain/shared'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AllowanceList } from '../lib/source'
import type { AllowancesState } from '../lib/useAllowances'
import { viewFromAllowance as toView } from '../lib/view'
import Subscriptions from './Subscriptions'

/**
 * Екран списку на справжніх даних (`T023`). Перевіряється не верстка, а те, що
 * список **не бреше**: не показує порожнє місце замість невдачі, не коротшає
 * мовчки і не пропонує над чужим активом нічого, крім скасування.
 */

const PDA = '3amcyam5KhjbWJLAMNPiAwpYPcV1atWSppEZK1ABoWBR'
const OTHER_PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH'
const THIRD_PDA = '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq'
const OWNER = '4DYhzGx6J2xgJWs7nSCnTXgBdEnoQ9VnKfarJVz2Jj96'
const MERCHANT = 'GwipgRis9nuE5JYYrnE9fVV8JUGJMvUM79Jo5yzkqXBe'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const OTHER_MINT = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

const DAY_SECONDS = 86_400
const HOUR_SECONDS = 3_600

/** Момент відліку тримається явно — див. `view.test.ts`. */
const NOW = new Date('2026-09-02T10:00:00.000Z')

function viewFromAllowance(allowance: ListedAllowance) {
  return toView(allowance, NOW)
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

function list(over: Partial<AllowanceList> = {}): AllowanceList {
  return {
    items: [viewFromAllowance(listed())],
    syncedAt: '2026-09-02T10:00:00.000Z',
    stale: false,
    unreadable: [],
    ...over,
  }
}

function ready(over: Partial<AllowanceList> = {}): AllowancesState {
  return { status: 'ready', list: list(over), refreshing: false, refreshFailed: null }
}

function show(state: AllowancesState, onCancel?: (id: string) => void) {
  render(
    <Subscriptions state={state} walletLabel="4DYh…Jj96" onNetwork={true} onCancel={onCancel} />,
  )
}

afterEach(cleanup)

describe('the state of the list', () => {
  it('asks for a wallet instead of showing an empty list', () => {
    show({ status: 'no-wallet' })
    expect(screen.getByText(/list of one wallet/i)).toBeDefined()
    expect(screen.queryByText(/You have allowed/i)).toBeNull()
  })

  it('says it is still reading, which is not the same as nothing being there', () => {
    show({ status: 'loading' })
    expect(screen.getByText(/Reading this wallet/i)).toBeDefined()
  })

  it('shows a failure as a failure, never as an empty wallet', () => {
    // Це найважливіший випадок екрана: порожній список тут читався б як
    // «ніхто не може списати», тобто як протилежність правди.
    show({ status: 'error', message: 'could not reach CancelChain' })
    expect(screen.getByText(/could not reach CancelChain/i)).toBeDefined()
    expect(screen.queryByText(/No one can charge this wallet/i)).toBeNull()
  })

  it('says a list of nothing means nothing is running', () => {
    show(ready({ items: [] }))
    expect(screen.getByText(/No one can charge this wallet/i)).toBeDefined()
  })

  it('keeps the old list visible but says the re-read failed', () => {
    show({
      status: 'ready',
      list: list(),
      refreshing: false,
      refreshFailed: 'could not reach CancelChain',
    })
    expect(screen.getByText(/latest re-read failed/i)).toBeDefined()
    expect(screen.getByText(/Up to 24.00 USDC every 30 days/i)).toBeDefined()
  })
})

describe('what the list is not allowed to hide', () => {
  it('names every account it could not turn into a card', () => {
    show(
      ready({
        unreadable: [
          { address: OTHER_PDA, reason: 'version' },
          { address: THIRD_PDA, reason: 'plan' },
        ],
      }),
    )
    expect(screen.getByText(/The list is short by 2/i)).toBeDefined()
    expect(screen.getByText(OTHER_PDA)).toBeDefined()
    expect(screen.getByText(/newer version of the program/i)).toBeDefined()
    expect(screen.getByText(/merchant plan could not be found/i)).toBeDefined()
  })

  it('claims nothing about missing accounts when there are none', () => {
    show(ready())
    expect(screen.queryByText(/The list is short by/i)).toBeNull()
  })

  it('keeps an allowance in an unsupported asset in the list', () => {
    show(
      ready({
        items: [
          viewFromAllowance(listed()),
          viewFromAllowance(
            listed({
              pda: OTHER_PDA,
              mint: OTHER_MINT,
              assetSupported: false,
              capAmount: '500',
              spentInPeriod: '0',
            }),
          ),
        ],
      }),
    )
    expect(screen.getByText(/500 of EtWT…rZBG/)).toBeDefined()
    expect(screen.getByText(/only manages USDC permissions/i)).toBeDefined()
  })
})

describe('the number in the header', () => {
  it('adds up only what can charge in the settlement asset', () => {
    show(
      ready({
        items: [
          viewFromAllowance(listed({ capAmount: '24000000' })),
          viewFromAllowance(listed({ pda: OTHER_PDA, capAmount: '11500000' })),
          viewFromAllowance(
            listed({ pda: THIRD_PDA, mint: OTHER_MINT, assetSupported: false, capAmount: '500' }),
          ),
        ],
      }),
    )
    expect(screen.getByText('35.50 USDC')).toBeDefined()
    expect(screen.getByText(/across 2 active permissions/i)).toBeDefined()
    expect(screen.getByText(/1 more permission is in another asset/i)).toBeDefined()
  })

  it('claims nothing about periods when nothing is counted', () => {
    show(
      ready({
        items: [
          viewFromAllowance(listed({ mint: OTHER_MINT, assetSupported: false, capAmount: '500' })),
        ],
      }),
    )
    expect(screen.getByText(/^across 0 active permissions$/i)).toBeDefined()
  })

  it('does not claim a shared period when the periods differ', () => {
    show(
      ready({
        items: [
          viewFromAllowance(listed({ periodSeconds: 30 * DAY_SECONDS })),
          viewFromAllowance(listed({ pda: OTHER_PDA, periodSeconds: 7 * DAY_SECONDS })),
        ],
      }),
    )
    expect(screen.getByText(/across their own periods/i)).toBeDefined()
  })

  it('names the period when every counted allowance shares one', () => {
    show(ready())
    expect(screen.getByText(/every 30 days, across 1 active permission/i)).toBeDefined()
  })
})

describe('a card of real data', () => {
  it('shows an address and never an invented merchant name', () => {
    show(ready())
    expect(screen.getByText('Gwip…qXBe')).toBeDefined()
  })

  it('says the network does not record what a one-off has spent', () => {
    show(
      ready({
        items: [
          viewFromAllowance(
            listed({
              kind: 'fixed',
              periodSeconds: null,
              periodStartedAt: null,
              spentInPeriod: '0',
            }),
          ),
        ],
      }),
    )
    expect(screen.getByText(/does not record what a one-off permission/i)).toBeDefined()
    expect(screen.queryByText(/Used this period/i)).toBeNull()
  })

  it('offers no button at all while cancelling is not wired up', () => {
    // Кнопка, яка нічого не робить, гірша за її відсутність: цей екран не має
    // права виглядати так, ніби скасування вже працює.
    show(ready())
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('offers cancelling — and only cancelling — over an unsupported asset', () => {
    show(
      ready({
        items: [
          viewFromAllowance(listed({ mint: OTHER_MINT, assetSupported: false, capAmount: '500' })),
        ],
      }),
      () => undefined,
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.textContent).toBe('Cancel')
  })

  it('says a period that has ended has ended, instead of drawing a full strip', () => {
    // Прочитано з devnet: період в одну годину, початок у травні. Повна смужка
    // тут читалася б як «більше взяти не можуть» — навпаки, можуть будь-коли.
    show(
      ready({
        items: [
          viewFromAllowance(
            listed({
              periodSeconds: HOUR_SECONDS,
              periodStartedAt: '2026-05-26T18:28:35.000Z',
              capAmount: '100000',
              spentInPeriod: '100000',
            }),
          ),
        ],
      }),
    )
    expect(screen.getByText(/Up to 0.10 USDC every hour/)).toBeDefined()
    expect(screen.getByText(/Next charge any time now/i)).toBeDefined()
    expect(screen.getByText(/in the period that ended/i)).toBeDefined()
    // Смужка згоди — це `role="img"`. Над скінченим періодом її бути не має.
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows a cancelled allowance as cancelled', () => {
    show(ready({ items: [viewFromAllowance(listed({ status: 'revoked' }))] }))
    expect(screen.getByText('Cancelled')).toBeDefined()
    expect(screen.getByText(/No further charges can be made/i)).toBeDefined()
  })

  it('says why an exhausted allowance cannot charge', () => {
    show(
      ready({
        items: [
          viewFromAllowance(
            listed({
              kind: 'fixed',
              status: 'exhausted',
              capAmount: '0',
              periodSeconds: null,
              periodStartedAt: null,
              spentInPeriod: '0',
            }),
          ),
        ],
      }),
    )
    expect(screen.getByText(/Nothing is left on this one-off permission/i)).toBeDefined()
  })

  it('separates "won\'t renew" from an expiry nobody chose', () => {
    show(
      ready({
        items: [
          viewFromAllowance(
            listed({ kind: 'subscription', planPda: MERCHANT, endsAt: '2026-09-27T00:00:00.000Z' }),
          ),
          viewFromAllowance(listed({ pda: OTHER_PDA, expiresAt: '2026-10-05T00:00:00.000Z' })),
        ],
      }),
    )
    expect(screen.getByText(/Ends 27 Sep — won't renew/i)).toBeDefined()
    expect(screen.getByText(/Expires 5 Oct/i)).toBeDefined()
  })
})
