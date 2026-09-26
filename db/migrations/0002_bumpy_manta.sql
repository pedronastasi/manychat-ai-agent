ALTER TABLE "conversations" ADD COLUMN "last_message_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Existing rows take their last activity, not the migration time, so a contact already past an idle gap is not capped for another day (specs/018).
UPDATE "conversations" SET "last_message_at" = "updated_at";
