ALTER TABLE "conversations" RENAME COLUMN "course" TO "offering";--> statement-breakpoint
ALTER TABLE "learning_runs" RENAME COLUMN "enrolled_count" TO "converted_count";--> statement-breakpoint
ALTER TABLE "learning_runs" RENAME COLUMN "not_enrolled_count" TO "not_converted_count";--> statement-breakpoint
ALTER TABLE "insight_proposals" RENAME COLUMN "enrolled_count" TO "converted_count";--> statement-breakpoint
ALTER TABLE "insight_proposals" RENAME COLUMN "not_enrolled_count" TO "not_converted_count";
