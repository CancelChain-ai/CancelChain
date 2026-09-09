import { latestBlockhashResponseSchema } from '@cancelchain/shared'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createLogger, requestLogger } from '../logger.js'
import type { AppEnv } from '../types.js'
import { type BlockhashDeps, blockhashRoute } from './blockhash.js'

const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const SLOT = 492_096_495

/** Понад `Number.MAX_SAFE_INTEGER` — рівно те, що числом не переживає JSON. */
const HUGE_HEIGHT = 9_007_199_254_740_995n

function app(deps: Partial<BlockhashDeps> = {}) {
  const instance = new Hono<AppEnv>()
  instance.use('*', requestLogger(createLogger('silent')))
  return instance.route(
    '/',
    blockhashRoute({
      latestBlockhash: async () => ({
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 492_096_795n,
        slot: SLOT,
      }),
      ...deps,
    }),
  )
}

describe('GET /v1/blockhash', () => {
  it('віддає рівно ту форму, яку описує схема зі shared', async () => {
    const res = await app().request('/v1/blockhash')
    expect(res.status).toBe(200)
    const body = latestBlockhashResponseSchema.parse(await res.json())
    expect(body).toEqual({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: '492096795',
      slot: SLOT,
    })
  })

  /**
   * Головне, заради чого цей тест існує. Висота блоку — u64, і числом вона
   * втратила б молодші розряди мовчки: транзакція вважалася б живою довше або
   * менше, ніж є насправді, а помилка виглядала б як «гаманець не встиг».
   */
  it('висота блоку їде рядком і переживає значення понад 2^53', async () => {
    const res = await app({
      latestBlockhash: async () => ({
        blockhash: BLOCKHASH,
        lastValidBlockHeight: HUGE_HEIGHT,
        slot: SLOT,
      }),
    }).request('/v1/blockhash')

    const raw: unknown = await res.json()
    const body = latestBlockhashResponseSchema.parse(raw)
    expect(body.lastValidBlockHeight).toBe('9007199254740995')
    expect(BigInt(body.lastValidBlockHeight)).toBe(HUGE_HEIGHT)
  })
})
