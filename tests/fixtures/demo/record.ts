import {
  apiErrorSchema,
  type EventKind,
  getAllowanceResponseSchema,
  listAllowancesResponseSchema,
  listEventsResponseSchema,
  listSignaturesResponseSchema,
} from '@cancelchain/shared'
import type { RecordedResponse } from '@cancelchain/shared/snapshot'

/**
 * Recording what the API answers at one stage of the demo scenario (`T058`).
 *
 * The paths are the ones the app's API client builds (`apps/web/src/lib/api.ts`)
 * for the screens a show goes through: the wallet's list, and the card, history
 * and feed of every permission in the scenario. A path the replay was not given
 * fails on screen as an unreachable API — the web test over the committed
 * recording catches a drift between the two before a show does.
 */

/** The part of a Zod schema used here — `zod` itself is not a dependency of this package. */
type Schema = { safeParse(value: unknown): { success: boolean; error?: unknown } }

/** Pages of a feed recorded past the first, at most. The scenario's feeds fit in one. */
const MAX_FEED_PAGES = 5

export type StagePaths = {
  list: string
  cards: string[]
  signatures: string[]
  feeds: string[]
}

export function stagePaths(owner: string, pdas: readonly string[]): StagePaths {
  const one = (pda: string) => `/v1/allowances/${encodeURIComponent(pda)}`
  return {
    list: `/v1/allowances?owner=${encodeURIComponent(owner)}`,
    cards: pdas.map(one),
    signatures: pdas.map((pda) => `${one(pda)}/signatures`),
    feeds: pdas.map((pda) => `${one(pda)}/events`),
  }
}

export type GetJson = (url: string) => Promise<RecordedResponse>

export const getJson: GetJson = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    // Render answers a restart with an HTML page; the status says enough.
    return { status: response.status, body: text }
  }
}

/**
 * The API did not answer for the record: rate-limited, restarting, or asleep.
 * Recording it would put "try again later" into the show, so the stage is read
 * again instead.
 */
export class UnsettledAnswerError extends Error {
  constructor(path: string, status: number) {
    super(`${path} answered ${status}`)
    this.name = 'UnsettledAnswerError'
  }
}

export class RecordedContractError extends Error {
  constructor(path: string, status: number, cause: unknown) {
    super(`${path} answered ${status} with a body that does not match the contract`)
    this.name = 'RecordedContractError'
    this.cause = cause
  }
}

/**
 * The same check the app makes when it reads the answer: a success against the
 * route's schema, a failure against the error format. A recording the client
 * would refuse is useless at the show, so it is refused here, while devnet is up.
 */
function checked(path: string, schema: Schema, response: RecordedResponse): RecordedResponse {
  if (response.status === 429 || response.status >= 500) {
    throw new UnsettledAnswerError(path, response.status)
  }
  const parsed = (response.status < 400 ? schema : apiErrorSchema).safeParse(response.body)
  if (!parsed.success) throw new RecordedContractError(path, response.status, parsed.error)
  return response
}

export async function recordStage(
  apiUrl: string,
  paths: StagePaths,
  get: GetJson = getJson,
): Promise<Record<string, RecordedResponse>> {
  const responses: Record<string, RecordedResponse> = {}
  const record = async (path: string, schema: Schema): Promise<RecordedResponse> => {
    const response = checked(path, schema, await get(`${apiUrl}${path}`))
    responses[path] = response
    return response
  }

  await record(paths.list, listAllowancesResponseSchema)
  for (const path of paths.cards) await record(path, getAllowanceResponseSchema)
  for (const path of paths.signatures) await record(path, listSignaturesResponseSchema)
  for (const path of paths.feeds) {
    let response = await record(path, listEventsResponseSchema)
    for (let page = 1; page < MAX_FEED_PAGES; page += 1) {
      if (response.status >= 400) break
      const { nextCursor } = listEventsResponseSchema.parse(response.body)
      if (nextCursor === null) break
      response = await record(
        `${path}?cursor=${encodeURIComponent(nextCursor)}`,
        listEventsResponseSchema,
      )
    }
  }
  return responses
}

/**
 * One string field of every item of a recorded page. The bodies were checked
 * against their schemas when recorded; this reads only what the expectations need.
 */
function itemFields(body: unknown, field: string): string[] {
  if (typeof body !== 'object' || body === null || !('items' in body)) return []
  const { items } = body
  if (!Array.isArray(items)) return []
  return items.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return []
    const value: unknown = (item as Record<string, unknown>)[field]
    return typeof value === 'string' ? [value] : []
  })
}

/** What a stage must show before it is worth recording. */
export type StageExpectation = {
  listed: readonly string[]
  /**
   * Gone from the list, and a card that says so: the API keeps a cancelled
   * permission's card from its store, marked `revoked`, with its feed under it.
   */
  cancelled: readonly string[]
  /** Event kinds each permission's feed must already hold — the indexer lags the chain. */
  feeds: Readonly<Record<string, readonly EventKind[]>>
}

/**
 * The expectations the stage does not meet yet, in words. Empty — ready.
 */
export function unmetExpectations(
  responses: Readonly<Record<string, RecordedResponse>>,
  paths: StagePaths,
  expectation: StageExpectation,
): string[] {
  const unmet: string[] = []
  const list = responses[paths.list]
  const listed = list === undefined || list.status >= 400 ? [] : itemFields(list.body, 'pda')

  for (const pda of expectation.listed) {
    if (!listed.includes(pda)) unmet.push(`${pda} is not listed yet`)
  }
  for (const pda of expectation.cancelled) {
    if (listed.includes(pda)) unmet.push(`${pda} is still listed`)
    const card = responses[stagePaths('', [pda]).cards[0] ?? '']
    const status =
      card === undefined || card.status >= 400
        ? null
        : (card.body as Record<string, unknown> | null)?.status
    if (card?.status !== 404 && status !== 'revoked') {
      unmet.push(`the card of ${pda} does not say revoked yet`)
    }
  }
  for (const [pda, kinds] of Object.entries(expectation.feeds)) {
    const feed = responses[stagePaths('', [pda]).feeds[0] ?? '']
    const seen = feed === undefined || feed.status >= 400 ? [] : itemFields(feed.body, 'kind')
    for (const kind of kinds) {
      if (!seen.includes(kind)) unmet.push(`the feed of ${pda} has no ${kind} event yet`)
    }
  }
  return unmet
}
