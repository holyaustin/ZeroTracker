// Usage: node scripts/hash-password.mjs "YourOwnerPassword"
import bcrypt from "bcryptjs";
const pw = process.argv[2];
if (!pw || pw.length < 12) { console.error("Give a password of at least 12 characters:\n  node scripts/hash-password.mjs \"your long owner password\""); process.exit(1); }
const hash = bcrypt.hashSync(pw, 12);
console.log("\nOWNER_PASSWORD_HASH for Vercel's environment-variable form (paste as-is):\n  " + hash);
console.log("\nOWNER_PASSWORD_HASH for a local .env.local file (the $ signs MUST be escaped, or Next.js expands them and corrupts the hash):\n  " + hash.replace(/\$/g, "\\$") + "\n");
