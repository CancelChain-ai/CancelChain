/**
 * Amounts and addresses as people read them. Shared because two sides write
 * them for a person: the page, and the push the indexer sends (`T043`) — one
 * notification saying `10 USDC` while the card says `10.00 USDC` would be two
 * products.
 */

/** USDC has six decimals — a parameter of the mint itself, not a convention of ours. */
export const USDC_DECIMALS = 6

const MIN_FRACTION_DIGITS = 2

/** Smallest units → a decimal string. No `Number`: a u64 does not fit in a double. */
export function scaleAmount(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString(10)
  const unit = 10n ** BigInt(decimals)
  const whole = (amount / unit).toString(10)
  const fraction = (amount % unit).toString(10).padStart(decimals, '0')
  // Trailing zeros go, but two digits always stay: "24" instead of "24.00" in a
  // column of amounts reads as another order of magnitude.
  const trimmed = fraction.replace(/0+$/, '')
  const kept = Math.max(MIN_FRACTION_DIGITS, trimmed.length)
  return `${whole}.${fraction.slice(0, kept).padEnd(MIN_FRACTION_DIGITS, '0')}`
}

/**
 * An address for display: the first and the last characters. Nobody checks a
 * whole base58 address by eye, and a forgery trimmed at both ends shows — one
 * trimmed at one end does not.
 */
export function shortenAddress(address: string, edge = 4): string {
  return address.length <= edge * 2 + 1
    ? address
    : `${address.slice(0, edge)}…${address.slice(-edge)}`
}
