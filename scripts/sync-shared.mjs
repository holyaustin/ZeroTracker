// Copies packages/shared/src into mobile/src/shared (the native app can't import files outside its own folder
// when built with EAS). Run automatically before native builds; test/unit.mjs fails if the copy drifts.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages/shared/src"), dst = join(root, "mobile/src/shared");
rmSync(dst, { recursive: true, force: true }); mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log("Synced", readdirSync(dst).length, "shared files to mobile/src/shared");
