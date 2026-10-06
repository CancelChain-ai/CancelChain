CREATE TABLE "push_deliveries" (
	"subscription_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_deliveries_subscription_id_kind_ref_pk" PRIMARY KEY("subscription_id","kind","ref"),
	CONSTRAINT "push_deliveries_kind_check" CHECK ("push_deliveries"."kind" in ('upcoming', 'rejected'))
);
--> statement-breakpoint
DROP INDEX "push_subscriptions_endpoint_key";--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_subscription_id_push_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."push_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint_owner_key" ON "push_subscriptions" USING btree ("endpoint","owner");