export interface WasmInstance {
  exports: Record<string, unknown>;
}

export interface WasmRuntime {
  Module: { new (bytes: Uint8Array): unknown };
  Instance: { new (module: unknown, imports?: Record<string, unknown>): WasmInstance };
  validate: (bytes: Uint8Array) => boolean;
}

export function getWasmRuntime(): WasmRuntime {
  const runtime = (globalThis as unknown as { WebAssembly?: WasmRuntime }).WebAssembly;
  if (!runtime) {
    throw new Error("WebAssembly is not available in this environment");
  }
  return runtime;
}
