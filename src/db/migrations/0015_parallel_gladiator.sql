CREATE TABLE "recurring_exclusions" (
	"recurring_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	CONSTRAINT "recurring_exclusions_recurring_id_transaction_id_pk" PRIMARY KEY("recurring_id","transaction_id")
);
--> statement-breakpoint
ALTER TABLE "recurring_exclusions" ADD CONSTRAINT "recurring_exclusions_recurring_id_recurring_transactions_id_fk" FOREIGN KEY ("recurring_id") REFERENCES "public"."recurring_transactions"("id") ON DELETE cascade ON UPDATE no action;