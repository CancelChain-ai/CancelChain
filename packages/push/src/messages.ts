import {
  addressSchema,
  type RejectReason,
  rejectReasonLabel,
  scaleAmount,
  shortenAddress,
  timestampSchema,
  USDC_DECIMALS,
} from '@cancelchain/shared'
import { z } from 'zod'

/**
 * What one push carries (`T043`): the text is written here, on the server, and
 * the service worker (`apps/web/public/sw.js`) only shows it.
 *
 * Except for one thing the server cannot know — the reader's clock. `at` is the
 * moment a notification is about, and `{at}` in the title or the body is where
 * the worker writes it in the browser's own time zone and language. A server
 * that wrote "14:00" would be writing UTC to someone in Kyiv.
 *
 * `allowance` opens that permission's card on click; `tag` lets a newer push
 * about the same thing replace the older one instead of piling up.
 *
 * Every word in here is public on the chain already: an address, an amount, a
 * reason. No name of a person — there is none to give (`FR-018`).
 */
export const AT_TOKEN = '{at}'

export const PUSH_MESSAGE_KINDS = ['welcome', 'upcoming', 'rejected'] as const

export const pushMessageSchema = z.object({
  kind: z.enum(PUSH_MESSAGE_KINDS),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(400),
  at: timestampSchema.nullable(),
  allowance: addressSchema.nullable(),
  tag: z.string().min(1).max(100),
})

export type PushMessage = z.infer<typeof pushMessageSchema>

/** Who stands on the other side, as the card names it (`apps/web/src/lib/view.ts`). */
type Counterparty = {
  kind: 'fixed' | 'recurring' | 'subscription'
  delegate: string
  planPda: string | null
}

function counterparty({ kind, delegate, planPda }: Counterparty): string {
  return kind === 'subscription'
    ? `Merchant plan ${shortenAddress(planPda ?? delegate)}`
    : `Merchant wallet ${shortenAddress(delegate)}`
}

type Asset = { mint: string; usdcMint: string }

/** The card's `formatMoney`: an asset we do not know is not given decimals it may not have. */
function money(amount: bigint, { mint, usdcMint }: Asset): string {
  return mint === usdcMint
    ? `${scaleAmount(amount, USDC_DECIMALS)} USDC`
    : `${amount.toString(10)} of ${shortenAddress(mint)}`
}

export function welcomeMessage(owner: string): PushMessage {
  return {
    kind: 'welcome',
    title: 'Notifications are on',
    body: `This browser will hear about charges due and refused charges for wallet ${shortenAddress(owner)}.`,
    at: null,
    allowance: null,
    tag: `welcome:${owner}`,
  }
}

export type UpcomingCharge = Counterparty &
  Asset & {
    pda: string
    capAmount: bigint
    /** When the next period opens and the merchant may charge again. */
    dueAt: string
  }

/**
 * A charge is due (`FR-018`, "in advance"). "May take up to" and not "will
 * take": the chain only opens the period, the merchant decides whether to pull,
 * and how much — up to the ceiling.
 */
export function upcomingMessage(charge: UpcomingCharge): PushMessage {
  return {
    kind: 'upcoming',
    title: `Charge due ${AT_TOKEN}`,
    body: `${counterparty(charge)} may take up to ${money(charge.capAmount, charge)}. Cancel before then and the attempt will be refused.`,
    at: charge.dueAt,
    allowance: charge.pda,
    tag: `upcoming:${charge.pda}`,
  }
}

export type RefusedCharge = Counterparty &
  Asset & {
    pda: string
    /** What the merchant tried to take; `null` when the refused instruction did not say. */
    amount: bigint | null
    reason: RejectReason | null
    blockTime: string
  }

/** A charge was refused (`FR-018`, "after the fact"), in the feed's words (`FR-015`). */
export function rejectedMessage(charge: RefusedCharge): PushMessage {
  const tried = charge.amount === null ? 'tried to charge' : `tried ${money(charge.amount, charge)}`
  return {
    kind: 'rejected',
    title: 'Charge refused',
    body: `${counterparty(charge)} ${tried} at ${AT_TOKEN}: ${rejectReasonLabel(charge.reason)}.`,
    at: charge.blockTime,
    allowance: charge.pda,
    tag: `rejected:${charge.pda}`,
  }
}
