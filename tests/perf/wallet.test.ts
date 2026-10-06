import { toAddress } from '@cancelchain/chain'
import { getAddressEncoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { STUB_WALLET_NAME, selectedWalletKey, stubWalletScript } from './wallet.js'

const OWNER = '5nhMcYQg8oUDvrAoVALzRYHbFkBjn8H76noiUMAWCy7a'

describe('stubWalletScript', () => {
  it('remembers the wallet the way @solana/react stores it, so the visit opens straight into the list', () => {
    expect(selectedWalletKey(OWNER)).toBe(`${STUB_WALLET_NAME}:${OWNER}`)
    expect(stubWalletScript(OWNER)).toContain(JSON.stringify(selectedWalletKey(OWNER)))
  })

  it('carries the public key bytes of exactly that address', () => {
    const bytes = JSON.stringify(Array.from(getAddressEncoder().encode(toAddress(OWNER))))
    expect(stubWalletScript(OWNER)).toContain(`new Uint8Array(${bytes})`)
  })

  it('cannot sign: the owner key never enters the browser', () => {
    const script = stubWalletScript(OWNER)
    expect(script).toContain('the measurement wallet does not sign')
    expect(script).not.toMatch(/privateKey|secretKey/)
  })

  it('is a script the browser can parse', () => {
    expect(() => new Function(stubWalletScript(OWNER))).not.toThrow()
  })
})
