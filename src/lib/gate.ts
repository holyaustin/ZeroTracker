import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";

/**
 * Server-side verification gate. Every provisioning endpoint (vehicles, driver tokens)
 * must call this with the orgId from the verified session. Status is read from the database
 * on every call, so a suspension takes effect immediately.
 * Returns a 403 response when the org is not APPROVED, otherwise null.
 */
export async function requireApproved(orgId: string): Promise<NextResponse | null> {
  const [org] = await db.select({ status: schema.organizations.status })
    .from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1);
  if (org?.status === "APPROVED") return null;
  return NextResponse.json(
    { error: "Your company must be verified and approved before you can do this.", status: org?.status ?? "UNKNOWN" },
    { status: 403 },
  );
}
