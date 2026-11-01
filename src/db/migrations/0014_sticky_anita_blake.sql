ALTER TABLE "recurring_transactions" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD COLUMN "source" text DEFAULT 'detected' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD COLUMN "match_name" text;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD COLUMN "match_min_amount" integer;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD COLUMN "match_max_amount" integer;--> statement-breakpoint
ALTER TABLE "recurring_transactions" ADD COLUMN "match_day_of_month" integer;