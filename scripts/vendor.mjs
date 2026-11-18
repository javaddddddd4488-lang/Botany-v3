// Copies the SheetJS browser bundle from node_modules into public/vendor so the site
// serves it from its own origin (no third-party CDN, works with a strict CSP).
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
const src = "node_modules/xlsx/dist/xlsx.full.min.js";
if (!existsSync(src)) { console.error("Missing " + src + ". Run `npm install` first."); process.exit(1); }
mkdirSync("public/vendor", { recursive: true });
copyFileSync(src, "public/vendor/xlsx.full.min.js");
console.log("Copied SheetJS to public/vendor/xlsx.full.min.js");
