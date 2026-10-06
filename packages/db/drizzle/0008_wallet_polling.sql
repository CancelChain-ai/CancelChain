CREATE TABLE "watched_wallets" (
	"owner" text PRIMARY KEY NOT NULL,
	"active_until" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "watched_wallets_active_until_idx" ON "watched_wallets" USING btree ("active_until");--> statement-breakpoint
-- A watched wallet's feed turns fresh (`T045`): in the polling fallback the page
-- reads `stale` from `synced_at`, and when the catch-up found no new event
-- nothing else would tell it the feed can now be trusted. Announced only when
-- the feed crosses from stale to fresh — a first sync, or one after a gap longer
-- than `EVENTS_STALE_AFTER_MS` (30 s) — not on every 15-second round.
CREATE FUNCTION "stream_notify_wallet"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND OLD."synced_at" IS NOT NULL
		AND NEW."synced_at" - OLD."synced_at" <= interval '30 seconds' THEN
		RETURN NULL;
	END IF;
	PERFORM pg_notify('cancelchain_stream', json_build_object(
		'kind', 'wallet',
		'owner', NEW."owner"
	)::text);
	RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "watched_wallets_stream_notify" AFTER INSERT OR UPDATE OF "synced_at" ON "watched_wallets"
	FOR EACH ROW WHEN (NEW."synced_at" IS NOT NULL)
	EXECUTE FUNCTION "stream_notify_wallet"();
