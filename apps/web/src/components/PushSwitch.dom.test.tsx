// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PushControls } from '../lib/usePush'
import { PushSwitch } from './PushSwitch'

afterEach(cleanup)

function controls(overrides: Partial<PushControls> = {}) {
  const calls: string[] = []
  const value: PushControls = {
    status: 'off',
    busy: false,
    error: null,
    enable: () => calls.push('enable'),
    disable: () => calls.push('disable'),
    ...overrides,
  }
  return { value, calls }
}

describe('PushSwitch', () => {
  it('shows nothing where there is no switch, or while it is being checked', () => {
    const { container, rerender } = render(<PushSwitch push={null} />)
    expect(container.textContent).toBe('')
    rerender(<PushSwitch push={controls({ status: 'checking' }).value} />)
    expect(container.textContent).toBe('')
  })

  it('offers to turn notifications on, and says what they are about', () => {
    const { value, calls } = controls()
    render(<PushSwitch push={value} />)
    fireEvent.click(screen.getByRole('button', { name: 'Notify me in this browser' }))
    expect(calls).toEqual(['enable'])
    expect(screen.getByText('Before a charge is due, and when one is refused.')).toBeTruthy()
  })

  it('turns off from the on state', () => {
    const { value, calls } = controls({ status: 'on' })
    render(<PushSwitch push={value} />)
    expect(screen.getByText(/Notifications on in this browser/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'turn off' }))
    expect(calls).toEqual(['disable'])
  })

  it('holds the button while a change runs', () => {
    render(<PushSwitch push={controls({ busy: true }).value} />)
    const button = screen.getByRole('button', { name: 'Turning notifications on…' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it.each([
    ['unsupported', /cannot show notifications/],
    ['disabled', /not set up on this server/],
    ['blocked', /blocked for this site/],
  ] as const)('names %s, with no button, and promises the feed (FR-027)', (status, text) => {
    render(<PushSwitch push={controls({ status }).value} />)
    expect(screen.getByText(text).textContent).toMatch(/in the feed either way/)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says why a change did not happen', () => {
    render(<PushSwitch push={controls({ error: 'We could not reach CancelChain.' }).value} />)
    expect(screen.getByRole('alert').textContent).toBe('We could not reach CancelChain.')
  })
})
