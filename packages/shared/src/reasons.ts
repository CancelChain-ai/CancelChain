import { z } from 'zod'

/**
 * Скінченний перелік категорій відмови у списанні (`FR-015`, `SC-011`).
 *
 * Категорії `other` тут немає **навмисно**. `SC-011` вимагає, щоб частка
 * «інша помилка» дорівнювала нулю, а смітникова категорія перетворює цей вимір
 * на самообман: усе невідоме тихо стікає в неї, і показник лишається зеленим.
 * Якщо програма поверне код, якого ми не знаємо, подія пишеться з `reason = null`,
 * а воркер логує це як помилку мапінгу — дірка має бути видимою.
 *
 * Мапінг кодів програми в ці категорії додається сюди ж на `T040`.
 */
export const REJECT_REASONS = [
  'revoked',
  'cap_exceeded',
  'paused',
  'expired',
  'insufficient_funds',
  'wrong_mint',
  'not_due_yet',
] as const

export type RejectReason = (typeof REJECT_REASONS)[number]

export const rejectReasonSchema = z.enum(REJECT_REASONS)

/** `null` означає рівно одне: код програми нам невідомий. Не «інша причина». */
export const rejectReasonOrUnknownSchema = rejectReasonSchema.nullable()

/**
 * Формулювання для інтерфейсу. Мерчант і користувач бачать причину словами,
 * ніколи не кодом (`FR-015`).
 */
export const REJECT_REASON_LABELS = {
  revoked: 'Permission cancelled',
  cap_exceeded: 'Over the ceiling for this period',
  paused: 'Paused by the subscriber',
  expired: 'Permission expired',
  insufficient_funds: 'Not enough funds',
  wrong_mint: 'Wrong asset',
  not_due_yet: 'Too early — the period has not come round yet',
} as const satisfies Record<RejectReason, string>

/** Текст для невідомого коду. Каже правду, а не вигадує категорію. */
export const UNKNOWN_REJECT_REASON_LABEL = 'Rejected by the network — reason not recognised'

export function rejectReasonLabel(reason: RejectReason | null): string {
  return reason === null ? UNKNOWN_REJECT_REASON_LABEL : REJECT_REASON_LABELS[reason]
}
