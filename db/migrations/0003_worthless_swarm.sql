ALTER TABLE "conversations" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "previous_token_hash" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "token_issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "token_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "kind" text DEFAULT 'reply' NOT NULL;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "bound" boolean DEFAULT true NOT NULL;