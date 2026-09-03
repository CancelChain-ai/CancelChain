import { U64_MAX } from '@cancelchain/shared'
import type { Address, ProgramDerivedAddressBump } from '@solana/kit'
import {
  findPlanPda,
  findRecurringDelegationPda,
  findSubscriptionAuthorityPda,
  findSubscriptionDelegationPda,
} from '@solana/subscriptions'

/**
 * Деривація адрес програми.
 *
 * Сіди не переписуються: усе рахує `@solana/subscriptions`, а тут лише зручна
 * форма результату й перевірка входів. Власна копія сідів була б четвертим
 * місцем, де живе той самий байтовий рядок, — і першим, що розійдеться при
 * оновленні SDK. Що сіди справді ті, які записані в `PLAN.md`, стереже
 * `pda.test.ts`: він звіряє результат із незалежно зібраним переліком сідів
 * і з зафіксованими адресами.
 *
 * Сіди станом на `@solana/subscriptions@0.5.0` (звірено по реалізації, не по
 * документації):
 *
 * | PDA | Сіди |
 * |---|---|
 * | Subscription Authority | `"SubscriptionAuthority"`, `user`, `tokenMint` |
 * | Plan | `"plan"`, `owner`, `planId` (u64 LE) |
 * | Subscription | `"subscription"`, `planPda`, `subscriber` |
 * | Delegation | `"delegation"`, `subscriptionAuthority`, `delegator`, `delegatee`, `nonce` (u64 LE) |
 */

/** Адреса плюс bump — у зручнішій формі, ніж кортеж `ProgramDerivedAddress`. */
export type Pda = {
  address: Address
  bump: ProgramDerivedAddressBump
}

function assertU64(value: number | bigint, name: string): void {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a whole number, got ${value}`)
  }
  const asBigInt = BigInt(value)
  if (asBigInt < 0n || asBigInt > U64_MAX) {
    throw new RangeError(`${name} does not fit in u64: ${value}`)
  }
}

/**
 * Гаманець користувача в межах одного міну. Це той акаунт, якому користувач
 * один раз делегує токени; усі його дозволи в цьому активі висять під ним.
 */
export async function findSubscriptionAuthority(seeds: {
  user: Address
  tokenMint: Address
}): Promise<Pda> {
  const [address, bump] = await findSubscriptionAuthorityPda(seeds)
  return { address, bump }
}

/** План мерчанта. `planId` — u64, який мерчант обирає сам. */
export async function findPlan(seeds: { owner: Address; planId: number | bigint }): Promise<Pda> {
  assertU64(seeds.planId, 'planId')
  const [address, bump] = await findPlanPda(seeds)
  return { address, bump }
}

/** Підписка конкретного гаманця на конкретний план. */
export async function findSubscription(seeds: {
  planPda: Address
  subscriber: Address
}): Promise<Pda> {
  const [address, bump] = await findSubscriptionDelegationPda(seeds)
  return { address, bump }
}

/**
 * Дозвіл поза планом — той самий об'єкт, який картка `FR-002` показує, а
 * `FR-003` скасовує.
 *
 * ⚠️ **Фіксований і періодичний дозволи мають однакову адресу.** У SDK
 * `findFixedDelegationPda` і `findRecurringDelegationPda` — це буквально та сама
 * деривація: префікс `"delegation"` і ті самі чотири сіди. Розрізняє їх лише
 * дискримінатор в даних акаунта, тобто **за адресою тип дозволу невідомий** —
 * його дає тільки читання акаунта (`T015`). Тому тут одна функція, а не дві:
 * дві створювали б враження, що вибір між ними на щось впливає.
 *
 * `nonce` — те, що дозволяє одній парі «гаманець ↔ мерчант» мати кілька
 * незалежних дозволів.
 */
export async function findDelegation(seeds: {
  subscriptionAuthority: Address
  delegator: Address
  delegatee: Address
  nonce: number | bigint
}): Promise<Pda> {
  assertU64(seeds.nonce, 'nonce')
  const [address, bump] = await findRecurringDelegationPda(seeds)
  return { address, bump }
}
