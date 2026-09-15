import type { AddressHistory } from '@cancelchain/chain'
import { apiErrorSchema, listSignaturesResponseSchema } from '@cancelchain/shared'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app.js'
import { createLogger } from '../logger.js'
import type { HealthDeps } from './health.js'

/**
 * `GET /v1/allowances/:pda/signatures` — `T030`.
 *
 * Перевіряється форма відповіді й межа: що саме поїхало в мережу, і що
 * порожня історія лишається відповіддю, а не `404`.
 */

const PDA = '6Y7s52pnmsnxT4jQTXpgvJ9kZvM4Me3VMUUUhogq8imH'
/**
 * Справжній підпис із devnet — відхилена спроба списання з прогону `T028`.
 * Узятий саме він, бо він **87 символів**, а не 88: підпис base58 буває 86–88
 * (`primitives.ts`), і вигаданий рівно-88-символьний фікстур пропустив би
 * схему, яка мовчки вимагає 88.
 */
const SIGNATURE =
  '8EBc2GWCHxqXMRVhqjFhfAKcFBW5sitgEuZpNY37bJhThLSe4B6CDM1eEmcCQa3iDhf8guEhSkdGXXc82ATu6n2'
const SYNCED_AT = '2026-09-03T12:00:00.000Z'
const SLOT = 412_345_678

const HEALTH: HealthDeps = {
  ping: async () => {},
  currentSlot: async () => SLOT,
  cachedAt: async () => null,
  startedAt: Date.parse(SYNCED_AT),
  now: () => Date.parse(SYNCED_AT),
}

function history(over: Partial<AddressHistory> = {}): AddressHistory {
  return {
    items: [
      { signature: SIGNATURE, slot: SLOT, blockTime: '2026-09-03T11:59:00.000Z', failed: false },
    ],
    syncedAt: SYNCED_AT,
    more: false,
    ...over,
  }
}

function app(signatures: Partial<AppDeps['signatures']> = {}) {
  return createApp({
    logger: createLogger('silent'),
    health: HEALTH,
    allowances: {
      list: async () => ({ slot: SLOT, syncedAt: SYNCED_AT, allowances: [], unreadable: [] }),
      get: async () => ({ slot: SLOT, syncedAt: SYNCED_AT, allowance: null, unreadable: null }),
      cached: async () => null,
      settlementMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    },
    signatures: { history: async () => history(), ...signatures },
    blockhash: {
      latestBlockhash: async () => ({
        blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
        lastValidBlockHeight: 492_096_495n,
        slot: SLOT,
      }),
    },
  })
}

type Asked = { pda: string; limit: number }

function asking(result: AddressHistory = history()) {
  const asked: Asked[] = []
  const application = app({
    history: async (pda, limit) => {
      asked.push({ pda, limit })
      return result
    },
  })
  return { asked, application }
}

describe('GET /v1/allowances/:pda/signatures', () => {
  it('віддає рівно ту форму, яку описує listSignaturesResponseSchema зі shared', async () => {
    const res = await app().request(`/v1/allowances/${PDA}/signatures`)

    expect(res.status).toBe(200)
    const body = listSignaturesResponseSchema.parse(await res.json())
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.failed).toBe(false)
    expect(body.syncedAt).toBe(SYNCED_AT)
    expect(body.more).toBe(false)
  })

  it('питає рівно ту адресу, що в шляху, і вікно за замовчуванням', async () => {
    const { asked, application } = asking()
    await application.request(`/v1/allowances/${PDA}/signatures`)

    expect(asked).toEqual([{ pda: PDA, limit: 25 }])
  })

  it('передає запитане вікно далі', async () => {
    const { asked, application } = asking()
    await application.request(`/v1/allowances/${PDA}/signatures?limit=5`)

    expect(asked[0]?.limit).toBe(5)
  })

  it('вікно понад стелю — INVALID_INPUT, до мережі не ходимо', async () => {
    const { asked, application } = asking()
    const res = await application.request(`/v1/allowances/${PDA}/signatures?limit=500`)

    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('INVALID_INPUT')
    expect(asked).toEqual([])
  })

  it('невалідна адреса — INVALID_INPUT, до мережі не ходимо', async () => {
    const { asked, application } = asking()
    const res = await application.request('/v1/allowances/not-an-address/signatures')

    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('INVALID_INPUT')
    expect(asked).toEqual([])
  })

  it('порожня історія — це відповідь, а не 404', async () => {
    // Адреса дозволу існує незалежно від того, чи хтось її торкався. `404` тут
    // читався б як «дозволу немає» — тобто як відповідь на інше питання.
    const res = await app({ history: async () => history({ items: [], more: false }) }).request(
      `/v1/allowances/${PDA}/signatures`,
    )

    expect(res.status).toBe(200)
    expect(listSignaturesResponseSchema.parse(await res.json()).items).toEqual([])
  })

  it('каже, що за вікном є старіші транзакції', async () => {
    const res = await app({ history: async () => history({ more: true }) }).request(
      `/v1/allowances/${PDA}/signatures?limit=1`,
    )

    expect(listSignaturesResponseSchema.parse(await res.json()).more).toBe(true)
  })

  it('невідомий час блоку доїжджає як null, а не як «зараз»', async () => {
    const res = await app({
      history: async () =>
        history({
          items: [{ signature: SIGNATURE, slot: SLOT, blockTime: null, failed: true }],
        }),
    }).request(`/v1/allowances/${PDA}/signatures`)

    const body = listSignaturesResponseSchema.parse(await res.json())
    expect(body.items[0]?.blockTime).toBeNull()
    expect(body.items[0]?.failed).toBe(true)
  })
})
