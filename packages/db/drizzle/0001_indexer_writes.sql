ALTER TABLE "events" DROP CONSTRAINT "events_kind_check";--> statement-breakpoint
ALTER TABLE "allowances" DROP CONSTRAINT "allowances_plan_pda_plans_pda_fk";
--> statement-breakpoint
DROP INDEX "events_signature_allowance_kind_key";--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "position" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "charges_stop_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "indexer_cursor" ADD COLUMN "last_signature" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_signature_position_allowance_key" ON "events" USING btree ("signature","position","allowance_pda");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_charges_stop_at_only_on_cancelled" CHECK (("events"."kind" = 'cancelled') = ("events"."charges_stop_at" is not null));--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_kind_check" CHECK ("events"."kind" in ('created', 'charged', 'rejected', 'paused', 'resumed', 'revoked', 'cancelled'));