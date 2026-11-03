import {
  pgTable, pgEnum, uuid, text, timestamp, integer, doublePrecision,
  boolean, bigserial, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orgStatus = pgEnum("org_status", ["UNVERIFIED", "PENDING", "APPROVED", "SUSPENDED", "REJECTED"]);
export const tokenStatus = pgEnum("token_status", ["ACTIVE", "REVOKED"]);
export const appState = pgEnum("app_state", ["FOREGROUND", "BACKGROUNDED"]);
export const incidentType = pgEnum("incident_type", [
  "IMPACT", "POTHOLE", "LOW_BATTERY", "BACKGROUNDED", "FOREGROUNDED", "DISCONNECTED", "CONNECTED", "GPS_PING",
]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(), // bcrypt hash of the access key
  status: orgStatus("status").notNull().default("UNVERIFIED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const companyProfiles = pgTable("company_profiles", {
  orgId: uuid("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  cacOrBnNumber: text("cac_or_bn_number").notNull(),
  whatsappNumber: text("whatsapp_number").notNull(),
  hqAddress: text("hq_address").notNull(),
  estimatedFleetSize: integer("estimated_fleet_size").notNull(),
  operationCategory: text("operation_category").notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNote: text("review_note"),
});

export const passwordResets = pgTable("password_resets", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const vehicles = pgTable("vehicles", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  plateNumber: text("plate_number"),
  driverName: text("driver_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const driverTokens = pgTable("driver_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  vehicleId: uuid("vehicle_id").notNull().references(() => vehicles.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  status: tokenStatus("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
}, (t) => ({
  hashIdx: uniqueIndex("driver_tokens_hash_idx").on(t.tokenHash),
  // A vehicle can have at most one ACTIVE link at a time (race-safe, enforced by the database).
  oneActive: uniqueIndex("driver_tokens_one_active_idx").on(t.vehicleId).where(sql`${t.status} = 'ACTIVE'`),
}));

export const telemetry = pgTable("telemetry", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  vehicleId: uuid("vehicle_id").notNull(),
  orgId: uuid("org_id").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  speedKmh: doublePrecision("speed_kmh"),
  accuracyM: doublePrecision("accuracy_m"),
  heading: doublePrecision("heading"),
  batteryPct: integer("battery_pct"),
  charging: boolean("charging"),
  appState: appState("app_state").notNull().default("FOREGROUND"),
  clientEventId: text("client_event_id").notNull().unique(), // idempotent batch inserts
}, (t) => ({ vehTsIdx: index("telemetry_vehicle_ts_idx").on(t.vehicleId, t.ts) }));

export const incidents = pgTable("incidents", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  vehicleId: uuid("vehicle_id").notNull(),
  orgId: uuid("org_id").notNull(),
  type: incidentType("type").notNull(),
  gForce: doublePrecision("g_force"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  message: text("message"),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  clientEventId: text("client_event_id").unique(),
}, (t) => ({ orgTsIdx: index("incidents_org_ts_idx").on(t.orgId, t.ts) }));

export const vehicleStatus = pgTable("vehicle_status", {
  vehicleId: uuid("vehicle_id").primaryKey().references(() => vehicles.id, { onDelete: "cascade" }),
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  lastSpeedKmh: doublePrecision("last_speed_kmh"),
  lastBatteryPct: integer("last_battery_pct"),
  appState: appState("app_state").default("FOREGROUND"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),   // server time of the last event received
  lastTs: timestamp("last_ts", { withTimezone: true }),             // device time of the newest position (keeps batches in order)
  lastLoggedAt: timestamp("last_logged_at", { withTimezone: true }), // device time of the last sampled GPS_PING log entry
  online: boolean("online").notNull().default(false),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actor: text("actor").notNull(),       // "owner" or "manager:<orgId>"
  action: text("action").notNull(),     // e.g. COMPANY_APPROVED, TOKEN_REVOKED
  targetId: text("target_id"),
  note: text("note"),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
});

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});
