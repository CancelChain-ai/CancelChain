import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pushDeliveries, pushSubscriptions } from '@cancelchain/db'
import type { PushSubscribeBody } from '@cancelchain/shared'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hasPushSubscription, removePushSubscriptions, savePushSubscription } from './push.js'

/**
 * The subscription table against a real Postgres (PGlite) with the very
 * migrations that go to Supabase: the (endpoint, owner) key and the cascade to
 * `push_deliveries` are the database's work here.
 */
const migrationDir = fileURLToPath(new URL('../drizzle/', import.meta.resolve('@cancelchain/db')))
const migrations = readdirSync(migrationDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) =>
    readFileSync(migrationDir + name, 'utf8').replaceAll('--> statement-breakpoint', ''),
  )

const OWNER = 'CuXtQLBvSmH5RJs5N7tNtDEUa5gR1mK9PUgfruHCvnSR'
const OTHER_OWNER = 'FGHMNoNNq3aMvTxrfeNRzS6SwE7SKZp6UyZ7FMjjf3nk'
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/browser-one'
const OTHER_ENDPOINT = 'https://updates.push.services.mozilla.com/wpush/v2/browser-two'

function body(overrides: Partial<PushSubscribeBody> = {}): PushSubscribeBody {
  return {
    owner: OWNER,
    endpoint: ENDPOINT,
    keys: { p256dh: 'BKeyOne', auth: 'authOne' },
    ...overrides,
  }
}

let client: PGlite
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  client = await PGlite.create()
  for (const migration of migrations) await client.exec(migration)
  db = drizzle(client)
}, 60_000)

afterAll(async () => {
  await client?.close()
})

beforeEach(async () => {
  await client.exec('delete from push_deliveries; delete from push_subscriptions;')
})

describe('push subscriptions', () => {
  it('lets one browser follow two wallets', async () => {
    await savePushSubscription(db, body())
    await savePushSubscription(db, body({ owner: OTHER_OWNER }))
    expect(await db.select().from(pushSubscriptions)).toHaveLength(2)
  })

  it('replaces the keys of a known browser and wallet instead of adding a row', async () => {
    await savePushSubscription(db, body())
    const fresh = body({ keys: { p256dh: 'BKeyTwo', auth: 'authTwo' } })
    expect(await hasPushSubscription(db, fresh)).toBe(false)

    await savePushSubscription(db, fresh)
    const rows = await db.select().from(pushSubscriptions)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ p256dh: 'BKeyTwo', auth: 'authTwo' })
    expect(await hasPushSubscription(db, fresh)).toBe(true)
    expect(await hasPushSubscription(db, body())).toBe(false)
  })

  it('stops one wallet, or all of a browser', async () => {
    await savePushSubscription(db, body())
    await savePushSubscription(db, body({ owner: OTHER_OWNER }))
    await savePushSubscription(db, body({ endpoint: OTHER_ENDPOINT }))

    expect(await removePushSubscriptions(db, { endpoint: ENDPOINT, owner: OWNER })).toBe(1)
    expect(
      (await db.select().from(pushSubscriptions))
        .map((row) => `${row.endpoint} ${row.owner}`)
        .sort(),
    ).toEqual([`${ENDPOINT} ${OTHER_OWNER}`, `${OTHER_ENDPOINT} ${OWNER}`].sort())

    expect(await removePushSubscriptions(db, { endpoint: ENDPOINT })).toBe(1)
    expect(await db.select().from(pushSubscriptions)).toEqual([
      expect.objectContaining({ endpoint: OTHER_ENDPOINT }),
    ])
    expect(await removePushSubscriptions(db, { endpoint: ENDPOINT })).toBe(0)
  })

  it('forgets what was sent to a removed subscription', async () => {
    await savePushSubscription(db, body())
    const [row] = await db.select().from(pushSubscriptions)
    if (row === undefined) throw new Error('no row')
    await db.insert(pushDeliveries).values({ subscriptionId: row.id, kind: 'rejected', ref: '1' })

    await removePushSubscriptions(db, { endpoint: ENDPOINT })
    expect(await db.select().from(pushDeliveries)).toEqual([])
  })
})
