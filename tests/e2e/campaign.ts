import {
  attemptCharge,
  type ChargeAttemptOptions,
  type ChargeInput,
  type ChargeRpc,
  type ChargeVerdict,
} from '@cancelchain/merchant-sim'

/**
 * Прогінний рушій для `SC-001` і `SC-004` — `T028`.
 *
 * ⚠️ **Спробою рахується лише те, що мережа розсудила.** `unknown` (надіслано,
 * статусу немає) і `no-attempt` (транзакція нікуди не поїхала) у бюджет ≥200 не
 * входять. Це головне рішення всього файлу: якби вони рахувалися, найлегший
 * спосіб отримати зелений `SC-001` — впертися в rate limit публічного вузла.
 * Двісті спроб, яких не сталося, чесно дають нуль успішних списань і не
 * доводять нічого.
 *
 * Тому цикл крутиться до **розсуджених** спроб, а стеля надсилань (`maxSends`)
 * існує окремо: вона рятує від нескінченного прогону, і вихід по ній — це не
 * успіх, а незавершений вимір, який видно у звіті.
 */

export type CampaignTally = {
  /** Спроби, які мережа розсудила. Саме це число звіряється з бюджетом. */
  judged: number
  charged: number
  rejected: number
  /** Надіслано, статусу немає. Ні успіх, ні відмова, ні спроба. */
  unknown: number
  /** Транзакція нікуди не поїхала. Теж не спроба. */
  noAttempt: number
  /** Скільки разів узагалі зверталися до мережі. */
  sends: number
  /** Код помилки програми → скільки разів. `none` — відмова не від програми. */
  codes: Record<string, number>
  /** Підписи успішних списань. За `SC-001` цей масив мусить лишитися порожнім. */
  chargedSignatures: string[]
  /** Один підпис відмови — той, що йде в звіт і в explorer. */
  sampleRejectedSignature: string | null
}

export type CampaignOptions = {
  /** Скільки розсуджених спроб потрібно. `SC-001` і `SC-004` вимагають ≥200. */
  attempts: number
  /**
   * Стеля надсилань. Без неї rate limit або мовчазний вузол крутили б цикл
   * вічно; з нею незавершений вимір видно як `judged < attempts`.
   */
  maxSends: number
  /** Пауза між надсиланнями — щоб не впертися в ліміт вузла на першій сотні. */
  delayMs?: number
  /**
   * Зупинитися на першому успішному списанні.
   *
   * Для `SC-001` і `SC-004` успіх означає, що критерій уже порушено, а кожна
   * наступна спроба тягне з чужого гаманця ще раз. Крутити далі заради
   * статистики означало б платити чужими грошима за красивіше число.
   */
  stopOnCharge?: boolean
  sleep?: (ms: number) => Promise<void>
  onVerdict?: (verdict: ChargeVerdict, tally: CampaignTally) => void
  attemptOptions?: ChargeAttemptOptions
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function emptyTally(): CampaignTally {
  return {
    charged: 0,
    chargedSignatures: [],
    codes: {},
    judged: 0,
    noAttempt: 0,
    rejected: 0,
    sampleRejectedSignature: null,
    sends: 0,
    unknown: 0,
  }
}

function countCode(tally: CampaignTally, code: number | null): void {
  const key = code === null ? 'none' : String(code)
  tally.codes[key] = (tally.codes[key] ?? 0) + 1
}

/**
 * Серія спроб списання за одним дозволом.
 *
 * Спроби йдуть послідовно, а не пачкою: паралельні надсилання з одного гаманця
 * ділять той самий хеш блоку й ту саму чергу вузла, тож частина з них
 * поверталася б як `no-attempt` через ліміт — тобто вимір перетворився б на
 * вимір швидкості вузла.
 */
export async function runCampaign(
  rpc: ChargeRpc,
  input: ChargeInput,
  options: CampaignOptions,
): Promise<CampaignTally> {
  const sleep = options.sleep ?? realSleep
  const delayMs = options.delayMs ?? 0
  const tally = emptyTally()

  while (tally.judged < options.attempts && tally.sends < options.maxSends) {
    if (tally.sends > 0 && delayMs > 0) await sleep(delayMs)
    tally.sends += 1
    const verdict = await attemptCharge(rpc, input, options.attemptOptions)

    switch (verdict.outcome) {
      case 'charged':
        tally.judged += 1
        tally.charged += 1
        tally.chargedSignatures.push(verdict.signature)
        break
      case 'rejected':
        tally.judged += 1
        tally.rejected += 1
        countCode(tally, verdict.programErrorCode)
        tally.sampleRejectedSignature ??= verdict.signature
        break
      case 'unknown':
        tally.unknown += 1
        break
      default:
        tally.noAttempt += 1
        break
    }

    options.onVerdict?.(verdict, tally)
    if (options.stopOnCharge === true && tally.charged > 0) break
  }

  return tally
}

/** Рядок звіту. Показує і те, чого не сталося, — інакше нуль нічого не означає. */
export function describeTally(tally: CampaignTally): string {
  const codes = Object.entries(tally.codes)
    .map(([code, count]) => `${code}×${count}`)
    .join(', ')
  return [
    `judged:       ${tally.judged}   (charged ${tally.charged}, rejected ${tally.rejected})`,
    `not counted:  unknown ${tally.unknown}, no-attempt ${tally.noAttempt}`,
    `sends:        ${tally.sends}`,
    `codes:        ${codes === '' ? '—' : codes}`,
    `sample:       ${tally.sampleRejectedSignature ?? '—'}`,
  ].join('\n')
}
