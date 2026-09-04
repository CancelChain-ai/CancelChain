import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from '@solana/kit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  KEYPAIR_BYTE_LENGTH,
  KeypairFileError,
  loadMerchantSigner,
  parseKeypairBytes,
} from './keypair.js'

/** Формат Solana CLI: 32 байти приватного ключа, далі 32 байти публічного. */
async function keypairFileBytes(seed: Uint8Array): Promise<number[]> {
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed)
  const publicBytes = getAddressEncoder().encode(signer.address)
  return [...seed, ...publicBytes]
}

const SEED = new Uint8Array(32).fill(7)

let directory = ''

beforeAll(async () => {
  // Тимчасова тека поза репозиторієм — так само, як живе справжній ключ.
  directory = await mkdtemp(join(tmpdir(), 'merchant-sim-'))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function writeKeypair(name: string, contents: string): Promise<string> {
  const path = join(directory, name)
  await writeFile(path, contents, 'utf8')
  return path
}

describe('parseKeypairBytes', () => {
  it('читає 64 байти', () => {
    const bytes = parseKeypairBytes(JSON.stringify(new Array(KEYPAIR_BYTE_LENGTH).fill(1)))
    expect(bytes).toHaveLength(KEYPAIR_BYTE_LENGTH)
  })

  it('не JSON — названа помилка, а не SyntaxError назовні', () => {
    expect(() => parseKeypairBytes('nope')).toThrow(KeypairFileError)
  })

  it('не масив', () => {
    expect(() => parseKeypairBytes('{"secret":[1,2,3]}')).toThrow(/array of bytes/)
  })

  it('інша довжина — 32 байти приватного ключа сюди не годяться', () => {
    expect(() => parseKeypairBytes(JSON.stringify(new Array(32).fill(1)))).toThrow(/64 bytes/)
  })

  it('значення поза діапазоном байта названо індексом', () => {
    const values = new Array(KEYPAIR_BYTE_LENGTH).fill(1)
    values[9] = 256
    expect(() => parseKeypairBytes(JSON.stringify(values))).toThrow(/index 9/)
  })

  it('повідомлення про помилку не несе самих байтів', () => {
    const values = new Array(63).fill(251)
    let message = ''
    try {
      parseKeypairBytes(JSON.stringify(values))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('63')
    expect(message).not.toContain('251')
  })
})

describe('loadMerchantSigner', () => {
  it('читає ключ і віддає підписувача з тією самою адресою', async () => {
    const expected = await createKeyPairSignerFromPrivateKeyBytes(SEED)
    const path = await writeKeypair(
      'merchant-devnet.keypair.json',
      JSON.stringify(await keypairFileBytes(SEED)),
    )
    const signer = await loadMerchantSigner(path)
    expect(signer.address).toBe(expected.address)
  })

  it('приватна частина непритягувана — навіть наш код не серіалізує її в лог', async () => {
    const path = await writeKeypair(
      'extractable.keypair.json',
      JSON.stringify(await keypairFileBytes(SEED)),
    )
    const signer = await loadMerchantSigner(path)
    expect(signer.keyPair.privateKey.extractable).toBe(false)
  })

  it('публічна половина, що не відповідає приватній, не проходить', async () => {
    const bytes = await keypairFileBytes(SEED)
    bytes[KEYPAIR_BYTE_LENGTH - 1] = (bytes[KEYPAIR_BYTE_LENGTH - 1] ?? 0) ^ 0xff
    const path = await writeKeypair('mismatched.keypair.json', JSON.stringify(bytes))
    await expect(loadMerchantSigner(path)).rejects.toThrow()
  })

  it('чуже ім’я файлу зупиняється до читання з диска', async () => {
    // `id.json` теж у .gitignore, але патерн продукту один — і він перевіряється.
    await expect(loadMerchantSigner(join(directory, 'id.json'))).rejects.toThrow(
      /keypair file name/,
    )
  })

  it('файлу немає — помилка каже, де живе ключ і як його зробити', async () => {
    await expect(loadMerchantSigner(join(directory, 'missing.keypair.json'))).rejects.toThrow(
      /solana-keygen new/,
    )
  })
})
