CREATE TABLE "push_preferences" (
	"household_id" text PRIMARY KEY NOT NULL,
	"bills" boolean DEFAULT true NOT NULL,
	"large_charges" boolean DEFAULT true NOT NULL,
	"budgets" boolean DEFAULT true NOT NULL,
	"connections" boolean DEFAULT true NOT NULL,
	"large_charge_cents" integer,
	"quiet_enabled" boolean DEFAULT true NOT NULL,
	"quiet_start_hour" integer,
	"quiet_end_hour" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_preferences" ADD CONSTRAINT "push_preferences_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "push_preferences" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.household_id', true)) WITH CHECK (household_id = current_setting('app.household_id', true));