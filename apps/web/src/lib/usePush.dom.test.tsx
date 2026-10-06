// @vitest-environment jsdom
import type { Address } from '@cancelchain/shared'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { type PushController, PushFailure, type PushStatus } from './push'
import { usePush } from './usePush'

afterEach(cleanup)

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR' as Address
const OTHER = 'FGHMNoNNq3aMvTxrfeNRzS6SwE7SKZp6UyZ7FMjjf3nk' as Address

/** A controller whose answers the test releases by hand. */
function controller(initial: PushStatus = 'off') {
  const pending: { owner: Address; resolve: (status: PushStatus) => void }[] = []
  const value: PushController = {
    status: async () => initial,
    enable: (owner) =>
      new Promise((resolve) => {
        pending.push({ owner, resolve })
      }),
    disable: async () => 'off',
  }
  const factory = () => value
  return { factory, pending }
}

describe('usePush', () => {
  it('has no switch without a wallet', () => {
    const { factory } = controller()
    const { result } = renderHook(() => usePush(null, factory))
    expect(result.current).toBeNull()
  })

  it('reads the state of the connected wallet, then turns it on', async () => {
    const { factory, pending } = controller()
    const { result } = renderHook(() => usePush(OWNER, factory))
    expect(result.current?.status).toBe('checking')
    await waitFor(() => expect(result.current?.status).toBe('off'))

    act(() => result.current?.enable())
    expect(result.current?.busy).toBe(true)
    await act(async () => pending[0]?.resolve('on'))
    expect(result.current).toMatchObject({ status: 'on', busy: false, error: null })
  })

  it('does not land a switch flipped for one wallet on the next', async () => {
    const { factory, pending } = controller()
    const { result, rerender } = renderHook(({ owner }) => usePush(owner, factory), {
      initialProps: { owner: OWNER },
    })
    await waitFor(() => expect(result.current?.status).toBe('off'))
    act(() => result.current?.enable())

    rerender({ owner: OTHER })
    await waitFor(() => expect(result.current?.status).toBe('off'))
    await act(async () => pending[0]?.resolve('on'))
    expect(result.current?.status).toBe('off')
  })

  it('says why a check failed, and offers the switch', async () => {
    const failing: PushController = {
      status: async () => {
        throw new PushFailure('We could not reach CancelChain.')
      },
      enable: async () => 'on',
      disable: async () => 'off',
    }
    // The factory is stable, as the default one is: a new one per render re-checks per render.
    const factory = () => failing
    const { result } = renderHook(() => usePush(OWNER, factory))
    await waitFor(() => expect(result.current?.error).toBe('We could not reach CancelChain.'))
    expect(result.current?.status).toBe('off')
  })
})
