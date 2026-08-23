import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: ["@kticket/kit"],
  // The vendored kaspa-wasm is CommonJS; bundling it into ESM breaks its
  // `module`/`__dirname` globals. Load it as-is at runtime instead.
  external: [/kaspa-wasm\/kaspa\.js$/],
});
