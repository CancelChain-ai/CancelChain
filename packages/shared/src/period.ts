/**
 * Довжина періоду. Одиниці в мережі різні, і це головна пастка проєкту:
 *
 * - `PlanTerms.periodHours` — **години** (план мерчанта);
 * - `RecurringDelegation.periodLengthS` — **секунди** (періодичний дозвіл).
 *
 * У БД колонка одна — `period_seconds`. Тому конвертація тут явна, названа
 * функцією й покрита тестом: тиха помилка в 3600 разів перетворює місячну
 * підписку на щохвилинну, і жодна перевірка нижче за течією її не спіймає.
 */

export const SECONDS_PER_HOUR = 3600

function assertWholePositive(value: number, unit: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`period in ${unit} must be a whole number, got ${value}`)
  }
  if (value <= 0) {
    throw new RangeError(`period in ${unit} must be positive, got ${value}`)
  }
}

/** Години плану → секунди для сховища. */
export function periodSecondsFromHours(hours: number): number {
  assertWholePositive(hours, 'hours')
  return hours * SECONDS_PER_HOUR
}

/**
 * Секунди сховища → години плану.
 *
 * Кидає, якщо секунди не діляться на годину націло. Округлити тут означало б
 * показати мерчанту не той період, за яким його план справді працює.
 */
export function periodHoursFromSeconds(seconds: number): number {
  assertWholePositive(seconds, 'seconds')
  if (seconds % SECONDS_PER_HOUR !== 0) {
    throw new RangeError(`period of ${seconds}s is not a whole number of hours`)
  }
  return seconds / SECONDS_PER_HOUR
}

/** Днями період показується користувачу — але зберігається завжди в секундах. */
export const SECONDS_PER_DAY = 86_400

export function periodSecondsFromDays(days: number): number {
  assertWholePositive(days, 'days')
  return days * SECONDS_PER_DAY
}
