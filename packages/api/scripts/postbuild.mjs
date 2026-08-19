// Post-build: copy the vendored kaspa_bg.wasm into dist/ so the bundled
// JS can find it at runtime (__dirname + "/kaspa_bg.wasm").
// Run automatically via "postbuild" in packages/api/package.json.

import { existsSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(apiRoot, "vendor", "kaspa-wasm", "kaspa_bg.wasm");
const dest = join(apiRoot, "dist", "kaspa_bg.wasm");

if (!existsSync(src)) {
  console.error(`postbuild: wasm source not found: ${src}`);
  process.exit(1);
}

cpSync(src, dest);
console.log(`postbuild: kaspa_bg.wasm -> ${dest}`);
