import type {
  AllowanceKind,
  AllowanceStatus,
  AllowanceUnreadableReason,
  ListedAllowance,
} from '@cancelchain/shared'
import { SECONDS_PER_DAY, toU64 } from '@cancelchain/shared'
import { shortenAddress } from '../chain/wallet.js'
import type { Permission } from './mockData.js'

/**
 * Модель показу дозволу — те єдине, що знають екрани.
 *
 * Вона стоїть між двома джерелами (`source.ts`): мок M0 і `GET /v1/allowances`.
 * Обидва приводяться сюди, тож перемикання джерела не переписує жодного екрана,
 * а різниця між «вигаданим» і «прочитаним з devnet» лишається в одному місці.
 *
 * Тут **немає готових рядків** для сум і дат. Показ форматує компонент, а модель
 * несе значення: сума — у найменших одиницях `bigint` (u64 не влазить у double,
 * і стеля дозволу — це чужі гроші), дата — `Date`, а не «6 Sep 2026».
 */

/** USDC має шість знаків. Це не наша конвенція, а параметр самого міну. */
export const USDC_DECIMALS = 6

/**
 * Сума в найменших одиницях активу.
 *
 * `decimals: null` означає, що активу ми **не знаємо** — це дозвіл у чужому міні
 * (`FR-020`), і десяткових у нас на нього немає. Показати там `500.00`,
 * припустивши шість знаків, означало б назвати чуже число не тим, чим воно є,
 * тому такі суми показуються найменшими одиницями і кажуть про це вголос.
 */
export interface Money {
  amount: bigint
  decimals: number | null
  /** `USDC` або скорочений мін чужого активу. */
  label: string
}

export interface AllowanceView {
  /** PDA дозволу для справжніх даних; ідентифікатор мока — для мока. */
  id: string
  kind: AllowanceKind
  status: AllowanceStatus
  /**
   * Назва мерчанта, коли вона взагалі існує. Для даних із мережі — `null`:
   * імені мерчанта в акаунті дозволу немає, і вигадати його тут означало б
   * підписати чужою назвою справжні гроші.
   */
  title: string | null
  /** Адреса, яку показує картка: гаманець мерчанта або план. Уже скорочена. */
  counterparty: string
  counterpartyLabel: string
  kindLabel: string
  cap: Money
  /**
   * Витрачено за поточний період. `null` — мережа цього **не зберігає**
   * (`fixed`: у структурі акаунта є лише залишок), і це не нуль.
   */
  used: Money | null
  /**
   * Довжина періоду **в секундах** — так, як її тримає мережа. Днями тут її
   * тримати не можна: на devnet є дозволи з періодом в одну годину, і поділ на
   * добу дав би «кожні 0.0416 дня».
   */
  periodSeconds: number | null
  /**
   * Період, який мережа вважає поточним, уже скінчився.
   *
   * Це не косметика. Програма скидає витрачене при **наступному** списанні, а
   * не за годинником, тож у такому дозволі `spentInPeriod` стосується періоду,
   * якого вже немає: повна смужка згоди сказала б «більше взяти не можуть» саме
   * тоді, коли взяти можуть будь-якої миті.
   */
  periodElapsed: boolean
  nextCharge: Date | null
  /** `FR-028`: дозвіл доживає до цієї дати й не поновлюється. */
  endsOn: Date | null
  /** Власний строк дозволу — інша річ, ніж `endsOn`: його поставив не користувач. */
  expiresOn: Date | null
  assetSupported: boolean
  /** Тихий рядок під заголовком або `null`. */
  note: string | null
}

const PERIOD_UNITS = [
  { seconds: SECONDS_PER_DAY, one: 'day', many: 'days' },
  { seconds: 3_600, one: 'hour', many: 'hours' },
  { seconds: 60, one: 'minute', many: 'minutes' },
  { seconds: 1, one: 'second', many: 'seconds' },
] as const

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Дата в стилі решти екранів: `6 Sep 2026`.
 *
 * Місцевий час, а не UTC: «наступне списання» — це момент, і людина звіряє його
 * зі своїм календарем. Через це той самий момент у різних поясах може мати різну
 * дату — але саме така дата й правдива для того, хто дивиться.
 */
export function formatDay(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? '?'} ${date.getFullYear()}`
}

/** `'6 Sep 2026'` → `'6 Sep'`. Повна дата лишається на екрані картки. */
export function shortDay(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? '?'}`
}

/** Час у стилі решти екранів: `20:12`. Місцевий, як і дати. */
export function formatClock(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/**
 * Чому акаунт не став карткою — словами, а не кодом.
 *
 * Перелік причин скінченний і живе у `shared`; тут у нього рівно стільки
 * записів, скільки там, і `satisfies` це стереже: нова причина зламає збірку
 * тут, а не покаже людині порожнє місце.
 */
export const UNREADABLE_REASON_LABELS = {
  empty: 'the account holds no data',
  discriminator: 'it is not a kind of permission this build knows',
  length: 'its size does not match any permission this build knows',
  version: 'it was written by a newer version of the program',
  plan: 'its merchant plan could not be found, so its asset is unknown',
  fields: 'it holds a value that does not fit our model',
} as const satisfies Record<AllowanceUnreadableReason, string>

const MIN_FRACTION_DIGITS = 2

/** Найменші одиниці → десятковий рядок. Без `Number`: u64 не влазить у double. */
export function scaleAmount(amount: bigint, decimals: number): string {
  if (decimals <= 0) return amount.toString(10)
  const unit = 10n ** BigInt(decimals)
  const whole = (amount / unit).toString(10)
  const fraction = (amount % unit).toString(10).padStart(decimals, '0')
  // Хвостові нулі прибираються, але два знаки лишаються завжди: «24» замість
  // «24.00» у списку сум читається як інший порядок величини.
  const trimmed = fraction.replace(/0+$/, '')
  const kept = Math.max(MIN_FRACTION_DIGITS, trimmed.length)
  return `${whole}.${fraction.slice(0, kept).padEnd(MIN_FRACTION_DIGITS, '0')}`
}

export function formatMoney(money: Money): string {
  if (money.decimals === null) return `${money.amount} of ${money.label}`
  return `${scaleAmount(money.amount, money.decimals)} ${money.label}`
}

function usdc(amount: bigint): Money {
  return { amount, decimals: USDC_DECIMALS, label: 'USDC' }
}

const KIND_LABELS = {
  fixed: 'One-off',
  recurring: 'Recurring',
  subscription: 'Plan subscription',
} as const satisfies Record<AllowanceKind, string>

/**
 * Період словами, у найбільшій одиниці, яка ділить його **націло**.
 *
 * Округлення тут заборонене: «кожні 30 днів» замість 29 днів 23 годин — це
 * інша дата наступного списання, а не інший текст.
 */
export function formatPeriod(seconds: number): string {
  for (const unit of PERIOD_UNITS) {
    if (seconds % unit.seconds === 0) {
      const count = seconds / unit.seconds
      return `${count} ${count === 1 ? unit.one : unit.many}`
    }
  }
  return `${seconds} seconds`
}

/** `every hour`, `every 30 days` — без «every 1 hour». */
export function everyPeriod(seconds: number): string {
  const label = formatPeriod(seconds)
  return `every ${label.startsWith('1 ') ? label.slice(2) : label}`
}

function dateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value)
}

/**
 * Коли дозвіл спишуть наступного разу.
 *
 * Мережа цієї дати не зберігає — вона зберігає початок періоду й довжину, тож
 * дата рахується, а не читається. Списання **не** буде, коли періоду немає
 * (`fixed`), коли дозвіл уже не активний, або коли він доживає до `endsOn`
 * (`FR-028`: після цієї дати списання не пройде, а до неї період не почнеться
 * заново).
 */
export function nextChargeAt(allowance: {
  status: AllowanceStatus
  periodSeconds: number | null
  periodStartedAt: string | null
  endsAt: string | null
}): Date | null {
  if (allowance.status !== 'active') return null
  if (allowance.endsAt !== null) return null
  return periodEndsAt(allowance)
}

/** Кінець періоду, який мережа вважає поточним. */
function periodEndsAt(allowance: {
  periodSeconds: number | null
  periodStartedAt: string | null
}): Date | null {
  const { periodSeconds, periodStartedAt } = allowance
  if (periodSeconds === null || periodStartedAt === null) return null
  return new Date(new Date(periodStartedAt).getTime() + periodSeconds * 1000)
}

/**
 * Дозвіл із `GET /v1/allowances` → модель показу.
 *
 * Позначка активу приходить із сервера (`assetSupported`), а не рахується тут:
 * розрахунковий мін — це конфігурація сервера, і дублювати її в браузері
 * означало б мати два різні уявлення про те, який актив підтримується.
 */
export function viewFromAllowance(allowance: ListedAllowance, now = new Date()): AllowanceView {
  const subscription = allowance.kind === 'subscription'
  const counterpartyAddress = subscription
    ? (allowance.planPda ?? allowance.delegate)
    : allowance.delegate
  const asset: (amount: bigint) => Money = allowance.assetSupported
    ? usdc
    : (amount) => ({ amount, decimals: null, label: shortenAddress(allowance.mint) })

  return {
    id: allowance.pda,
    kind: allowance.kind,
    status: allowance.status,
    // Імені мерчанта в мережі немає — картка показує адресу, і тільки її.
    title: null,
    counterparty: shortenAddress(counterpartyAddress),
    counterpartyLabel: subscription ? 'Merchant plan' : 'Merchant wallet',
    kindLabel: KIND_LABELS[allowance.kind],
    cap: asset(toU64(allowance.capAmount)),
    // `fixed` не має «витрачено» в акаунті взагалі — нуль тут був би вигадкою.
    used: allowance.kind === 'fixed' ? null : asset(toU64(allowance.spentInPeriod)),
    periodSeconds: allowance.periodSeconds,
    periodElapsed:
      (periodEndsAt(allowance)?.getTime() ?? Number.POSITIVE_INFINITY) <= now.getTime(),
    nextCharge: nextChargeAt(allowance),
    endsOn: dateOrNull(allowance.endsAt),
    expiresOn: dateOrNull(allowance.expiresAt),
    assetSupported: allowance.assetSupported,
    note: null,
  }
}

/** Числа мока — десяткові, з рівно тією точністю, яку має актив. */
function mockMoney(value: number, permission: Permission): Money {
  const decimals = permission.asset === 'USDC' ? USDC_DECIMALS : 0
  return {
    amount: BigInt(Math.round(value * 10 ** decimals)),
    decimals,
    label: permission.asset,
  }
}

const MOCK_STATUS = {
  active: 'active',
  ending: 'active',
  paused: 'paused',
  unsupported: 'active',
  cancelled: 'revoked',
} as const satisfies Record<Permission['state'], AllowanceStatus>

/** `'6 Sep 2026'` мока → `Date`. Розбір рядка, який сам же мок і склав. */
function mockDate(value: string | undefined): Date | null {
  if (value === undefined) return null
  const parsed = new Date(`${value} 00:00:00`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Мок M0 → та сама модель показу.
 *
 * Мок не є вужчим випадком справжніх даних, і зводити його сюди довелося
 * руками: `state: 'unsupported'` у ньому змішує статус із активом (у мережі це
 * незалежні речі — чужий актив буває й у цілком активного дозволу), а суми
 * лежать числами з комою. Обидві розбіжності зупиняються тут, а не розповзаються
 * по екранах.
 */
export function viewFromPermission(permission: Permission): AllowanceView {
  return {
    id: permission.id,
    kind: permission.viaPlan ? 'subscription' : 'recurring',
    status: MOCK_STATUS[permission.state],
    title: permission.merchant,
    counterparty: permission.recipient,
    counterpartyLabel: permission.viaPlan ? 'Merchant plan' : 'Merchant wallet',
    kindLabel: permission.viaPlan ? KIND_LABELS.subscription : KIND_LABELS.recurring,
    cap: mockMoney(permission.ceiling, permission),
    used: mockMoney(permission.usedThisPeriod, permission),
    periodSeconds: permission.periodDays * SECONDS_PER_DAY,
    // Числа мока узгоджені між собою за побудовою (`mockData.test.ts`).
    periodElapsed: false,
    nextCharge: mockDate(permission.nextCharge ?? undefined),
    endsOn: mockDate(permission.endsOn),
    expiresOn: null,
    assetSupported: permission.asset === 'USDC',
    note: permission.quietTag ?? null,
  }
}

export interface AllowedTotal {
  amount: bigint
  decimals: number
  label: string
  count: number
}

/**
 * Сума в шапці: стелі активних дозволів у розрахунковому активі.
 *
 * Дозволи в чужому активі до неї не входять і входити не можуть — складати
 * різні міни в одне число означало б вигадати курс, якого в системі немає.
 * Скільки їх лишилося поза сумою, картки кажуть кожна за себе.
 */
export function allowedTotal(views: readonly AllowanceView[]): AllowedTotal {
  const counted = views.filter((view) => view.assetSupported && view.status === 'active')
  return {
    amount: counted.reduce((sum, view) => sum + view.cap.amount, 0n),
    decimals: USDC_DECIMALS,
    label: 'USDC',
    count: counted.length,
  }
}
