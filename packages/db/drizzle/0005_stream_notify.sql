-- Live updates for `/v1/stream` (`T042`). The indexer and the API are separate
-- processes that share only this database, so the database says what changed:
-- a notification is sent on commit and only if the transaction commits, whoever
-- the writer is. The payload names the row, not its contents — the API reads the
-- row itself, and only for a wallet that has a stream open.
--
-- The channel name is `STREAM_CHANNEL` in `packages/db/src/stream.ts`.
CREATE FUNCTION "stream_notify_event"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_notify('cancelchain_stream', json_build_object(
		'kind', 'event',
		'id', NEW."id"::text,
		'pda', NEW."allowance_pda",
		'owner', (SELECT "owner" FROM "allowances" WHERE "pda" = NEW."allowance_pda")
	)::text);
	RETURN NULL;
END
$$;--> statement-breakpoint
CREATE FUNCTION "stream_notify_allowance"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_notify('cancelchain_stream', json_build_object(
		'kind', 'allowance',
		'pda', NEW."pda",
		'owner', NEW."owner"
	)::text);
	RETURN NULL;
END
$$;--> statement-breakpoint
-- `ON CONFLICT DO NOTHING` inserts nothing on a duplicate, so a re-read
-- transaction does not announce its events a second time.
CREATE TRIGGER "events_stream_notify" AFTER INSERT ON "events"
	FOR EACH ROW EXECUTE FUNCTION "stream_notify_event"();--> statement-breakpoint
CREATE TRIGGER "allowances_stream_notify_insert" AFTER INSERT ON "allowances"
	FOR EACH ROW EXECUTE FUNCTION "stream_notify_allowance"();--> statement-breakpoint
-- Only what a person can see. Every reconciliation rewrites `synced_at` and
-- `last_slot`; announcing that would wake every open card for nothing.
CREATE TRIGGER "allowances_stream_notify_update" AFTER UPDATE ON "allowances"
	FOR EACH ROW WHEN ((
		OLD."owner", OLD."delegate", OLD."mint", OLD."kind", OLD."cap_amount",
		OLD."period_seconds", OLD."spent_in_period", OLD."period_started_at",
		OLD."expires_at", OLD."paused_at", OLD."ends_at", OLD."status", OLD."plan_pda"
	) IS DISTINCT FROM (
		NEW."owner", NEW."delegate", NEW."mint", NEW."kind", NEW."cap_amount",
		NEW."period_seconds", NEW."spent_in_period", NEW."period_started_at",
		NEW."expires_at", NEW."paused_at", NEW."ends_at", NEW."status", NEW."plan_pda"
	))
	EXECUTE FUNCTION "stream_notify_allowance"();
