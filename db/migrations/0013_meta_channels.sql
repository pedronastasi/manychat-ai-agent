ALTER TABLE "nudges" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "channel" text;--> statement-breakpoint
-- A contact's earlier messages arrived on the channel their conversation was opened on (specs/048).
UPDATE "turns" SET "channel" = "conversations"."channel" FROM "conversations" WHERE "turns"."conversation_id" = "conversations"."id" AND "turns"."role" = 'user';
