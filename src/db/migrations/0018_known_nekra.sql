ALTER TABLE "bank_connections" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "last_data_at" timestamp with time zone;