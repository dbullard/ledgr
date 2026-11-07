CREATE TABLE "transaction_category_suggestions" (
	"transaction_id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"category_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transaction_category_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_category_suggestions" ADD CONSTRAINT "transaction_category_suggestions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_category_suggestions" ADD CONSTRAINT "transaction_category_suggestions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_category_suggestions" ADD CONSTRAINT "transaction_category_suggestions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_txn_cat_suggestions_household" ON "transaction_category_suggestions" USING btree ("household_id");--> statement-breakpoint
CREATE POLICY "household_isolation" ON "transaction_category_suggestions" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.household_id', true)) WITH CHECK (household_id = current_setting('app.household_id', true));