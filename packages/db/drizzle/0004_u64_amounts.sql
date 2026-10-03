ALTER TABLE "allowances" ALTER COLUMN "cap_amount" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "allowances" ALTER COLUMN "spent_in_period" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "allowances" ALTER COLUMN "spent_in_period" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "amount" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "plan_id" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "amount" SET DATA TYPE numeric(20, 0);--> statement-breakpoint
ALTER TABLE "allowances" ADD CONSTRAINT "allowances_cap_amount_u64" CHECK ("allowances"."cap_amount" between 0 and 18446744073709551615);--> statement-breakpoint
ALTER TABLE "allowances" ADD CONSTRAINT "allowances_spent_in_period_u64" CHECK ("allowances"."spent_in_period" between 0 and 18446744073709551615);--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_amount_u64" CHECK ("events"."amount" between 0 and 18446744073709551615);--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_plan_id_u64" CHECK ("plans"."plan_id" between 0 and 18446744073709551615);--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_amount_u64" CHECK ("plans"."amount" between 0 and 18446744073709551615);