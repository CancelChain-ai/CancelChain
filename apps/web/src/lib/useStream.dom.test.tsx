// @vitest-environment jsdom
import type { StreamMessage } from '@cancelchain/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AllowanceList } from './source'
import type { EventSourceLike } from './stream'
import { useAllowance } from './useAllowance'
import { useAllowances } from './useAllowances'
import { useStream } from './useStream'
import type { AllowanceDetailView } from './view'

/**
 * `useStream` (`T042a`) end to end inside the page: a message on the stream
 * makes the real list and card hooks read again — from the network, with the
 * slot of the change as the floor — and nothing streams without a wallet.
 */

const mocks = vi.hoisted(() => ({
  listAllowances:
    vi.fn<(owner: string | null, signal?: AbortSignal, minSlot?: number) => Promise<unknown>>(),
  getAllowance: vi.fn<(id: string, signal?: AbortSignal, minSlot?: number) => Promise<unknown>>(),
}))

vi.mock('./source', () => ({
  source: {
    kind: 'api',
    onNetwork: true,
    requiresWallet: true,
    listAllowances: mocks.listAllowances,
    getAllowance: mocks.getAllowance,
  },
  apiBaseUrlFromEnv: () => 'http://api.test',
}))

const OWNER = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH'

const LIST: AllowanceList = {
  items: [],
  syncedAt: '2026-10-05T10:00:00.000Z',
  stale: false,
  unreadable: [],
}

class FakeSource implements EventSourceLike {
  readyState = 0
  onerror: ((event: Event) => void) | null = null
  closed = false
  private listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close() {
    this.closed = true
  }
  send(message: StreamMessage) {
    this.readyState = 1
    for (const listener of this.listeners.get(message.type) ?? []) {
      listener({ data: JSON.stringify(message) } as MessageEvent<string>)
    }
  }
}

let queryClient: QueryClient
let opened: FakeSource[]
const create = (url: string) => {
  const source = new FakeSource(url)
  opened.push(source)
  return source
}

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function page(owner: string | null) {
  return renderHook(
    ({ who }) => ({
      live: useStream(who, create),
      list: useAllowances(who),
      card: useAllowance(PDA),
    }),
    { wrapper, initialProps: { who: owner } },
  )
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  opened = []
  mocks.listAllowances.mockReset().mockResolvedValue(LIST)
  mocks.getAllowance.mockReset().mockResolvedValue({ id: PDA } as unknown as AllowanceDetailView)
})

afterEach(cleanup)

describe('useStream', () => {
  it('opens nothing without a wallet and says nothing', () => {
    const { result } = page(null)

    expect(result.current.live).toBe('off')
    expect(opened).toHaveLength(0)
  })

  it("opens the wallet's stream and goes live on ready", () => {
    const { result } = page(OWNER)

    expect(opened.map((source) => source.url)).toEqual([`http://api.test/v1/stream?owner=${OWNER}`])
    expect(result.current.live).toBe('connecting')
    act(() => opened[0]?.send({ type: 'ready' }))
    expect(result.current.live).toBe('live')
  })

  it('allowance.updated: the list and the card read the network again, no older than the change', async () => {
    page(OWNER)
    await waitFor(() => expect(mocks.listAllowances).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.getAllowance).toHaveBeenCalledTimes(1))
    expect(mocks.listAllowances.mock.calls[0]?.[2]).toBeUndefined()

    act(() =>
      opened[0]?.send({
        type: 'allowance.updated',
        allowance: {
          pda: PDA,
          owner: OWNER,
          delegate: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          kind: 'fixed',
          capAmount: '25000000',
          periodSeconds: null,
          spentInPeriod: '0',
          periodStartedAt: null,
          expiresAt: null,
          pausedAt: null,
          endsAt: null,
          status: 'revoked',
          planPda: null,
          lastSlot: 412_345_678,
          syncedAt: '2026-10-05T10:00:00.000Z',
        },
      }),
    )

    await waitFor(() => expect(mocks.listAllowances).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(mocks.getAllowance).toHaveBeenCalledTimes(2))
    expect(mocks.listAllowances.mock.calls[1]?.[0]).toBe(OWNER)
    expect(mocks.listAllowances.mock.calls[1]?.[2]).toBe(412_345_678)
    expect(mocks.getAllowance.mock.calls[1]?.[2]).toBe(412_345_678)
  })

  it('a new wallet closes the old stream and opens its own', () => {
    const other = 'Stake11111111111111111111111111111111111111'
    const { rerender } = page(OWNER)
    rerender({ who: other })

    expect(opened).toHaveLength(2)
    expect(opened[0]?.closed).toBe(true)
    expect(opened[1]?.url).toBe(`http://api.test/v1/stream?owner=${other}`)
  })

  it('unmounting closes the stream', () => {
    const { unmount } = page(OWNER)
    unmount()
    expect(opened[0]?.closed).toBe(true)
  })
})
