import { findSubscriptionAuthority } from '@cancelchain/chain'
import { allowances, indexerCursor, watchedWallets } from '@cancelchain/db'
import { address as toAddress } from '@solana/kit'
import { and, asc, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { DecodedTransaction, TransactionRecord } from './decode.js'
import type { StoreDb } from './store.js'
import {
  CATCH_UP_MAX_PAGES,
  CATCH_UP_PAGE,
  createTransactionReader,
  type IndexerLog,
  isTransportError,
  jsonSafe,
  pause,
  reconnectDelayMs,
  type SignatureInfo,
} from './subscribe.js'

/**
 * The fallback without a socket (`T045`, risk #3 in `PLAN.md`): when the
 * program's traffic makes indexing all of it too expensive, the indexer reads
 * only the wallets someone is looking at, every 15 s.
 *
 * A wallet is watched while a `/v1/stream` of it is open — the API keeps
 * `watched_wallets.active_until` ahead (`WALLET_WATCH_TTL_MS`). Per wallet the
 * loop asks `getSignaturesForAddress` of two kinds of address, which together
 * see every instruction that touches the wallet's permissions:
 * - its `SubscriptionAuthority` for each mint — creation, subscribe, resume,
 *   every charge and every refused one, closing the authority;
 * - each permission it holds open — `RevokeDelegation` and
 *   `CancelSubscription[Now]` carry no authority account.
 * Not the wallet itself: its swaps and transfers would each cost a
 * `getTransaction` only to be thrown away.
 *
 * Every address keeps its own cursor (`indexer_cursor`, `address:` + address),
 * so a wallet that comes back after a week is caught up from where it was
 * left — no silent gap (`SC-013`); the first time, as deep as the feed keeps
 * (`EVENTS_RETENTION_DAYS`). Once all its addresses are read to the head, the
 * wallet's `synced_at` moves: in this mode that, not the program's heartbeat,
 * is how fresh its feed is.
 *
 * A wallet nobody watches is not read. A refusal while its page is closed is
 * stored at the next visit, and its push goes out then, not when it happened.
 */

export const POLL_INTERVAL_MS = 15_000

/** The fallback's pulse in `indexer_heartbeat`: alive, but not reading the whole program. */
export const POLL_HEARTBEAT = 'wallet-poll'

export const ADDRESS_CURSOR_PREFIX = 'address:'

export type PolledSignature = SignatureInfo & {
  /** Seconds; `null` when the node does not say. */
  blockTime: number | null
}

export type WalletSource = {
  /** Newest first, at most `limit`; strictly newer than `until` and older than `before` when given. */
  signaturesFor(
    address: string,
    page: { until?: string; before?: string; limit: number },
  ): Promise<readonly PolledSignature[]>
  /** `null` while the node does not have it yet. */
  transaction(signature: string): Promise<TransactionRecord | null>
  /** Permissions the chain holds for the wallet right now, including ones it cannot read. */
  permissionsOf(owner: string): Promise<readonly string[]>
}

/** What the loop keeps in the database. */
export type WalletBook = {
  /** Wallets whose stream was alive within `WALLET_WATCH_TTL_MS` of `at`. */
  watched(at: Date): Promise<string[]>
  /** Permissions of the wallet the cache holds and has not seen closed. */
  permissions(owner: string): Promise<{ pda: string; mint: string }[]>
  cursor(address: string): Promise<SignatureInfo | null>
  /** Never moves a cursor back. */
  advance(address: string, to: SignatureInfo): Promise<void>
  /** Never moves `synced_at` back. */
  synced(owner: string, at: Date): Promise<void>
}

export type RunWalletPollerOptions = {
  source: WalletSource
  book: WalletBook
  /** Reads permissions from the chain into the cache (`Store.refresh`). */
  refresh: (pdas: readonly string[]) => Promise<unknown>
  /** Stores one transaction; must not move the program's cursor. Throwing = retried next round. */
  sink: (decoded: DecodedTransaction) => Promise<void>
  log: IndexerLog
  signal: AbortSignal
  /** USDC (`FR-020`): its authority is read even before the wallet holds a permission. */
  settlementMint: string
  /** How far back a wallet read for the first time goes; `null` — as far as `CATCH_UP_MAX_PAGES`. */
  retentionDays: number | null
  intervalMs?: number
  /** After each round in which the node answered: the fallback's pulse. */
  onRound?: () => void
  now?: () => Date
  /** Between fetch attempts of one transaction (`TRANSACTION_FETCH_INTERVAL_MS`). */
  sleep?: (ms: number) => Promise<void>
}

export async function runWalletPoller(options: RunWalletPollerOptions): Promise<void> {
  const { source, book, log, signal } = options
  const now = options.now ?? (() => new Date())
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS
  const read = createTransactionReader({
    source,
    log,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  })
  /** Watched in the previous round: listed from the chain already. */
  const known = new Set<string>()
  let failures = 0

  /** Everything after `from` at one address, newest first; the first time, back to the retention cut. */
  async function collect(address: string, from: SignatureInfo | null): Promise<PolledSignature[]> {
    const cut =
      from === null && options.retentionDays !== null
        ? Math.floor(now().getTime() / 1000) - options.retentionDays * 24 * 60 * 60
        : null
    const items: PolledSignature[] = []
    let before: string | undefined
    for (let page = 0; page < CATCH_UP_MAX_PAGES; page++) {
      const batch = await source.signaturesFor(address, {
        ...(from === null ? {} : { until: from.signature }),
        ...(before === undefined ? {} : { before }),
        limit: CATCH_UP_PAGE,
      })
      const kept = batch.filter(
        (item) => cut === null || item.blockTime === null || item.blockTime >= cut,
      )
      items.push(...kept)
      if (batch.length < CATCH_UP_PAGE || kept.length < batch.length) return items
      before = batch[batch.length - 1]?.signature
    }
    log.error(
      { address, from: from?.signature ?? null, indexedFrom: before, pages: CATCH_UP_MAX_PAGES },
      'gap too large for catch-up — history between these points is not indexed',
    )
    return items
  }

  async function addressesOf(owner: string): Promise<string[]> {
    const held = await book.permissions(owner)
    const mints = new Set([options.settlementMint, ...held.map((row) => row.mint)])
    const authorities = await Promise.all(
      [...mints].map(
        async (mint) =>
          (await findSubscriptionAuthority({ user: toAddress(owner), tokenMint: toAddress(mint) }))
            .address as string,
      ),
    )
    return [...new Set([...authorities, ...held.map((row) => row.pda)])]
  }

  /** One wallet to the head. Returns how many transactions were new to it. */
  async function pollWallet(owner: string): Promise<number> {
    const startedAt = now()
    if (!known.has(owner)) {
      // A permission older than the retention cut, never charged since, has
      // nothing at the authority to be found by — the chain names it.
      await options.refresh(await source.permissionsOf(owner))
    }
    const found = new Map<string, PolledSignature>()
    const heads = new Map<string, SignatureInfo>()
    for (const address of await addressesOf(owner)) {
      const items = await collect(address, await book.cursor(address))
      const [newest] = items
      if (newest !== undefined) heads.set(address, newest)
      for (const item of items) found.set(item.signature, item)
    }
    // Oldest first, as the log loop's catch-up: a cancel is stored after the charge before it.
    const ordered = [...found.values()].sort((a, b) =>
      a.slot === b.slot ? 0 : a.slot < b.slot ? -1 : 1,
    )
    for (const item of ordered) {
      if (signal.aborted) return 0
      const result = await read(item)
      if (result.status !== 'decoded') continue
      for (const problem of result.decoded.problems) {
        log.error(
          { signature: result.decoded.signature, problem: jsonSafe(problem) },
          'decode problem',
        )
      }
      await options.sink(result.decoded)
    }
    // Cursors move only once everything before them is stored: a round that
    // failed half-way is read again from the same place, and the database's
    // unique key absorbs what was stored already.
    for (const [address, head] of heads) await book.advance(address, head)
    await book.synced(owner, startedAt)
    return found.size
  }

  log.info({ intervalMs, retentionDays: options.retentionDays }, 'polling watched wallets')
  while (!signal.aborted) {
    const started = Date.now()
    let refused = false
    try {
      const owners = await book.watched(now())
      for (const owner of known) if (!owners.includes(owner)) known.delete(owner)
      for (const owner of owners) {
        if (signal.aborted) break
        try {
          const fresh = await pollWallet(owner)
          if (!known.has(owner)) log.info({ owner, found: fresh }, 'wallet caught up')
          else if (fresh > 0) log.info({ owner, found: fresh }, 'wallet polled')
          known.add(owner)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (isTransportError(error)) {
            // The node is refusing us: the rest of the round would be refused too.
            refused = true
            log.warn({ owner, error: message }, 'node refused the poll — backing off')
            break
          }
          log.warn({ owner, error: message }, 'wallet poll failed')
        }
      }
    } catch (error) {
      refused = true
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'poll round failed',
      )
    }
    if (signal.aborted) break
    if (!refused) options.onRound?.()
    failures = refused ? failures + 1 : 0
    await pause(
      refused ? reconnectDelayMs(failures) : Math.max(0, intervalMs - (Date.now() - started)),
      signal,
    )
  }
  log.info({}, 'stopped polling')
}

export function createWalletBook(db: StoreDb): WalletBook {
  return {
    async watched(at) {
      const rows = await db
        .select({ owner: watchedWallets.owner })
        .from(watchedWallets)
        .where(gt(watchedWallets.activeUntil, at.toISOString()))
        .orderBy(asc(watchedWallets.owner))
      return rows.map((row) => row.owner)
    },
    async permissions(owner) {
      return db
        .select({ pda: allowances.pda, mint: allowances.mint })
        .from(allowances)
        .where(and(eq(allowances.owner, owner), ne(allowances.status, 'revoked')))
        .orderBy(asc(allowances.pda))
    },
    async cursor(address) {
      const [row] = await db
        .select({ signature: indexerCursor.lastSignature, slot: indexerCursor.lastSlot })
        .from(indexerCursor)
        .where(eq(indexerCursor.name, ADDRESS_CURSOR_PREFIX + address))
        .limit(1)
      return row === undefined ? null : { signature: row.signature, slot: BigInt(row.slot) }
    },
    async advance(address, to) {
      const values = {
        lastSignature: to.signature,
        lastSlot: Number(to.slot),
        updatedAt: new Date().toISOString(),
      }
      await db
        .insert(indexerCursor)
        .values({ name: ADDRESS_CURSOR_PREFIX + address, ...values })
        .onConflictDoUpdate({
          target: indexerCursor.name,
          set: values,
          setWhere: sql`${indexerCursor.lastSlot} <= ${values.lastSlot}`,
        })
    },
    async synced(owner, at) {
      const syncedAt = at.toISOString()
      await db
        .update(watchedWallets)
        .set({ syncedAt })
        .where(
          and(
            eq(watchedWallets.owner, owner),
            or(isNull(watchedWallets.syncedAt), lt(watchedWallets.syncedAt, syncedAt)),
          ),
        )
    },
  }
}
