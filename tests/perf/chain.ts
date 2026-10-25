import type { Rpc } from '@cancelchain/merchant-sim'

/**
 * What the runs do on chain, in Node, with the devnet keys.
 *
 * Sending and the merchant's catalog calls live in `merchant-sim`, which the demo
 * (`T056`) runs from as well; they are re-exported here so the runs keep one
 * import.
 */

export {
  authorityInitId,
  fundOwner,
  type Landed,
  merchantSignIn,
  namePlan,
  type Rpc,
  sendAndConfirm,
  signAndSendCompiled,
  sleep,
  waitConfirmed,
} from '@cancelchain/merchant-sim'

export function log(line: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${line}
`)
}

/** The chain's own time of the block that holds the transaction, in ms. Second resolution. */
export async function blockTimeMs(rpc: Rpc, slot: bigint): Promise<number> {
  const time = await rpc.getBlockTime(slot).send()
  if (time === null) throw new Error(`slot ${slot} has no block time`)
  return Number(time) * 1000
}
