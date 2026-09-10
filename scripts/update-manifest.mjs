// Deterministic image pin for CI. Replaces the single `image:` line that points
// at ghcr.io with the exact `tag@digest` reference produced by the build, instead
// of an indentation-sensitive `sed`. Fails closed if the manifest does not have
// exactly one ghcr.io image line.
//
// usage: node scripts/update-manifest.mjs <manifest> <image>

import { readFileSync, writeFileSync } from "node:fs";

const [, , manifestPath, image] = process.argv;

if (!manifestPath || !image) {
  console.error("usage: node scripts/update-manifest.mjs <manifest> <image>");
  process.exit(2);
}

const pattern = /^([ \t]*image:[ \t]*)ghcr\.io\/\S+[ \t]*$/gm;
const content = readFileSync(manifestPath, "utf8");
const matches = content.match(pattern);

if (matches === null || matches.length !== 1) {
  console.error(
    `expected exactly one ghcr.io image line in ${manifestPath}, found ${matches?.length ?? 0}`,
  );
  process.exit(1);
}

const updated = content.replace(pattern, (_match, prefix) => `${prefix}${image}`);

if (updated === content) {
  console.log(`${manifestPath} already points at ${image}`);
} else {
  writeFileSync(manifestPath, updated);
  console.log(`${manifestPath} pinned to ${image}`);
}
