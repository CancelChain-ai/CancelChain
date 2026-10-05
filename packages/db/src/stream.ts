/**
 * The channel the database announces changes on (`T042`, migration
 * `0005_stream_notify`). The triggers name it in SQL, so it is spelled twice;
 * `schema.test.ts` holds the two spellings together.
 *
 * What a notification carries — the row, not its contents:
 * - `{ kind: 'event', id, pda, owner }` after an event is stored;
 * - `{ kind: 'allowance', pda, owner }` after a permission is stored or a
 *   visible field of it changes (`synced_at` and `last_slot` alone do not count).
 *
 * `owner` is `null` only if an event arrives for a permission with no row,
 * which the foreign key on `events` rules out.
 */
export const STREAM_CHANNEL = 'cancelchain_stream'
