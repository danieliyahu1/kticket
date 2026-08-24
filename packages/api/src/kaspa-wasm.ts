// Shared loader for the vendored kaspa-wasm. Lives at `src/` root so the
// `../vendor/...` path resolves identically from source and from the bundled
// `dist/index.js` (which sits at the same depth under `packages/api`).

export type KaspaWasm = Record<string, unknown>;

let wasm: KaspaWasm | null = null;

export async function loadKaspaWasm<T = KaspaWasm>(): Promise<T> {
  if (wasm) return wasm as unknown as T;
  const mod = (await import("../vendor/kaspa-wasm/kaspa.js")) as KaspaWasm;
  wasm = mod;
  return mod as unknown as T;
}