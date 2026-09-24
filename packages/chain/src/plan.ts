import type { Address, Commitment } from '@solana/kit'
import { getBase64Encoder } from '@solana/kit'
import {
  AccountDiscriminator,
  getPlanDecoder,
  PLAN_SIZE,
  PlanStatus,
  ZERO_ADDRESS,
} from '@solana/subscriptions'
import { PROGRAM_ADDRESS } from './client.js'
import { timestampFromChain } from './decode.js'

/**
 * Читання акаунта плану — `["plan", owner, planId]`.
 *
 * Живе тут, а не в `tools/merchant-sim`, де з'явилося разом із білдером
 * (`T034`), бо план читають **обидві** сторони: мерчант — щоб показати, що
 * створив, а API (`T035`, `T036`) — щоб довести право на план і взяти з мережі
 * все, крім назви. Залежність `apps/api → tools/merchant-sim` означала б, що
 * сервер продукту тягне симулятор мерчанта, тобто мок у бойовому шляху.
 *
 * Створення плану лишилося в `merchant-sim`: підписує його мерчант, а сервер
 * гаманця не має й мати не буде.
 */

/**
 * Рівно та частина RPC, якою читається план. Вужчий тип, ніж `Rpc<SolanaRpcApi>`,
 * з тієї самої причини, що й `ProgramAccountsRpc` у `read.ts`: методи kit
 * перевантажені за кодуванням, і підробити їх у тесті означало б підробити всі
 * перевантаження. Справжній клієнт відповідає йому структурно — це перевіряє
 * `plan.test.ts`.
 */
export type PlanReaderRpc = {
  getAccountInfo(
    address: Address,
    config: { encoding: 'base64'; commitment?: Commitment },
  ): {
    send(): Promise<{
      value: { owner: Address; data: readonly [string, string] } | null
    }>
  }
}

/**
 * План так, як його зберігає мережа.
 *
 * `destinations` і `pullers` тут **без** нульових адрес: у мережі перелік
 * завжди на чотири місця, і порожні місця — це не «гаманець `1111…1111`», а
 * відсутність гаманця.
 *
 * Назви плану тут немає, і це не пропуск: у мережу вона не їде взагалі
 * (`T034`), її тримає офчейн-таблиця `plans` (`T035`).
 */
export type PlanSnapshot = {
  pda: Address
  owner: Address
  status: 'active' | 'sunset'
  planId: bigint
  mint: Address
  amount: bigint
  periodHours: number
  /** Ставить програма в момент створення. */
  createdAt: string | null
  endsAt: string | null
  destinations: Address[]
  pullers: Address[]
  metadataUri: string
}

export class PlanNotFoundError extends Error {
  constructor(readonly pda: Address) {
    super(`there is no account at ${pda}: the plan does not exist, or it has been deleted`)
    this.name = 'PlanNotFoundError'
  }
}

export class NotAPlanError extends Error {
  constructor(
    readonly pda: Address,
    detail: string,
  ) {
    super(`the account at ${pda} is not a plan of the program: ${detail}`)
    this.name = 'NotAPlanError'
  }
}

function planStatus(raw: number): PlanSnapshot['status'] {
  return raw === PlanStatus.Sunset ? 'sunset' : 'active'
}

function periodHoursFromChain(hours: bigint): number {
  if (hours <= 0n || hours > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`period of ${hours} hours does not fit in a JS number`)
  }
  return Number(hours)
}

/**
 * План із мережі. Перевіряються всі три ознаки — власник, дискримінатор,
 * розмір: декодер чужих байтів потрібної довжини повертає не помилку, а
 * правдоподібні числа (та сама обережність, що й у `read.ts`).
 */
export async function readPlan(
  rpc: PlanReaderRpc,
  pda: Address,
  options: { commitment?: Commitment; programAddress?: Address } = {},
): Promise<PlanSnapshot> {
  const programAddress = options.programAddress ?? PROGRAM_ADDRESS
  const { value } = await rpc
    .getAccountInfo(pda, {
      encoding: 'base64',
      ...(options.commitment === undefined ? {} : { commitment: options.commitment }),
    })
    .send()
  if (value === null) throw new PlanNotFoundError(pda)
  if (value.owner !== programAddress) {
    throw new NotAPlanError(pda, `it belongs to ${value.owner}, not to the program`)
  }
  const bytes = getBase64Encoder().encode(value.data[0])
  if (bytes.length !== PLAN_SIZE) {
    throw new NotAPlanError(pda, `it holds ${bytes.length} bytes, a plan holds ${PLAN_SIZE}`)
  }
  if (bytes[0] !== AccountDiscriminator.Plan) {
    throw new NotAPlanError(
      pda,
      `its discriminator is ${bytes[0]}, a plan's is ${AccountDiscriminator.Plan}`,
    )
  }
  const decoded = getPlanDecoder().decode(bytes)
  const present = (wallets: readonly Address[]) =>
    wallets.filter((wallet) => wallet !== ZERO_ADDRESS)
  return {
    pda,
    owner: decoded.owner,
    status: planStatus(decoded.status),
    planId: decoded.data.planId,
    mint: decoded.data.mint,
    amount: decoded.data.terms.amount,
    periodHours: periodHoursFromChain(decoded.data.terms.periodHours),
    createdAt: timestampFromChain(decoded.data.terms.createdAt),
    endsAt: timestampFromChain(decoded.data.endTs),
    destinations: present(decoded.data.destinations),
    pullers: present(decoded.data.pullers),
    metadataUri: decoded.data.metadataUri,
  }
}
