import { generateKeyPairSigner, getBase58Decoder, signBytes } from '@solana/kit'
import { beforeAll, describe, expect, it } from 'vitest'
import { verifyWalletSignature } from './signin.js'

/**
 * Підпис гаманця над довільним текстом. Ключі тут справжні — підробка
 * перевіряла б не криптографію, а власну заглушку.
 */

const MESSAGE = new TextEncoder().encode('localhost wants you to sign in')

let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>
let signature: string

beforeAll(async () => {
  signer = await generateKeyPairSigner()
  const raw = await signBytes(signer.keyPair.privateKey, MESSAGE)
  signature = getBase58Decoder().decode(raw)
})

describe('verifyWalletSignature', () => {
  it('свій підпис над своїм текстом приймається', async () => {
    expect(
      await verifyWalletSignature({ address: signer.address, signature, message: MESSAGE }),
    ).toBe(true)
  })

  it('той самий підпис над іншим текстом — ні', async () => {
    const other = new TextEncoder().encode('localhost wants you to sign in ')
    expect(
      await verifyWalletSignature({ address: signer.address, signature, message: other }),
    ).toBe(false)
  })

  it('чужа адреса не підходить до чесного підпису', async () => {
    const stranger = await generateKeyPairSigner()
    expect(
      await verifyWalletSignature({ address: stranger.address, signature, message: MESSAGE }),
    ).toBe(false)
  })

  it('сміття замість підпису — це false, а не виняток', async () => {
    for (const bad of ['', 'not base58 at all 0OIl', signature.slice(0, -2), 'deadbeef']) {
      await expect(
        verifyWalletSignature({ address: signer.address, signature: bad, message: MESSAGE }),
      ).resolves.toBe(false)
    }
  })

  it('підпис правильної довжини, але не з цієї кривої — теж false', async () => {
    const noise = getBase58Decoder().decode(new Uint8Array(64).fill(7))
    expect(
      await verifyWalletSignature({ address: signer.address, signature: noise, message: MESSAGE }),
    ).toBe(false)
  })

  it('порожній текст підписується й перевіряється так само', async () => {
    const empty = new Uint8Array(0)
    const raw = await signBytes(signer.keyPair.privateKey, empty)
    const sig = getBase58Decoder().decode(raw)
    expect(
      await verifyWalletSignature({ address: signer.address, signature: sig, message: empty }),
    ).toBe(true)
  })
})
