ALTER TABLE "push_preferences" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "deposits" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "deposit_cents" integer DEFAULT 50000 NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD COLUMN "weekly" boolean DEFAULT false NOT NULL;