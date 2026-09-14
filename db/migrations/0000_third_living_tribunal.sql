CREATE TABLE "budget_counters" (
	"tenant_id" text NOT NULL,
	"day" date NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "budget_counters_tenant_id_day_pk" PRIMARY KEY("tenant_id","day")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"subscriber_id" text NOT NULL,
	"channel" text NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"escalated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"subscriber_id" text NOT NULL,
	"conversation_id" uuid,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"tenant_id" text NOT NULL,
	"subscriber_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_counters_tenant_id_subscriber_id_window_start_pk" PRIMARY KEY("tenant_id","subscriber_id","window_start")
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"outcome" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_tenant_subscriber_uq" ON "conversations" USING btree ("tenant_id","subscriber_id");--> statement-breakpoint
CREATE INDEX "outbox_claim_idx" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "turns_conversation_created_idx" ON "turns" USING btree ("conversation_id","created_at");