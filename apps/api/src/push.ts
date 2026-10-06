import { pushSubscriptions } from '@cancelchain/db'
import type { PushSubscribeBody, PushUnsubscribeBody } from '@cancelchain/shared'
import { and, eq } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'

/**
 * The API's side of `push_subscriptions` (`T043`): one row per browser and
 * wallet. Sending is the indexer's; here a row is only written and removed.
 */
type PushDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>

export async function hasPushSubscription(db: PushDb, body: PushSubscribeBody): Promise<boolean> {
  const rows = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, body.endpoint),
        eq(pushSubscriptions.owner, body.owner),
        eq(pushSubscriptions.p256dh, body.keys.p256dh),
        eq(pushSubscriptions.auth, body.keys.auth),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * New keys on a known (endpoint, owner) replace the old ones. `created_at`
 * moves too: the indexer sends refusals only from it on, and a browser that
 * re-subscribed after a week away should not get the week's backlog.
 */
export async function savePushSubscription(db: PushDb, body: PushSubscribeBody): Promise<void> {
  const keys = { p256dh: body.keys.p256dh, auth: body.keys.auth }
  const createdAt = new Date().toISOString()
  await db
    .insert(pushSubscriptions)
    .values({ owner: body.owner, endpoint: body.endpoint, ...keys, createdAt })
    .onConflictDoUpdate({
      target: [pushSubscriptions.endpoint, pushSubscriptions.owner],
      set: { ...keys, createdAt },
    })
}

export async function removePushSubscriptions(
  db: PushDb,
  body: PushUnsubscribeBody,
): Promise<number> {
  const rows = await db
    .delete(pushSubscriptions)
    .where(
      body.owner === undefined
        ? eq(pushSubscriptions.endpoint, body.endpoint)
        : and(
            eq(pushSubscriptions.endpoint, body.endpoint),
            eq(pushSubscriptions.owner, body.owner),
          ),
    )
    .returning({ id: pushSubscriptions.id })
  return rows.length
}
