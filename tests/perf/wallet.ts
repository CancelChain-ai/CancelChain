import { toAddress } from '@cancelchain/chain'
import { getAddressEncoder } from '@solana/kit'

/**
 * A wallet-standard wallet that only knows an address, injected before the app loads.
 *
 * The measured screens read; they never sign. A stub that can connect but refuses
 * to sign is enough to open the owner's dashboard, and it keeps the owner's key out
 * of the browser entirely: grants and revocations are signed by the run in Node.
 *
 * The app's remembered selection is written first, so a sample opens the way a
 * returning visitor's visit does — straight into the list, with no click whose
 * timing would be the harness's, not the product's.
 */

export const STUB_WALLET_NAME = 'Stub Wallet'

/** `@solana/react`'s storage key (`cancelchain:selected-wallet` in `apps/web/src/chain/wallet.ts`). */
const SELECTED_WALLET_STORAGE_KEY = 'cancelchain:selected-wallet'

/** `getUiWalletAccountStorageKey`: the wallet's name (colons replaced), a colon, the address. */
export function selectedWalletKey(address: string): string {
  return `${STUB_WALLET_NAME.replace(':', '_')}:${address}`
}

const ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4='

export function stubWalletScript(address: string, chain = 'solana:devnet'): string {
  const publicKey = Array.from(getAddressEncoder().encode(toAddress(address)))
  return `(() => {
  try { localStorage.setItem(${JSON.stringify(SELECTED_WALLET_STORAGE_KEY)}, ${JSON.stringify(selectedWalletKey(address))}) } catch {}
  const refuse = async () => { throw new Error('the measurement wallet does not sign') }
  const account = { address: ${JSON.stringify(address)}, publicKey: new Uint8Array(${JSON.stringify(publicKey)}),
    chains: [${JSON.stringify(chain)}], features: ['solana:signAndSendTransaction', 'solana:signTransaction'] }
  const wallet = { version: '1.0.0', name: ${JSON.stringify(STUB_WALLET_NAME)}, icon: ${JSON.stringify(ICON)},
    chains: [${JSON.stringify(chain)}], accounts: [account],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => {} },
      'standard:events': { version: '1.0.0', on: () => () => {} },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: refuse },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: refuse },
    } }
  const register = ({ register }) => register(wallet)
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register })) } catch {}
  window.addEventListener('wallet-standard:app-ready', (event) => register(event.detail))
})()`
}
