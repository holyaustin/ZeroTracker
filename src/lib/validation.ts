import { z } from "zod";

export const CATEGORIES = [
  "Haulage & freight", "Last-mile delivery", "Courier & logistics", "Passenger transport",
  "Construction & heavy equipment", "Field services", "Other",
] as const;

/** Shared by the server (authoritative) and the wizard (per-step feedback). */
export const ProfileInput = z.object({
  cacOrBnNumber: z.string().trim()
    .transform((s) => s.toUpperCase().replace(/[\s-]/g, ""))
    .pipe(z.string().regex(/^(RC|BN|IT)\d{5,8}$/, "Enter a valid CAC number, e.g. RC1234567 or BN1234567")),
  hqAddress: z.string().trim().min(10, "Enter the full headquarters address").max(300),
  whatsappNumber: z.string().trim()
    .transform((s) => s.replace(/[\s\-()]/g, ""))
    .pipe(z.string().regex(/^\+?\d{8,15}$/, "Enter a valid WhatsApp number, e.g. +2348012345678")),
  estimatedFleetSize: z.coerce.number({ invalid_type_error: "Enter a number" }).int("Whole numbers only")
    .min(1, "Must be at least 1").max(100000, "That looks too large"),
  operationCategory: z.enum(CATEGORIES, { errorMap: () => ({ message: "Choose a category" }) }),
});
