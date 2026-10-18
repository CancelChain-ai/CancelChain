// @vitest-environment jsdom
import type { DemoSnapshot } from '@cancelchain/shared/snapshot'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ReplayBar } from './ReplayBar'

afterEach(cleanup)

const OWNER = '5nhMcYQg8oUDvrAoVALzRYHbFkBjn8H76noiUMAWCy7a'
const GRANT =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
const CHARGE =
  '2T7gbY56USm9HtA8oD6dySKDQTnrmRocXJrkC3ErqFPQnkGQ7DrwEXyWF4X8H4TYqukBDicHaE82nL1LPoUsC33G'
const AT = '2026-10-18T09:15:34.528Z'

const SNAPSHOT: DemoSnapshot = {
  version: 1,
  cluster: 'devnet',
  recordedAt: AT,
  apiUrl: 'https://cancelchain-api.onrender.com',
  owner: OWNER,
  merchant: OWNER,
  mint: OWNER,
  steps: [
    {
      stage: 'before',
      label: 'Permission granted',
      signer: 'owner',
      signature: GRANT,
      outcome: 'confirmed',
      refusal: null,
    },
    {
      stage: 'after',
      label: 'Merchant charges the cancelled permission',
      signer: 'merchant',
      signature: CHARGE,
      outcome: 'refused',
      refusal: 'InvalidAccountOwner',
    },
  ],
  stages: [
    { id: 'before', title: 'Before cancelling', summary: 'Two.', recordedAt: AT, responses: {} },
    { id: 'after', title: 'After cancelling', summary: 'One.', recordedAt: AT, responses: {} },
  ],
}

function show(stageId: string, onStage: (id: string) => void = () => {}) {
  render(
    <ReplayBar
      snapshot={SNAPSHOT}
      stageId={stageId}
      onStage={onStage}
      explorerUrl={(signature) => `https://explorer.test/tx/${signature}`}
    />,
  )
}

describe('ReplayBar', () => {
  it('says it is a recording, not live, and who plays the merchant', () => {
    show('before')
    const text = screen.getByRole('region', { name: 'Recording' }).textContent ?? ''
    expect(text).toMatch(/A recording of devnet, made .* — not live\./)
    expect(text).toContain('merchant-sim')
  })

  it('lists the transactions up to the stage shown, not the ones after it', () => {
    show('before')
    expect(screen.queryByText(/Merchant charges the cancelled permission/)).toBeNull()
    cleanup()
    show('after')
    expect(screen.getByText(/Merchant charges the cancelled permission/).textContent).toContain(
      'InvalidAccountOwner',
    )
    expect(screen.getByText('Refused').className).toContain('text-rust')
  })

  it('links every transaction to the explorer', () => {
    show('after')
    const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(links).toEqual([
      `https://explorer.test/tx/${GRANT}`,
      `https://explorer.test/tx/${CHARGE}`,
    ])
  })

  it('switches the stage on request and marks the one shown', () => {
    const chosen: string[] = []
    show('before', (id) => chosen.push(id))
    const after = screen.getByRole('button', { name: '2. After cancelling' })
    expect(
      screen.getByRole('button', { name: '1. Before cancelling' }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(after.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(after)
    expect(chosen).toEqual(['after'])
  })
})
