import type { Address, Commitment, Signature, Slot, UnixTimestamp } from '@solana/kit'

/**
 * Транзакції, що торкнулися адреси дозволу — `T030`, мінімальна форма `FR-005`.
 *
 * **Чого тут немає і бути не може.** `getSignaturesForAddress` каже, що
 * транзакція згадала цю адресу, і чи вона впала. Що вона робила — списання,
 * видача, скасування — з відповіді не видно: для цього треба розбирати логи
 * програми, а це індексатор (`T038`) і мапінг кодів (`T040`). Тому тут немає
 * ані сум, ані причин відмови: порожнє поле чесніше за здогадку про чужі гроші.
 *
 * **Це історія адреси, а не дозволу.** Скасування закриває акаунт, а ті самі
 * сіди дають ту саму адресу знову — тож у старих рядках може лежати попередній
 * дозвіл за тією ж адресою. Розрізнити їх без декодування нема чим, і саме тому
 * тип називається `AddressTransaction`, а не `AllowanceEvent`.
 */

/**
 * Рівно та частина RPC, якою користується читання історії — тією ж причиною,
 * що й `ProgramAccountsRpc`: метод kit перевантажений за конфігурацією, і
 * підробити його в тесті цілком означало б підробити всі перевантаження.
 */
export type SignaturesForAddressRpc = {
  getSignaturesForAddress(
    address: Address,
    config?: {
      limit?: number
      commitment?: Commitment
      before?: Signature
      until?: Signature
    },
  ): {
    send(): Promise<readonly RawAddressSignature[]>
  }
}

/** Те, що з відповіді вузла нас цікавить. Решту полів він теж віддає. */
export type RawAddressSignature = {
  signature: Signature
  slot: Slot
  blockTime: UnixTimestamp | null
  /** `null` — транзакція пройшла. Форма помилки тут навмисно не розбирається. */
  err: unknown
}

export type HistoryReader = {
  rpc: SignaturesForAddressRpc
}

export type AddressTransaction = {
  signature: string
  slot: number
  /** ISO-час блоку або `null`: вузол знає його не для кожного блоку. */
  blockTime: string | null
  failed: boolean
}

export type AddressHistory = {
  items: AddressTransaction[]
  syncedAt: string
  /** За межею запитаного вікна є старіші транзакції. */
  more: boolean
}

export type ReadAddressHistoryOptions = {
  address: Address
  /** Скільки рядків показати. Вузла питається на один більше — див. `more`. */
  limit: number
  commitment?: Commitment
  now?: Date
}

export class HistoryLimitError extends RangeError {
  constructor(limit: number) {
    super(`history limit must be a positive integer, got ${limit}`)
    this.name = 'HistoryLimitError'
  }
}

/**
 * `bigint` вузла → `number`. Перевіркою, а не приведенням: kit підіймає цілі з
 * RPC у `bigint`, і `Number()` без межі мовчки округлив би слот (знайдено в
 * `T028`).
 */
function slotToNumber(slot: Slot): number {
  if (slot < 0n || slot > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`slot does not fit in a JS number: ${slot}`)
  }
  return Number(slot)
}

const MS_PER_SECOND = 1000

/**
 * Час блоку в секундах → ISO. `null` лишається `null`: вузол не знає часу для
 * кожного блоку, і підставити сюди «зараз» означало б датувати чужу транзакцію
 * моментом нашого запиту.
 */
function blockTimeToIso(blockTime: UnixTimestamp | null): string | null {
  if (blockTime === null) return null
  const ms = Number(blockTime) * MS_PER_SECOND
  if (!Number.isFinite(ms))
    throw new RangeError(`block time does not fit in a JS date: ${blockTime}`)
  return new Date(ms).toISOString()
}

/**
 * Останні транзакції за адресою, найновіші першими.
 *
 * Вузла питається на один рядок більше, ніж покажемо: інакше «рівно 25» і
 * «25 і ще скільки завгодно» виглядали б однаково, і вікно видавалося б за всю
 * історію адреси.
 */
export async function readAddressHistory(
  reader: HistoryReader,
  options: ReadAddressHistoryOptions,
): Promise<AddressHistory> {
  const { address, limit } = options
  if (!Number.isInteger(limit) || limit < 1) throw new HistoryLimitError(limit)

  const raw = await reader.rpc
    .getSignaturesForAddress(address, {
      limit: limit + 1,
      ...(options.commitment === undefined ? {} : { commitment: options.commitment }),
    })
    .send()

  const items = raw.slice(0, limit).map(
    (entry): AddressTransaction => ({
      signature: entry.signature,
      slot: slotToNumber(entry.slot),
      blockTime: blockTimeToIso(entry.blockTime),
      /*
       * Форма помилки не розбирається: `err` буває і об'єктом
       * (`{ InstructionError: [0n, { Custom: 400n }] }`), і рядком рантайму
       * (`InvalidAccountOwner`), і глибина її розбору — це `T040`. Тут потрібне
       * рівно одне: транзакція пройшла чи ні.
       */
      failed: entry.err !== null && entry.err !== undefined,
    }),
  )

  return {
    items,
    syncedAt: (options.now ?? new Date()).toISOString(),
    more: raw.length > limit,
  }
}
