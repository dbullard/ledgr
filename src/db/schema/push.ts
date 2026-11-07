import { index, pgPolicy, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { households } from "./households";

/**
 * iPhone/iPad devices that signed in and allowed notifications. The server
 * sends to these directly through APNs (see src/lib/push/apns.ts).
 */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    // Hex APNs device token. Unique per household (not globally) so RLS never
    // hides a conflicting row from another household's upsert.
    token: text("token").notNull(),
    // Which APNs host the token was issued for. Debug builds get sandbox
    // tokens, TestFlight/App Store builds get production ones.
    environment: text("environment", { enum: ["sandbox", "production"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_push_devices_household_token").on(table.householdId, table.token),
    index("idx_push_devices_household").on(table.householdId),
    pgPolicy("household_isolation", {
      for: "all",
      using: sql`household_id = current_setting('app.household_id', true)`,
      withCheck: sql`household_id = current_setting('app.household_id', true)`,
    }),
  ],
).enableRLS();

/**
 * One row per notification already sent (or deliberately skipped), so the
 * periodic scan never tells you about the same bill, charge or budget twice.
 */
export const pushEvents = pgTable(
  "push_events",
  {
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    // e.g. "bill:<recurringId>:<dueDate>", "txn:<id>", "budget:<month>:<categoryId>:80"
    eventKey: text("event_key").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.householdId, table.eventKey] }),
    pgPolicy("household_isolation", {
      for: "all",
      using: sql`household_id = current_setting('app.household_id', true)`,
      withCheck: sql`household_id = current_setting('app.household_id', true)`,
    }),
  ],
).enableRLS();
