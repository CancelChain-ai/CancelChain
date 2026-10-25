import { toAddress } from '@cancelchain/chain'
import { type SignInResponse, signInMessageText, signInResponseSchema } from '@cancelchain/shared'
import { getBase58Decoder, type KeyPairSigner, signBytes } from '@solana/kit'

/**
 * The merchant's side of the catalog (`T035`): a plan's name lives in the API,
 * not on chain, so the subscribe screen and the list can only show one that the
 * merchant registered here, signed in with its own key.
 */

/** Sign-in with Solana as the merchant. `domain` is the API's `AUTH_DOMAIN`. */
export async function merchantSignIn(
  apiUrl: string,
  domain: string,
  signer: KeyPairSigner,
): Promise<SignInResponse> {
  const message = {
    domain,
    address: signer.address,
    nonce: crypto.randomUUID().replaceAll('-', ''),
    issuedAt: new Date().toISOString(),
  }
  const bytes = new TextEncoder().encode(signInMessageText(message))
  const signature = getBase58Decoder().decode(await signBytes(signer.keyPair.privateKey, bytes))
  const response = await fetch(`${apiUrl}/v1/merchants/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  })
  if (!response.ok) throw new Error(`merchant sign-in: ${response.status} ${await response.text()}`)
  return signInResponseSchema.parse(await response.json())
}

export async function namePlan(
  apiUrl: string,
  token: string,
  planPda: string,
  name: string,
): Promise<void> {
  const response = await fetch(`${apiUrl}/v1/merchants/plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ planPda: toAddress(planPda), name }),
  })
  if (!response.ok) throw new Error(`plan name: ${response.status} ${await response.text()}`)
}
