CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"transaction_id" text,
	"file_path" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"source" text DEFAULT 'upload' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_receipts_txn" ON "receipts" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_receipts_household_sha" ON "receipts" USING btree ("household_id","sha256");