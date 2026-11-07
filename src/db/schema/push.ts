import { boolean, index, integer, pgPolicy, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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

/**
 * Which notifications a household wants, and when. One row per household; a
 * missing row means "all defaults" (everything on, $250, quiet 21:00-08:00).
 * Null threshold / hours fall back to the server env defaults.
 */
export const pushPreferences = pgTable(
  "push_preferences",
  {
    householdId: text("household_id")
      .primaryKey()
      .references(() => households.id, { onDelete: "cascade" }),
    // Master switch. Off = the scan still runs and records events (so turning it
    // back on doesn't replay a backlog) but nothing is sent.
    enabled: boolean("enabled").notNull().default(true),
    bills: boolean("bills").notNull().default(true),
    largeCharges: boolean("large_charges").notNull().default(true),
    budgets: boolean("budgets").notNull().default(true),
    connections: boolean("connections").notNull().default(true),
    largeChargeCents: integer("large_charge_cents"),
    // Off until chosen: alert when a checking/savings balance falls below lowBalanceCents.
    // Opt-in extras.
    deposits: boolean("deposits").notNull().default(false),
    depositCents: integer("deposit_cents").notNull().default(50000),
    review: boolean("review").notNull().default(false),
    weekly: boolean("weekly").notNull().default(false),
    lowBalance: boolean("low_balance").notNull().default(false),
    lowBalanceCents: integer("low_balance_cents").notNull().default(10000),
    quietEnabled: boolean("quiet_enabled").notNull().default(true),
    quietStartHour: integer("quiet_start_hour"),
    quietEndHour: integer("quiet_end_hour"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  () => [
    pgPolicy("household_isolation", {
      for: "all",
      using: sql`household_id = current_setting('app.household_id', true)`,
      withCheck: sql`household_id = current_setting('app.household_id', true)`,
    }),
  ],
).enableRLS();
