import type { Address } from '@cancelchain/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createApiClient } from './api.js'
import {
  createPushController,
  type PushController,
  PushFailure,
  type PushStatus,
  storedFollowedWallets,
  windowBrowserPush,
} from './push.js'
import { apiBaseUrlFromEnv, source } from './source.js'

/**
 * The push switch of the connected wallet (`T043`). `null` — there is no switch
 * to show: no wallet, or no network behind the source (the M0 mock).
 */
export type PushControls = {
  status: PushStatus | 'checking'
  busy: boolean
  /** Why the last change did not happen, in words. */
  error: string | null
  enable(): void
  disable(): void
}

let shared: PushController | null = null

/** Built on first use: the page that never opens the list never touches the worker. */
function defaultController(): PushController {
  shared ??= createPushController({
    api: createApiClient(apiBaseUrlFromEnv(import.meta.env), (input, init) => fetch(input, init)),
    browser: windowBrowserPush(import.meta.env.BASE_URL),
    followed: storedFollowedWallets(),
  })
  return shared
}

const describe = (error: unknown) =>
  error instanceof PushFailure ? error.message : 'Notifications could not be changed here.'

export function usePush(
  owner: Address | null,
  controller: () => PushController = defaultController,
): PushControls | null {
  const enabled = source.onNetwork && owner !== null
  const [status, setStatus] = useState<PushStatus | 'checking'>('checking')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A switch flipped for one wallet must not land on the next one connected.
  const ownerNow = useRef(owner)
  ownerNow.current = owner

  useEffect(() => {
    if (!source.onNetwork || owner === null) return
    let current = true
    setStatus('checking')
    setError(null)
    controller()
      .status(owner)
      .then((next) => {
        if (current) setStatus(next)
      })
      .catch((failure: unknown) => {
        if (!current) return
        setStatus('off')
        setError(describe(failure))
      })
    return () => {
      current = false
    }
  }, [owner, controller])

  const change = useCallback(
    (action: 'enable' | 'disable') => {
      if (owner === null || busy) return
      const target = owner
      setBusy(true)
      setError(null)
      controller()
        [action](target)
        .then((next) => {
          if (ownerNow.current === target) setStatus(next)
        })
        .catch((failure: unknown) => {
          if (ownerNow.current === target) setError(describe(failure))
        })
        .finally(() => setBusy(false))
    },
    [owner, busy, controller],
  )

  if (!enabled) return null
  return {
    status,
    busy,
    error,
    enable: () => change('enable'),
    disable: () => change('disable'),
  }
}
