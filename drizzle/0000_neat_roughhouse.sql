CREATE TYPE "public"."app_state" AS ENUM('FOREGROUND', 'BACKGROUNDED');--> statement-breakpoint
CREATE TYPE "public"."incident_type" AS ENUM('IMPACT', 'POTHOLE', 'LOW_BATTERY', 'BACKGROUNDED', 'FOREGROUNDED', 'DISCONNECTED', 'CONNECTED', 'GPS_PING');--> statement-breakpoint
CREATE TYPE "public"."org_status" AS ENUM('UNVERIFIED', 'PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."token_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_id" text,
	"note" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_profiles" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"cac_or_bn_number" text NOT NULL,
	"whatsapp_number" text NOT NULL,
	"hq_address" text NOT NULL,
	"estimated_fleet_size" integer NOT NULL,
	"operation_category" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"status" "token_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "incidents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "incident_type" NOT NULL,
	"g_force" double precision,
	"lat" double precision,
	"lng" double precision,
	"message" text,
	"ts" timestamp with time zone NOT NULL,
	"client_event_id" text,
	CONSTRAINT "incidents_client_event_id_unique" UNIQUE("client_event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "org_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telemetry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"speed_kmh" double precision,
	"accuracy_m" double precision,
	"heading" double precision,
	"battery_pct" integer,
	"charging" boolean,
	"app_state" "app_state" DEFAULT 'FOREGROUND' NOT NULL,
	"client_event_id" text NOT NULL,
	CONSTRAINT "telemetry_client_event_id_unique" UNIQUE("client_event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vehicle_status" (
	"vehicle_id" uuid PRIMARY KEY NOT NULL,
	"last_lat" double precision,
	"last_lng" double precision,
	"last_speed_kmh" double precision,
	"last_battery_pct" integer,
	"app_state" "app_state" DEFAULT 'FOREGROUND',
	"last_seen_at" timestamp with time zone,
	"online" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"plate_number" text,
	"driver_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_tokens" ADD CONSTRAINT "driver_tokens_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_tokens" ADD CONSTRAINT "driver_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vehicle_status" ADD CONSTRAINT "vehicle_status_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "driver_tokens_hash_idx" ON "driver_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_org_ts_idx" ON "incidents" USING btree ("org_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_vehicle_ts_idx" ON "telemetry" USING btree ("vehicle_id","ts");