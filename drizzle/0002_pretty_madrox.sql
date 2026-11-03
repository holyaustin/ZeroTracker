ALTER TABLE "vehicle_status" ADD COLUMN "last_ts" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vehicle_status" ADD COLUMN "last_logged_at" timestamp with time zone;