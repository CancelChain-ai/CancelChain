CREATE TABLE "events_retention" (
	"name" text PRIMARY KEY NOT NULL,
	"days" integer,
	"kept_since" timestamp with time zone,
	"ran_at" timestamp with time zone NOT NULL,
	CONSTRAINT "events_retention_days_floor" CHECK ("events_retention"."days" is null or "events_retention"."days" >= 90),
	CONSTRAINT "events_retention_cut_matches_days" CHECK (("events_retention"."days" is null) = ("events_retention"."kept_since" is null))
);
