import type { Address, Signature, SignatureBytes } from '@solana/kit'
import { getAddressEncoder, getBase58Encoder, verifySignature } from '@solana/kit'

/**
 * Перевірка підпису гаманця над довільним текстом — серверна половина входу
 * мерчанта (`T035`).
 *
 * Живе в `packages/chain`, а не в `apps/api`, з однієї причини: тут уже стоїть
 * `@solana/kit`, і другий kit поруч дав би дві копії branded-типів адреси —
 * рівно той мовчазний розкол, про який попереджає `versions.test.ts`.
 *
 * **Що саме доводить успіх.** Лише володіння приватним ключем до цієї адреси в
 * момент підпису — і нічого більше. Що підписано свіже, що домен той, і що
 * цей самий підпис не приходив уже вдруге, вирішує викликач: ключ таких
 * питань не ставить.
 *
 * Підписи гаманців-мультипідписів (`squads` і подібні) ця перевірка не
 * приймає — у них підписує не ключ адреси. Це відомий виняток, а не недогляд:
 * ончейн-перевірка такого підпису потребує читання акаунта і виходить за межі
 * входу в панель.
 */

const ED25519 = 'Ed25519' as const
const SIGNATURE_BYTES = 64

/**
 * Публічний ключ адреси у вигляді, який розуміє WebCrypto. Ключ **не** можна
 * експортувати назад — `extractable: false`: тут він потрібен рівно на одну
 * перевірку.
 */
async function importAddressKey(address: Address) {
  // Копія, а не сам результат кодувальника: WebCrypto хоче буфер, яким володіє
  // рівно цей масив, і типи браузера та Node сходяться тільки на такому.
  const bytes = new Uint8Array(getAddressEncoder().encode(address))
  return crypto.subtle.importKey('raw', bytes, ED25519, false, ['verify'])
}

export type VerifyWalletSignatureInput = {
  address: Address
  /** Base58, як його віддає гаманець і як його описує `signatureSchema`. */
  signature: Signature | string
  /** Рівно ті байти, які бачив гаманець. */
  message: Uint8Array
}

/**
 * `true` — підпис належить цій адресі. Будь-яка інша відповідь — `false`, і
 * ніколи виняток: невалідний base58, не 64 байти, не та точка кривої — усе це
 * випадки «підпис не підійшов», а не збої сервера. Кидати тут означало б
 * віддавати `500` на кривому тілі запиту, тобто плутати чужу помилку зі своєю.
 */
export async function verifyWalletSignature(input: VerifyWalletSignatureInput): Promise<boolean> {
  try {
    const signature = getBase58Encoder().encode(input.signature) as SignatureBytes
    if (signature.length !== SIGNATURE_BYTES) return false
    const key = await importAddressKey(input.address)
    return await verifySignature(key, signature, input.message)
  } catch {
    return false
  }
}
