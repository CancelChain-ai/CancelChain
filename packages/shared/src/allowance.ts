import { z } from 'zod'
import {
  addressSchema,
  signatureSchema,
  slotSchema,
  timestampSchema,
  u64Schema,
} from './primitives.js'
import { rejectReasonOrUnknownSchema } from './reasons.js'

/**
 * Три моделі авторизації нативного примітиву:
 * `fixed` — разова стеля з опційним терміном; `recurring` — стеля, що скидається
 * з періодом; `subscription` — підписка за планом мерчанта. Пауза й «не поновлювати»
 * існують **тільки** для `subscription` (`FR-011`, `FR-028`).
 */
export const ALLOWANCE_KINDS = ['fixed', 'recurring', 'subscription'] as const
export type AllowanceKind = (typeof ALLOWANCE_KINDS)[number]
export const allowanceKindSchema = z.enum(ALLOWANCE_KINDS)

export const ALLOWANCE_STATUSES = ['active', 'paused', 'revoked', 'exhausted'] as const
export type AllowanceStatus = (typeof ALLOWANCE_STATUSES)[number]
export const allowanceStatusSchema = z.enum(ALLOWANCE_STATUSES)

const allowanceFields = {
  pda: addressSchema,
  owner: addressSchema,
  delegate: addressSchema,
  mint: addressSchema,
  kind: allowanceKindSchema,
  capAmount: u64Schema,
  /** `null` лише для `fixed`: разова стеля періоду не має. */
  periodSeconds: z.number().int().positive().nullable(),
  spentInPeriod: u64Schema,
  periodStartedAt: timestampSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
  /** `FR-011` — лише `subscription`. */
  pausedAt: timestampSchema.nullable(),
  /** `FR-028` — лише `subscription`; до цієї дати дозвіл лишається активним. */
  endsAt: timestampSchema.nullable(),
  status: allowanceStatusSchema,
  planPda: addressSchema.nullable(),
  lastSlot: slotSchema,
  syncedAt: timestampSchema,
}

/**
 * Інваріанти форми дозволу.
 *
 * Чого тут свідомо **немає**: перевірки `spentInPeriod <= capAmount`. Ончейн її
 * тримає програма (`FR-009`), а тут вона означала б, що розбіжний стан не
 * пройде валідацію й не дійде до екрана. `FR-025` вимагає протилежного:
 * розбіжність показується, а не ховається.
 */
function checkAllowance(
  value: {
    kind: AllowanceKind
    status: AllowanceStatus
    periodSeconds: number | null
    periodStartedAt: string | null
    pausedAt: string | null
    endsAt: string | null
  },
  ctx: z.RefinementCtx,
): void {
  const periodic = value.kind !== 'fixed'

  if (periodic && value.periodSeconds === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['periodSeconds'],
      message: `a ${value.kind} allowance must have a period`,
    })
  }
  if (!periodic && value.periodSeconds !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['periodSeconds'],
      message: 'a fixed allowance has no period',
    })
  }
  if (!periodic && value.periodStartedAt !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['periodStartedAt'],
      message: 'a fixed allowance has no period to start',
    })
  }

  if (value.pausedAt !== null && value.kind !== 'subscription') {
    ctx.addIssue({
      code: 'custom',
      path: ['pausedAt'],
      message: 'only a plan subscription can be paused (FR-011)',
    })
  }
  if (value.endsAt !== null && value.kind !== 'subscription') {
    ctx.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'only a plan subscription can be scheduled to end (FR-028)',
    })
  }

  if (value.status === 'paused' && value.pausedAt === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['pausedAt'],
      message: 'a paused allowance must say when it was paused',
    })
  }
  if (value.status !== 'paused' && value.pausedAt !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'an allowance with a pause timestamp must have status "paused"',
    })
  }
}

export const allowanceSchema = z.object(allowanceFields).superRefine(checkAllowance)
export type Allowance = z.infer<typeof allowanceSchema>

/**
 * Те, що прочитано з мережі просто зараз (`FR-024`). `null` — акаунта в мережі
 * немає: дозвіл закрито, і саме це показується замість збереженого стану.
 */
export const allowanceChainStateSchema = z
  .object({
    status: allowanceStatusSchema,
    capAmount: u64Schema,
    spentInPeriod: u64Schema,
    periodStartedAt: timestampSchema.nullable(),
    pausedAt: timestampSchema.nullable(),
    endsAt: timestampSchema.nullable(),
    slot: slotSchema,
  })
  .nullable()

export type AllowanceChainState = z.infer<typeof allowanceChainStateSchema>

/** Картка дозволу: збережений стан плюс звірка з мережею (`FR-022`, `FR-025`). */
export const allowanceDetailSchema = z
  .object({
    ...allowanceFields,
    chainState: allowanceChainStateSchema,
    diverged: z.boolean(),
  })
  .superRefine(checkAllowance)

export type AllowanceDetail = z.infer<typeof allowanceDetailSchema>

export const EVENT_KINDS = [
  'created',
  'charged',
  'rejected',
  'paused',
  'resumed',
  'revoked',
] as const
export type EventKind = (typeof EVENT_KINDS)[number]
export const eventKindSchema = z.enum(EVENT_KINDS)

export const eventSchema = z
  .object({
    id: u64Schema,
    allowancePda: addressSchema,
    kind: eventKindSchema,
    amount: u64Schema.nullable(),
    /** Заповнена лише у відмови; `null` там означає невідомий код програми. */
    reason: rejectReasonOrUnknownSchema,
    signature: signatureSchema,
    slot: slotSchema,
    blockTime: timestampSchema,
  })
  .superRefine((value, ctx) => {
    if (value.reason !== null && value.kind !== 'rejected') {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'only a rejected attempt carries a reason',
      })
    }
    if (value.kind === 'charged' && value.amount === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'a charge must say how much was taken',
      })
    }
  })

export type AllowanceEvent = z.infer<typeof eventSchema>

export const planSchema = z.object({
  pda: addressSchema,
  merchant: addressSchema,
  planId: u64Schema,
  name: z.string().min(1).max(64),
  amount: u64Schema,
  periodSeconds: z.number().int().positive(),
  mint: addressSchema,
  createdAt: timestampSchema,
})

export type Plan = z.infer<typeof planSchema>

export const merchantSchema = z.object({
  address: addressSchema,
  displayName: z.string().min(1).max(64),
  createdAt: timestampSchema,
})

export type Merchant = z.infer<typeof merchantSchema>
