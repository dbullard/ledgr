ALTER TABLE "categories" ADD COLUMN "system_key" text;
--> statement-breakpoint
UPDATE "categories" SET "system_key" = "name" WHERE "is_system" = true AND "system_key" IS NULL;
