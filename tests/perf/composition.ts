/**
 * What the measured wallet holds: 100 permissions of all three kinds (owner's
 * decision 2026-10-07), because the list draws all three — a plan subscription
 * carries the plan's name and terms, a recurring permission a period, a fixed one
 * only a cap. A wallet of one kind would time one kind of card.
 *
 * `SC-009` revokes fixed and recurring permissions only: revoking them closes the
 * account, so the card must leave the list. A subscription is cancelled to the end
 * of its paid period and stays until then by design — it is not "a cancelled
 * permission still shown as active".
 */

export type KindCounts = { subscription: number; recurring: number; fixed: number }

export const TARGET: KindCounts = { subscription: 20, recurring: 55, fixed: 25 }

export const TARGET_TOTAL = TARGET.subscription + TARGET.recurring + TARGET.fixed

/** How many of each kind to grant so the wallet holds the target again. Never negative. */
export function missing(current: KindCounts, target: KindCounts = TARGET): KindCounts {
  return {
    subscription: Math.max(0, target.subscription - current.subscription),
    recurring: Math.max(0, target.recurring - current.recurring),
    fixed: Math.max(0, target.fixed - current.fixed),
  }
}

export function countKinds(kinds: readonly string[]): KindCounts {
  const counts: KindCounts = { subscription: 0, recurring: 0, fixed: 0 }
  for (const kind of kinds) {
    if (kind === 'subscription' || kind === 'recurring' || kind === 'fixed') counts[kind] += 1
  }
  return counts
}

/** Invented merchants for the plans. Synthetic, as everything but the chain is before the demo. */
const PLAN_NAMES = [
  'Northwind Music',
  'Paper Lantern News',
  'Orbit Cloud Storage',
  'Lumen Fitness',
  'Copperleaf Recipes',
  'Harbor VPN',
  'Quill Writing Pro',
  'Tidepool Podcasts',
  'Atlas Maps Plus',
  'Fernhill Language Club',
]

/** A name for the n-th plan; repeats get a number so two cards never read the same. */
export function planName(index: number): string {
  const base = PLAN_NAMES[index % PLAN_NAMES.length] as string
  const round = Math.floor(index / PLAN_NAMES.length)
  return round === 0 ? base : `${base} ${round + 1}`
}

const USDC = 1_000_000n

/** Monthly price of the n-th plan: 3.99 … 21.99, spread so the cards differ. */
export function planAmount(index: number): bigint {
  return BigInt(3 + (index % 10) * 2) * USDC + 990_000n
}

/** Cap of the n-th recurring or fixed permission: 5 … 95 USDC. */
export function capAmount(index: number): bigint {
  return BigInt(5 + (index % 10) * 10) * USDC
}

/** Recurring periods: a week, a month, a quarter — the periods the screen words. */
export const RECURRING_PERIODS_SECONDS = [604_800, 2_592_000, 7_776_000] as const

export function recurringPeriod(index: number): number {
  return RECURRING_PERIODS_SECONDS[index % RECURRING_PERIODS_SECONDS.length] as number
}
