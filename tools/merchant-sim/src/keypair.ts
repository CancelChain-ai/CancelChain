import { readFile } from 'node:fs/promises'
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit'
import { KEYPAIR_FILE_SUFFIX } from './config.js'

/**
 * Читання devnet-ключа з файлу формату Solana CLI: JSON-масив із 64 байтів
 * (32 приватні + 32 публічні).
 *
 * Ключ **не витягується назад**: `createKeyPairSignerFromBytes` за замовчуванням
 * робить `CryptoKey` з `extractable: false`, тож навіть наш власний код не може
 * серіалізувати приватну частину в лог чи в помилку. Прапорець `extractable`
 * тут не пробрасується навмисно — потреби в ньому немає, а можливість була б.
 */

export const KEYPAIR_BYTE_LENGTH = 64

export class KeypairFileError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options)
    this.name = 'KeypairFileError'
  }
}

/**
 * Розбір вмісту файлу. Винесено окремо від читання з диска, щоб перевірятися
 * без файлової системи — і щоб жодне повідомлення про помилку не несло самих
 * байтів: діагностика тут — це довжина й тип, ніколи не значення.
 */
export function parseKeypairBytes(contents: string): Uint8Array {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (cause) {
    throw new KeypairFileError('keypair file is not valid JSON', { cause })
  }
  if (!Array.isArray(parsed)) {
    throw new KeypairFileError('keypair file must contain a JSON array of bytes')
  }
  if (parsed.length !== KEYPAIR_BYTE_LENGTH) {
    throw new KeypairFileError(
      `keypair file must contain ${KEYPAIR_BYTE_LENGTH} bytes, got ${parsed.length}`,
    )
  }
  const bytes = new Uint8Array(KEYPAIR_BYTE_LENGTH)
  for (const [index, value] of parsed.entries()) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
      throw new KeypairFileError(`keypair file has a non-byte value at index ${index}`)
    }
    bytes[index] = value
  }
  return bytes
}

export async function loadMerchantSigner(keypairPath: string): Promise<KeyPairSigner> {
  if (!keypairPath.endsWith(KEYPAIR_FILE_SUFFIX)) {
    throw new KeypairFileError(
      `keypair file name must end with "${KEYPAIR_FILE_SUFFIX}": ${keypairPath}`,
    )
  }
  let contents: string
  try {
    contents = await readFile(keypairPath, 'utf8')
  } catch (cause) {
    throw new KeypairFileError(
      `cannot read the keypair at ${keypairPath}. The devnet key lives outside the repository ` +
        'and is never committed; generate one with `solana-keygen new -o <path>`.',
      { cause },
    )
  }
  return createKeyPairSignerFromBytes(parseKeypairBytes(contents))
}
