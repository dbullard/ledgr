CREATE TABLE "product_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"raw_key" text NOT NULL,
	"product_name" text,
	"category_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipt_items" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"receipt_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"raw_name" text NOT NULL,
	"product_name" text,
	"category_id" text,
	"quantity_milli" integer DEFAULT 1000 NOT NULL,
	"total_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "parsed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_items" ADD CONSTRAINT "receipt_items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_product_aliases_household_key" ON "product_aliases" USING btree ("household_id","raw_key");--> statement-breakpoint
CREATE INDEX "idx_receipt_items_receipt" ON "receipt_items" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "idx_receipt_items_household_product" ON "receipt_items" USING btree ("household_id","product_name");