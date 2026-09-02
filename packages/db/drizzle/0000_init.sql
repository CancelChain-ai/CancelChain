CREATE TABLE "allowances" (
	"pda" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"delegate" text NOT NULL,
	"mint" text NOT NULL,
	"kind" text NOT NULL,
	"cap_amount" bigint NOT NULL,
	"period_seconds" integer,
	"spent_in_period" bigint DEFAULT 0 NOT NULL,
	"period_started_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"status" text NOT NULL,
	"plan_pda" text,
	"last_slot" bigint NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowances_kind_check" CHECK ("allowances"."kind" in ('fixed', 'recurring', 'subscription')),
	CONSTRAINT "allowances_status_check" CHECK ("allowances"."status" in ('active', 'paused', 'revoked', 'exhausted')),
	CONSTRAINT "allowances_pause_is_subscription_only" CHECK ("allowances"."paused_at" is null or "allowances"."kind" = 'subscription'),
	CONSTRAINT "allowances_ends_at_is_subscription_only" CHECK ("allowances"."ends_at" is null or "allowances"."kind" = 'subscription'),
	CONSTRAINT "allowances_period_matches_kind" CHECK (("allowances"."kind" = 'fixed') = ("allowances"."period_seconds" is null))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"allowance_pda" text NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint,
	"reason" text,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"raw" jsonb,
	CONSTRAINT "events_kind_check" CHECK ("events"."kind" in ('created', 'charged', 'rejected', 'paused', 'resumed', 'revoked')),
	CONSTRAINT "events_reason_check" CHECK ("events"."reason" is null or "events"."reason" in ('revoked', 'cap_exceeded', 'paused', 'expired', 'insufficient_funds', 'wrong_mint', 'not_due_yet')),
	CONSTRAINT "events_reason_only_on_rejected" CHECK ("events"."reason" is null or "events"."kind" = 'rejected'),
	CONSTRAINT "events_charge_has_amount" CHECK ("events"."kind" <> 'charged' or "events"."amount" is not null)
);
--> statement-breakpoint
CREATE TABLE "indexer_cursor" (
	"name" text PRIMARY KEY NOT NULL,
	"last_slot" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"address" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"pda" text PRIMARY KEY NOT NULL,
	"merchant" text NOT NULL,
	"plan_id" bigint NOT NULL,
	"name" text NOT NULL,
	"amount" bigint NOT NULL,
	"period_seconds" integer NOT NULL,
	"mint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allowances" ADD CONSTRAINT "allowances_plan_pda_plans_pda_fk" FOREIGN KEY ("plan_pda") REFERENCES "public"."plans"("pda") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_allowance_pda_allowances_pda_fk" FOREIGN KEY ("allowance_pda") REFERENCES "public"."allowances"("pda") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allowances_owner_status_idx" ON "allowances" USING btree ("owner","status");--> statement-breakpoint
CREATE INDEX "allowances_delegate_status_idx" ON "allowances" USING btree ("delegate","status");--> statement-breakpoint
CREATE UNIQUE INDEX "events_signature_allowance_kind_key" ON "events" USING btree ("signature","allowance_pda","kind");--> statement-breakpoint
CREATE INDEX "events_allowance_block_time_idx" ON "events" USING btree ("allowance_pda","block_time" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_owner_idx" ON "push_subscriptions" USING btree ("owner");