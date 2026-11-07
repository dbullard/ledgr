CREATE TABLE "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"environment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "push_events" (
	"household_id" text NOT NULL,
	"event_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_events_household_id_event_key_pk" PRIMARY KEY("household_id","event_key")
);
--> statement-breakpoint
ALTER TABLE "push_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_events" ADD CONSTRAINT "push_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_push_devices_household_token" ON "push_devices" USING btree ("household_id","token");--> statement-breakpoint
CREATE INDEX "idx_push_devices_household" ON "push_devices" USING btree ("household_id");--> statement-breakpoint
CREATE POLICY "household_isolation" ON "push_devices" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.household_id', true)) WITH CHECK (household_id = current_setting('app.household_id', true));--> statement-breakpoint
CREATE POLICY "household_isolation" ON "push_events" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.household_id', true)) WITH CHECK (household_id = current_setting('app.household_id', true));