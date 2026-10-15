// @vitest-environment jsdom
import type { Address, ListedAllowance } from '@cancelchain/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from './api'
import type { AllowanceList } from './source'
import { useAllowances } from './useAllowances'
import { viewFromAllowance } from './view'

/**
 * The saved copy in front of the network (`SC-008`): shown at once for a
 * returning wallet, said to be a copy, replaced by the network's answer — and
 * what the network changed against it is counted, not hidden.
 */

const mocks = vi.hoisted(() => ({
  listAllowances: vi.fn<(owner: string | null) => Promise<AllowanceList>>(),
  storedList: vi.fn<(owner: string) => AllowanceList | null>(),
}))

vi.mock('./source', () => ({
  source: {
    kind: 'api',
    requiresWallet: true,
    listAllowances: mocks.listAllowances,
    storedList: mocks.storedList,
  },
}))

const OWNER = '4DYhzGx6J2xgJWs7nSCnTXgBdEnoQ9VnKfarJVz2Jj96' as Address
const PDA = '3amcyam5KhjbWJLAMNPiAwpYPcV1atWSppEZK1ABoWBR'
const OTHER_PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH'
const SAVED_AT = '2026-10-14T09:00:00.000Z'
const READ_AT = '2026-10-15T10:00:00.000Z'

function listed(over: Partial<ListedAllowance> = {}): ListedAllowance {
  return {
    pda: PDA,
    owner: OWNER,
    delegate: '6T4JnBu2xDn32nsVJAZEhAySwTLHRST6jsSdvb8FsSnq',
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    kind: 'recurring',
    capAmount: '24000000',
    periodSeconds: 30 * 86_400,
    spentInPeriod: '0',
    periodStartedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: null,
    pausedAt: null,
    endsAt: null,
    status: 'active',
    planPda: null,
    lastSlot: 400_000_000,
    syncedAt: SAVED_AT,
    assetSupported: true,
    ...over,
  }
}

function list(syncedAt: string, items: ListedAllowance[]): AllowanceList {
  return {
    items: items.map((item) => viewFromAllowance(item, new Date(syncedAt))),
    syncedAt,
    stale: false,
    unreadable: [],
  }
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } })
  mocks.listAllowances.mockReset()
  mocks.storedList.mockReset()
})

afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe('useAllowances with a saved copy', () => {
  it('shows the copy before the network answers, and says it is one', async () => {
    const saved = list(SAVED_AT, [listed()])
    mocks.storedList.mockReturnValue(saved)
    mocks.listAllowances.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useAllowances(OWNER), { wrapper })

    expect(result.current).toMatchObject({
      status: 'ready',
      list: saved,
      savedCopy: true,
      sinceSavedCopy: null,
    })
    // The copy does not stand in for the network: the network is asked anyway.
    await waitFor(() => expect(mocks.listAllowances.mock.calls[0]?.[0]).toBe(OWNER))
    expect(result.current).toMatchObject({ refreshing: true })
  })

  it('lets the network replace the copy and counts what changed', async () => {
    mocks.storedList.mockReturnValue(list(SAVED_AT, [listed(), listed({ pda: OTHER_PDA })]))
    const fresh = list(READ_AT, [listed({ spentInPeriod: '24000000', syncedAt: READ_AT })])
    mocks.listAllowances.mockResolvedValue(fresh)

    const { result } = renderHook(() => useAllowances(OWNER), { wrapper })

    await waitFor(() => expect(result.current).toMatchObject({ savedCopy: false }))
    expect(result.current).toMatchObject({
      status: 'ready',
      list: fresh,
      refreshing: false,
      sinceSavedCopy: { savedAt: SAVED_AT, divergence: { added: 0, gone: 1, changed: 1 } },
    })
  })

  it('says nothing about a copy the network confirmed', async () => {
    mocks.storedList.mockReturnValue(list(SAVED_AT, [listed()]))
    mocks.listAllowances.mockResolvedValue(list(READ_AT, [listed({ lastSlot: 400_000_500 })]))

    const { result } = renderHook(() => useAllowances(OWNER), { wrapper })

    await waitFor(() => expect(result.current).toMatchObject({ savedCopy: false }))
    expect(result.current).toMatchObject({ sinceSavedCopy: null })
  })

  it('keeps the copy on screen when the network fails, and names the failure', async () => {
    const saved = list(SAVED_AT, [listed()])
    mocks.storedList.mockReturnValue(saved)
    mocks.listAllowances.mockRejectedValue(new ApiRequestError(503, 'INTERNAL', 'down'))

    const { result } = renderHook(() => useAllowances(OWNER), { wrapper })

    await waitFor(() =>
      expect(result.current).toMatchObject({ refreshing: false, savedCopy: true }),
    )
    expect(result.current).toMatchObject({ status: 'ready', list: saved })
    expect(result.current.status === 'ready' && result.current.refreshFailed).toEqual(
      expect.any(String),
    )
  })

  it('without a copy waits for the network, as before', async () => {
    mocks.storedList.mockReturnValue(null)
    mocks.listAllowances.mockRejectedValue(new ApiRequestError(503, 'INTERNAL', 'down'))

    const { result } = renderHook(() => useAllowances(OWNER), { wrapper })

    expect(result.current).toEqual({ status: 'loading' })
    await waitFor(() => expect(result.current.status).toBe('error'))
  })

  it('asks storage nothing without a wallet', () => {
    const { result } = renderHook(() => useAllowances(null), { wrapper })
    expect(result.current).toEqual({ status: 'no-wallet' })
    expect(mocks.storedList).not.toHaveBeenCalled()
  })
})
