import type { Address, Signature, Slot, UnixTimestamp } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import {
  type AddressTransaction,
  HistoryLimitError,
  type HistoryReader,
  type RawAddressSignature,
  readAddressHistory,
  type SignaturesForAddressRpc,
} from './history.js'

/**
 * Читання історії адреси (`T030`).
 *
 * Перевіряється не «дані доїхали», а три речі, на яких воно ламається мовчки:
 * kit підіймає цілі з RPC у `bigint` (слот і час блоку — не `number`), вікно
 * не має видаватися за всю історію, і форма `err` буває якою завгодно, а
 * відповісти на неї треба одним бітом.
 */

const PDA = '3amcyam5KhjbWJLAMNPiAwpYPcV1atWSppEZK1ABoWBR' as Address
const NOW = new Date('2026-09-03T10:00:00.000Z')

function sig(index: number): Signature {
  return `${index}`.padStart(88, 'S') as Signature
}

function raw(over: Partial<RawAddressSignature> = {}): RawAddressSignature {
  return {
    signature: sig(1),
    slot: 400_000_000n as Slot,
    blockTime: 1_788_000_000n as UnixTimestamp,
    err: null,
    ...over,
  }
}

type Call = { address: Address; config: { limit?: number; commitment?: string } | undefined }

function fakeRpc(answer: readonly RawAddressSignature[]) {
  const calls: Call[] = []
  const rpc: SignaturesForAddressRpc = {
    getSignaturesForAddress(address, config) {
      calls.push({ address, config })
      return { send: async () => answer }
    },
  }
  return { reader: { rpc } satisfies HistoryReader, calls }
}

const read = (answer: readonly RawAddressSignature[], limit = 25) => {
  const { reader, calls } = fakeRpc(answer)
  return {
    calls,
    result: readAddressHistory(reader, { address: PDA, limit, now: NOW }),
  }
}

describe('readAddressHistory', () => {
  it('turns what the node sends into what the contract promises', async () => {
    const { result } = read([raw()])
    const history = await result
    expect(history.items).toEqual<AddressTransaction[]>([
      {
        signature: sig(1),
        slot: 400_000_000,
        blockTime: '2026-08-29T10:40:00.000Z',
        failed: false,
      },
    ])
    expect(history.syncedAt).toBe(NOW.toISOString())
  })

  it('keeps a slot a number, not the bigint the node sends', async () => {
    // kit підіймає цілі з RPC у `bigint`. Порівняння з `number` тут мовчки
    // хибне, а `JSON.stringify` на такій відповіді кидає (знайдено в `T028`).
    const history = await read([raw({ slot: 12n as Slot })]).result
    expect(typeof history.items[0]?.slot).toBe('number')
  })

  it('refuses a slot that does not fit in a JS number instead of rounding it', async () => {
    await expect(read([raw({ slot: (2n ** 60n) as Slot })]).result).rejects.toThrow(/does not fit/)
  })

  it('leaves an unknown block time unknown', async () => {
    // Вузол знає час не для кожного блоку. «Зараз» на цьому місці датувало б
    // чужу транзакцію моментом нашого запиту.
    const history = await read([raw({ blockTime: null })]).result
    expect(history.items[0]?.blockTime).toBeNull()
  })

  it('answers one bit about a failure, whatever shape the node sends it in', async () => {
    const shapes: unknown[] = [
      { InstructionError: [0n, { Custom: 400n }] },
      'InvalidAccountOwner',
      { InsufficientFundsForRent: { account_index: 1 } },
    ]
    for (const err of shapes) {
      const history = await read([raw({ err })]).result
      expect(history.items[0]?.failed).toBe(true)
    }
    expect((await read([raw({ err: null })]).result).items[0]?.failed).toBe(false)
  })

  it('asks for one row more than it shows, so a window is not a history', async () => {
    const { calls, result } = read([raw()], 25)
    await result
    expect(calls[0]?.config?.limit).toBe(26)
  })

  it('says there are older transactions instead of ending the list silently', async () => {
    const answer = Array.from({ length: 4 }, (_, index) => raw({ signature: sig(index) }))
    const history = await read(answer, 3).result
    expect(history.items).toHaveLength(3)
    expect(history.more).toBe(true)
  })

  it('claims nothing about older transactions when the node had no more', async () => {
    const history = await read([raw(), raw({ signature: sig(2) })], 3).result
    expect(history.more).toBe(false)
  })

  it('is empty when the address has no history, and says so as an answer', async () => {
    const history = await read([], 3).result
    expect(history.items).toEqual([])
    expect(history.more).toBe(false)
  })

  it('does not send a commitment it was not given', async () => {
    const { calls, result } = read([raw()])
    await result
    expect(calls[0]?.config).not.toHaveProperty('commitment')
  })

  it('refuses a limit that is not a positive whole number', async () => {
    const { reader } = fakeRpc([])
    for (const limit of [0, -1, 2.5, Number.NaN]) {
      await expect(readAddressHistory(reader, { address: PDA, limit })).rejects.toBeInstanceOf(
        HistoryLimitError,
      )
    }
  })
})
