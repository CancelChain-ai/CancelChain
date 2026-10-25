import { type ChainClient, findSubscriptionAuthority, toBlockhash } from '@cancelchain/chain'
import {
  type Address,
  appendTransactionMessageInstruction,
  type compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  type Signature,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  signTransactionMessageWithSigners,
  type Transaction,
  type TransactionMessageWithBlockhashLifetime,
  type TransactionMessageWithFeePayerSigner,
  type TransactionSigner,
} from '@solana/kit'
import { getSubscriptionAuthorityDecoder } from '@solana/subscriptions'
import { getTransferSolInstruction } from '@solana-program/system'

/**
 * Sending with the devnet keys, in Node: the demo (`T056`) and the measured runs
 * in `tests/perf` both stand on it.
 *
 * Every send waits for the network's verdict before the next one: a run that
 * fires and forgets would build on transactions that may never have landed.
 */

export type Rpc = ChainClient['rpc']

type Message = Parameters<typeof compileTransaction>[0] &
  TransactionMessageWithBlockhashLifetime &
  TransactionMessageWithFeePayerSigner

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export type Landed = {
  signature: Signature
  slot: bigint
  /** When this process first saw the transaction confirmed. */
  confirmedAt: number
}

/** Polls the signature until it is confirmed. A failed transaction throws with its error. */
export async function waitConfirmed(
  rpc: Rpc,
  signature: Signature,
  label: string,
  pollMs = 400,
  timeoutMs = 60_000,
): Promise<Landed> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send()
    const status = value[0]
    if (status !== null && status !== undefined) {
      if (status.err !== null) {
        throw new Error(`${label} failed on chain: ${JSON.stringify(status.err)} (${signature})`)
      }
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return { signature, slot: status.slot, confirmedAt: Date.now() }
      }
    }
    await sleep(pollMs)
  }
  throw new Error(`${label} was sent but never confirmed (${signature})`)
}

/** Builds, signs with every signer the instructions name, sends and waits. */
export async function sendAndConfirm(
  rpc: Rpc,
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
  label: string,
): Promise<Landed> {
  const { value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const message = instructions.reduce<Message>(
    (carry, instruction) => appendTransactionMessageInstruction(instruction, carry),
    pipe(
      createTransactionMessage({ version: 0 }),
      (draft) => setTransactionMessageFeePayerSigner(feePayer, draft),
      (draft) =>
        setTransactionMessageLifetimeUsingBlockhash(
          {
            blockhash: toBlockhash(value.blockhash),
            lastValidBlockHeight: value.lastValidBlockHeight,
          },
          draft,
        ),
    ),
  )
  const signed = await signTransactionMessageWithSigners(message)
  const signature = getSignatureFromTransaction(signed)
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send()
  return waitConfirmed(rpc, signature, label)
}

/**
 * Signs an already compiled transaction with the owner's key and sends it — the
 * way a wallet does with what the app hands it (`buildRevokeTransaction`). The
 * bytes signed are the ones the browser would have signed.
 */
export async function signAndSendCompiled(
  rpc: Rpc,
  transaction: Transaction,
  signer: KeyPairSigner,
  label: string,
): Promise<Landed> {
  const signed = await signTransaction([signer.keyPair], transaction)
  const signature = getSignatureFromTransaction(signed)
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send()
  return waitConfirmed(rpc, signature, label)
}

/**
 * The owner's authority `initId` in this mint, or `null` while it does not exist.
 * The first grant creates it in the same transaction.
 */
export async function authorityInitId(
  rpc: Rpc,
  owner: Address,
  mint: Address,
): Promise<bigint | null> {
  const { address } = await findSubscriptionAuthority({ tokenMint: mint, user: owner })
  const { value } = await rpc.getAccountInfo(address, { encoding: 'base64' }).send()
  if (value === null) return null
  const bytes = Uint8Array.from(Buffer.from(value.data[0], 'base64'))
  return getSubscriptionAuthorityDecoder().decode(bytes).initId
}

/** Tops the owner up from the merchant when it holds less than `atLeast` lamports. */
export async function fundOwner(
  merchant: { chain: { rpc: Rpc }; signer: KeyPairSigner },
  owner: Address,
  atLeast: bigint,
  topUpTo: bigint,
): Promise<bigint> {
  const { value: balance } = await merchant.chain.rpc.getBalance(owner).send()
  if (balance >= atLeast) return balance
  await sendAndConfirm(
    merchant.chain.rpc,
    merchant.signer,
    [
      getTransferSolInstruction({
        amount: topUpTo - balance,
        destination: owner,
        source: merchant.signer,
      }),
    ],
    'owner funded',
  )
  return topUpTo
}
