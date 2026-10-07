CREATE TABLE "eval_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"playbook_hash" text NOT NULL,
	"suite_hash" text NOT NULL,
	"model" text NOT NULL,
	"outcomes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insight_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"text" text NOT NULL,
	"rationale" text NOT NULL,
	"enrolled_count" integer NOT NULL,
	"not_enrolled_count" integer NOT NULL,
	"turn_ids" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"week" text NOT NULL,
	"forced" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"enrolled_count" integer,
	"not_enrolled_count" integer,
	"cost_usd" numeric(12, 6),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "playbook_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"insights" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "playbook_version" text;--> statement-breakpoint
ALTER TABLE "insight_proposals" ADD CONSTRAINT "insight_proposals_run_id_learning_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."learning_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eval_records_lookup_idx" ON "eval_records" USING btree ("tenant_id","playbook_hash","suite_hash");--> statement-breakpoint
CREATE INDEX "insight_proposals_tenant_status_idx" ON "insight_proposals" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_runs_week_uq" ON "learning_runs" USING btree ("tenant_id","week") WHERE "learning_runs"."forced" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_versions_content_uq" ON "playbook_versions" USING btree ("tenant_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_versions_one_active_uq" ON "playbook_versions" USING btree ("tenant_id") WHERE "playbook_versions"."active" = true;