/**
 * Синтетичні дані прототипу M0. Ончейну під ними немає взагалі: кнопка
 * «Скасувати» нічого не скасовує, і жоден `SC-*` на цьому файлі не міряється.
 *
 * **Усі назви мерчантів вигадані.** Жодної справжньої компанії тут бути не може:
 * демо, у якому чужа підписка показана як керована звідси, робить неправдиве
 * твердження про цю компанію.
 *
 * Дата, від якої все відлічується, — 2 вересня 2026. Числа узгоджені між собою
 * за чотирма правилами, і кожне з них перевіряється очима при кожній правці:
 *
 * 1. `periodStarted` + `periodDays` = `nextCharge` (для паузи —
 *    `nextChargeOnResume`, для «не поновлювати» — `endsOn`).
 * 2. Списання йдуть із кроком у період: сусідні `Charged` рівно за `periodDays`.
 * 3. `usedThisPeriod` дорівнює сумі списань **на дату `periodStarted` або
 *    пізніше**. Нуль означає, що в поточному періоді списань не було.
 * 4. Стрічка не виходить за 90 днів — рівно те вікно, яке обіцяє напис під нею
 *    (`FR-029`). Те, що старше, лишається в мережі й видно лише в полі
 *    `givenOn`, яке приходить зі стану дозволу, а не зі стрічки.
 *
 * Сума в шапці ніде не написана: `allowedTotal()` складає стелі активних.
 */
export type PermissionState = 'active' | 'ending' | 'paused' | 'unsupported' | 'cancelled'

export type Asset = 'USDC' | 'CPRL'

export interface ActivityEvent {
  date: string
  description: string
  amount: number | null
  rejected: boolean
}

export interface PermissionDetail {
  periodStarted: string
  givenOn: string
  activity: ActivityEvent[]
}

export interface Permission {
  id: string
  merchant: string
  ceiling: number
  asset: Asset
  periodDays: number
  usedThisPeriod: number
  /** Display date of the next charge, or null when there will not be one. */
  nextCharge: string | null
  /** The one address this permission can ever pay. */
  recipient: string
  state: PermissionState
  /** Bare date the permission stops, when it is set not to renew. */
  endsOn?: string
  /** The date charging would resume at, for a paused permission. */
  nextChargeOnResume?: string
  /** True when the permission came from a merchant plan — pause and end-scheduling exist. */
  viaPlan: boolean
  /** Name of the plan it was given through, when there is one. */
  planName?: string
  /** Small quiet tag rendered under the merchant name. */
  quietTag?: string
  detail: PermissionDetail
}

export const WALLET = '7xKq…3Nde'

export const ASSET_DECIMALS: Record<Asset, number> = {
  USDC: 2,
  CPRL: 0,
}

export function formatAmount(value: number, asset: Asset): string {
  const decimals = ASSET_DECIMALS[asset]
  return `${value.toFixed(decimals)} ${asset}`
}

export const PERMISSIONS: Permission[] = [
  {
    id: 'vantage-transit',
    merchant: 'Vantage Transit',
    ceiling: 24,
    asset: 'USDC',
    periodDays: 30,
    usedThisPeriod: 24,
    nextCharge: '6 Sep 2026',
    recipient: '4mZP…9tKf',
    state: 'active',
    viaPlan: true,
    planName: 'Vantage Transit — Commuter',
    detail: {
      periodStarted: '7 Aug 2026',
      givenOn: '8 Jun 2026',
      activity: [
        { date: '7 Aug 2026', description: 'Charged', amount: 24, rejected: false },
        { date: '8 Jul 2026', description: 'Charged', amount: 24, rejected: false },
        {
          date: '28 Jun 2026',
          description: 'Charge attempt rejected — over the ceiling',
          amount: null,
          rejected: true,
        },
        {
          date: '8 Jun 2026',
          description: 'Permission given — up to 24.00 USDC every 30 days',
          amount: null,
          rejected: false,
        },
      ],
    },
  },
  {
    id: 'tessellate-studio',
    merchant: 'Tessellate Studio',
    ceiling: 45,
    asset: 'USDC',
    periodDays: 30,
    usedThisPeriod: 45,
    nextCharge: null,
    recipient: '6bWn…5cQd',
    state: 'ending',
    endsOn: '27 Sep 2026',
    viaPlan: true,
    planName: 'Tessellate Studio — Studio',
    detail: {
      periodStarted: '28 Aug 2026',
      givenOn: '30 Mar 2026',
      activity: [
        { date: '28 Aug 2026', description: 'Charged', amount: 45, rejected: false },
        { date: '29 Jul 2026', description: 'Charged', amount: 45, rejected: false },
        { date: '29 Jun 2026', description: 'Charged', amount: 45, rejected: false },
      ],
    },
  },
  {
    id: 'meridian-docs',
    merchant: 'Meridian Docs',
    ceiling: 12,
    asset: 'USDC',
    periodDays: 30,
    usedThisPeriod: 12,
    nextCharge: '11 Sep 2026',
    recipient: '8dHc…2vRm',
    state: 'active',
    viaPlan: false,
    quietTag: 'Given in another app',
    detail: {
      periodStarted: '12 Aug 2026',
      givenOn: '13 May 2026',
      activity: [
        { date: '12 Aug 2026', description: 'Charged', amount: 12, rejected: false },
        { date: '13 Jul 2026', description: 'Charged', amount: 12, rejected: false },
        { date: '13 Jun 2026', description: 'Charged', amount: 12, rejected: false },
      ],
    },
  },
  {
    id: 'halcyon-audio',
    merchant: 'Halcyon Audio',
    ceiling: 11.5,
    asset: 'USDC',
    periodDays: 30,
    usedThisPeriod: 0,
    nextCharge: '21 Sep 2026',
    recipient: '8kRt…2mWc',
    state: 'active',
    viaPlan: true,
    planName: 'Halcyon Audio — Standard',
    detail: {
      periodStarted: '22 Aug 2026',
      givenOn: '23 Jul 2026',
      activity: [
        { date: '24 Jul 2026', description: 'Charged', amount: 11.5, rejected: false },
        {
          date: '23 Jul 2026',
          description: 'Permission given — up to 11.50 USDC every 30 days',
          amount: null,
          rejected: false,
        },
      ],
    },
  },
  {
    id: 'lumen-reader',
    merchant: 'Lumen Reader',
    ceiling: 8,
    asset: 'USDC',
    periodDays: 30,
    usedThisPeriod: 8,
    nextCharge: '14 Sep 2026',
    recipient: '3jTa…7pLv',
    state: 'active',
    viaPlan: true,
    planName: 'Lumen Reader — Reader',
    detail: {
      periodStarted: '15 Aug 2026',
      givenOn: '17 Feb 2026',
      activity: [
        { date: '15 Aug 2026', description: 'Charged', amount: 8, rejected: false },
        { date: '16 Jul 2026', description: 'Charged', amount: 8, rejected: false },
        { date: '16 Jun 2026', description: 'Charged', amount: 8, rejected: false },
      ],
    },
  },
  {
    id: 'northsun-storage',
    merchant: 'Northsun Storage',
    ceiling: 4,
    asset: 'USDC',
    periodDays: 30,
    usedThisPeriod: 4,
    nextCharge: '9 Sep 2026',
    recipient: '5nEx…4gYb',
    state: 'active',
    viaPlan: false,
    detail: {
      periodStarted: '10 Aug 2026',
      givenOn: '11 Jan 2026',
      activity: [
        { date: '10 Aug 2026', description: 'Charged', amount: 4, rejected: false },
        { date: '11 Jul 2026', description: 'Charged', amount: 4, rejected: false },
        { date: '11 Jun 2026', description: 'Charged', amount: 4, rejected: false },
      ],
    },
  },
  {
    id: 'grainfield-coffee',
    merchant: 'Grainfield Coffee',
    ceiling: 19,
    asset: 'USDC',
    periodDays: 30,
    usedThisPeriod: 0,
    nextCharge: null,
    nextChargeOnResume: '17 Sep 2026',
    recipient: '9sKd…1fMe',
    state: 'paused',
    viaPlan: true,
    planName: 'Grainfield Coffee — Weekly Bag',
    detail: {
      periodStarted: '18 Aug 2026',
      givenOn: '2 Apr 2026',
      activity: [
        { date: '19 Aug 2026', description: 'Paused by you', amount: null, rejected: false },
        { date: '19 Jul 2026', description: 'Charged', amount: 19, rejected: false },
        { date: '19 Jun 2026', description: 'Charged', amount: 19, rejected: false },
      ],
    },
  },
  {
    id: 'copperline-games',
    merchant: 'Copperline Games',
    ceiling: 500,
    asset: 'CPRL',
    periodDays: 30,
    usedThisPeriod: 500,
    nextCharge: '12 Sep 2026',
    recipient: '2hVu…8dNq',
    state: 'unsupported',
    viaPlan: false,
    detail: {
      periodStarted: '13 Aug 2026',
      givenOn: '14 Jun 2026',
      activity: [
        { date: '13 Aug 2026', description: 'Charged', amount: 500, rejected: false },
        { date: '14 Jul 2026', description: 'Charged', amount: 500, rejected: false },
        {
          date: '14 Jun 2026',
          description: 'Permission given — up to 500 CPRL every 30 days',
          amount: null,
          rejected: false,
        },
      ],
    },
  },
]

/** States whose ceilings count toward the header total. */
export function countsTowardTotal(state: PermissionState): boolean {
  return state === 'active' || state === 'ending'
}

export interface AllowedTotal {
  amount: number
  count: number
}

export function allowedTotal(permissions: Permission[]): AllowedTotal {
  const counted = permissions.filter((p) => p.asset === 'USDC' && countsTowardTotal(p.state))
  return {
    amount: counted.reduce((sum, p) => sum + p.ceiling, 0),
    count: counted.length,
  }
}

/* ---------- Screen 3: the subscribe page a merchant links to ---------- */

export const SUBSCRIBE_OFFER = {
  merchant: 'Ridgeline Fitness',
  plan: 'Ridgeline Fitness — Monthly',
  ceiling: 9,
  asset: 'USDC' as Asset,
  periodDays: 30,
  recipient: '6yPn…3kBd',
}

/** The permission that exists once the offer above is allowed. */
export const SUBSCRIBE_GRANT: Permission = {
  id: 'ridgeline-fitness',
  merchant: SUBSCRIBE_OFFER.merchant,
  ceiling: SUBSCRIBE_OFFER.ceiling,
  asset: SUBSCRIBE_OFFER.asset,
  periodDays: SUBSCRIBE_OFFER.periodDays,
  usedThisPeriod: 0,
  nextCharge: '2 Oct 2026',
  recipient: SUBSCRIBE_OFFER.recipient,
  state: 'active',
  viaPlan: true,
  planName: SUBSCRIBE_OFFER.plan,
  detail: {
    periodStarted: '2 Sep 2026',
    givenOn: '2 Sep 2026',
    activity: [
      {
        date: '2 Sep 2026',
        description: 'Permission given — up to 9.00 USDC every 30 days',
        amount: null,
        rejected: false,
      },
    ],
  },
}

/* ---------- Screen 4: the merchant side ---------- */

export interface ChargeAttempt {
  subscriber: string
  result: string
  amount: number | null
  when: string
  rejected: boolean
}

const MERCHANT_PLAN = {
  name: 'Standard',
  ceiling: 11.5,
  periodDays: 30,
  link: 'cancelchain.app/p/halcyon-standard',
}

const MERCHANT_ACTIVE_PERMISSIONS = 38

export const MERCHANT = {
  name: 'Halcyon Audio',
  activePermissions: MERCHANT_ACTIVE_PERMISSIONS,
  /** Derived, never typed in: every active permission at the plan ceiling. */
  expectedThisPeriod: MERCHANT_ACTIVE_PERMISSIONS * MERCHANT_PLAN.ceiling,
  asset: 'USDC' as Asset,
  plan: MERCHANT_PLAN,
}

export const CHARGE_ATTEMPTS: ChargeAttempt[] = [
  { subscriber: '9pLm…4xQa', result: 'Charged', amount: 11.5, when: '2 Sep 2026', rejected: false },
  {
    subscriber: '3vNk…8sRt',
    result: 'Rejected — permission cancelled',
    amount: null,
    when: '2 Sep 2026',
    rejected: true,
  },
  { subscriber: '7xKq…3Nde', result: 'Charged', amount: 11.5, when: '1 Sep 2026', rejected: false },
  {
    subscriber: '5wBt…1jHp',
    result: 'Rejected — paused by the subscriber',
    amount: null,
    when: '1 Sep 2026',
    rejected: true,
  },
  {
    subscriber: '2qFd…6yLn',
    result: 'Rejected — not enough funds',
    amount: null,
    when: '31 Aug 2026',
    rejected: true,
  },
]
