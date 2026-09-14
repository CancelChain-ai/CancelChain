// @vitest-environment jsdom
import type { ListedAllowance } from '@cancelchain/shared'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CancelControls, CancelState } from '../chain/revoke'
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

function controls(onCancel: (id: string) => void): CancelControls {
  return { state: { status: 'idle' }, cancel: onCancel, unavailable: null, dismiss: () => {} }
}

function show(state: AllowancesState, onCancel?: (id: string) => void) {
  render(
    <Subscriptions
      state={state}
      walletLabel="4DYh…Jj96"
      onNetwork={true}
      cancel={onCancel === undefined ? undefined : controls(onCancel)}
    />,
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

  it('shows a cancelled allowance as cancelled — only where no network stands behind the list', () => {
    /*
     * Картка-надгробок належить демо M0, і `onNetwork={false}` тут не деталь
     * рендера: з мережі скасований дозвіл не приходить узагалі (акаунт
     * закритий, `deriveStatus` такого статусу не видає), і намальована нами
     * мітка над справжнім списком була б розбіжністю з мережею (`T029`).
     */
    render(
      <Subscriptions
        state={ready({ items: [viewFromAllowance(listed({ status: 'revoked' }))] })}
        walletLabel={null}
        onNetwork={false}
      />,
    )
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

/**
 * Потік скасування зі списку — `T026`, `FR-003`, `FR-019`, `FR-026`.
 *
 * Тут і міряється кліковий бік `SC-002`: від картки до підпису рівно два
 * кліки. Другий бік критерію — один підпис — доводить не екран, а білдер:
 * у транзакції рівно одне місце під підпис (`packages/chain/src/revoke.test.ts`).
 */
describe('cancelling from the list', () => {
  function withCancel(state: CancelState, cancel: ((id: string) => void) | null = () => {}) {
    render(
      <Subscriptions
        state={ready()}
        walletLabel="4DYh…Jj96"
        onNetwork={true}
        cancel={{ state, cancel, unavailable: null, dismiss: () => {} }}
      />,
    )
  }

  it('SC-002: two clicks from the card to the signature, and not a third', () => {
    const cancel = vi.fn()
    withCancel({ status: 'idle' }, cancel)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel this permission' }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith(PDA)
  })

  it('FR-026: the confirmation names the paid-until date and whose decision access is', () => {
    withCancel({ status: 'idle' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const text = screen.getByText(/already paid for the period ending/i).textContent ?? ''
    expect(text).toMatch(/their decision, not ours/i)
  })

  it('offers nothing more while the signature is in the wallet', () => {
    withCancel({ status: 'working', id: PDA, step: 'signing' })
    expect(screen.getByText(/waiting for your wallet to sign/i)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel this permission' })).toBeNull()
  })

  it('an unconfirmed send is not reported as cancelled', () => {
    withCancel({ status: 'unconfirmed', id: PDA, signature: 'abc123' })
    const text = screen.getByText(/still on the network/i).textContent ?? ''
    expect(text).toMatch(/this is not a confirmation/i)
    expect(screen.queryByText(/^Cancelled\./)).toBeNull()
  })

  it('a permission that was already gone is an answer, not a failure', () => {
    withCancel({ status: 'gone', id: PDA })
    expect(screen.getByText(/already gone before anything was signed/i)).toBeDefined()
  })

  it('a declined signature is shown as the wallet said it, not as a crash', () => {
    withCancel({ status: 'failed', id: PDA, message: 'You declined the signature in your wallet.' })
    expect(screen.getByText(/You declined the signature/i)).toBeDefined()
  })

  it('the progress of one card does not touch another', () => {
    render(
      <Subscriptions
        state={ready({
          items: [viewFromAllowance(listed()), viewFromAllowance(listed({ pda: OTHER_PDA }))],
        })}
        walletLabel="4DYh…Jj96"
        onNetwork={true}
        cancel={{
          state: { status: 'working', id: PDA, step: 'confirming' },
          cancel: () => {},
          unavailable: null,
          dismiss: () => {},
        }}
      />,
    )
    expect(screen.getAllByText(/waiting for the network to drop/i)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1)
  })

  it('says why cancelling is unavailable instead of hiding the button silently', () => {
    render(
      <Subscriptions
        state={ready()}
        walletLabel="4DYh…Jj96"
        onNetwork={true}
        cancel={{
          state: { status: 'idle' },
          cancel: null,
          unavailable: 'This wallet cannot sign, so cancelling is unavailable here.',
          dismiss: () => {},
        }}
      />,
    )
    expect(screen.getByText(/This wallet cannot sign/i)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })
})

/**
 * `T029` — дозвіл, якого в списку вже немає (`FR-022`).
 *
 * Скасування закриває акаунт, тож наступне читання гаманця його не бачить і
 * картка зникає. Перевіряється тут одне: разом із карткою не зникає відповідь
 * на питання «то що сталося?» — і що надгробка з міткою «Cancelled» на її
 * місці не з'являється.
 */
describe('a permission that is gone from the list', () => {
  function withState(state: CancelState, listState: AllowancesState = ready()) {
    render(
      <Subscriptions
        state={listState}
        walletLabel="4DYh…Jj96"
        onNetwork={true}
        cancel={{ state, cancel: () => {}, unavailable: null, dismiss: () => {} }}
      />,
    )
  }

  it('keeps the confirmation, and the signature, after the card disappears', () => {
    withState({ status: 'done', id: OTHER_PDA, signature: 'abc123' })
    const text = screen.getByText(/no longer exists on the network/i).textContent ?? ''
    expect(text).toMatch(/abc123/)
    expect(text).toMatch(/gone from the list read at/i)
  })

  it('draws no cancelled card in place of the account that is gone', () => {
    // Рішення `T026`: скасований дозвіл — це зниклий акаунт, а не картка з
    // міткою. Намальована нами мітка й була б розбіжністю з мережею.
    withState({ status: 'done', id: OTHER_PDA, signature: 'abc123' }, ready({ items: [] }))
    expect(screen.queryByText('Cancelled')).toBeNull()
    expect(screen.queryByText(/No further charges can be made/i)).toBeNull()
    expect(screen.getByText(/No one can charge this wallet/i)).toBeDefined()
  })

  it('says nothing at list level while the card is still there', () => {
    withState({ status: 'done', id: PDA, signature: 'abc123' })
    expect(screen.getAllByText(/no longer exists on the network/i)).toHaveLength(1)
    expect(screen.queryByText(/gone from the list read at/i)).toBeNull()
  })

  it('treats an absence as the confirmation the wallet never gave us', () => {
    // Ми перестали чекати, поки акаунт був на місці. Список, прочитаний після
    // того, його не бачить — це та сама перевірка, тільки пізніше.
    withState({ status: 'unconfirmed', id: OTHER_PDA, signature: 'abc123' })
    const text = screen.getByText(/stopped waiting/i).textContent ?? ''
    expect(text).toMatch(/the account is gone after all/i)
    expect(text).not.toMatch(/this is not a confirmation/i)
  })

  it('does not turn a failed cancel into a success just because the account is gone', () => {
    withState({ status: 'failed', id: OTHER_PDA, message: 'You declined the signature.' })
    const text = screen.getByText(/You declined the signature/i).textContent ?? ''
    expect(text).toMatch(/either it was already gone, or the transaction landed anyway/i)
  })

  it('does not go silent when the card disappears mid-flow', () => {
    withState({ status: 'working', id: OTHER_PDA, step: 'signing' })
    expect(screen.getByText(/waiting for your wallet to sign/i)).toBeDefined()
  })
})

/**
 * `T029` — порожньо як твердження (`FR-022`, `FR-006`).
 *
 * «Ніхто не може списати» можна сказати рівно тоді, коли прочитано все і
 * щойно. У решті випадків порожній екран — відповідь про минуле або про
 * частину гаманця, видана за відповідь про весь.
 */
describe('what an empty list is allowed to claim', () => {
  it('explains that a cancelled permission simply is not here', () => {
    show(ready({ items: [] }))
    expect(screen.getByText(/instead of sitting in it marked cancelled/i)).toBeDefined()
  })

  it('does not call an empty list safe while accounts could not be read', () => {
    show(ready({ items: [], unreadable: [{ address: OTHER_PDA, reason: 'version' }] }))
    expect(screen.queryByText(/No one can charge this wallet/i)).toBeNull()
    expect(screen.getByText(/Empty here is not the same as safe/i)).toBeDefined()
    // І сам акаунт названий, а не полічений.
    expect(screen.getByText(OTHER_PDA)).toBeDefined()
  })

  it('does not present a failed re-read as an empty wallet', () => {
    show({
      status: 'ready',
      list: list({ items: [] }),
      refreshing: false,
      refreshFailed: 'could not reach CancelChain',
    })
    expect(screen.queryByText(/No one can charge this wallet/i)).toBeNull()
    expect(screen.getByText(/not what it says now/i)).toBeDefined()
  })

  it('does not present a stale copy as an empty wallet', () => {
    show(ready({ items: [], stale: true }))
    expect(screen.queryByText(/No one can charge this wallet/i)).toBeNull()
    expect(screen.getByText(/not an answer about what can charge this wallet/i)).toBeDefined()
  })
})
