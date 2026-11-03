// Self-hosts Ably's prebuilt browser bundle (Next's webpack can't bundle it). Runs before dev and build.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
const src = "node_modules/ably/build/ably.min.js";
if (!existsSync(src)) { console.error("ably is not installed. Run npm install."); process.exit(1); }
mkdirSync("public/vendor", { recursive: true });
copyFileSync(src, "public/vendor/ably.min.js");
console.log("Copied Ably browser bundle to public/vendor/ably.min.js");
