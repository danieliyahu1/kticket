// Canned compiler outputs for tests (KTK testing: stub external boundaries).
//
// The covenant compiler (`compiler.ts` → the `kticket-silverc` Rust binary) is
// an external dependency (silverscript-lang). Tests never spawn it — instead
// they load the committed artifacts (real compiler output, kept in sync with
// the compiler by CI) and assert the inputs our code sends to the compiler.
//
// `createCompilerMock` is wired via `vi.mock("./compiler.js")` in each test
// file so the production `builders.ts` / `provenance.ts` call paths use the
// same canned artifacts the test harness builds its expected models from.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledContractArtifact } from "@kticket/kit";
import { vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadArtifact(name: "event" | "burn"): CompiledContractArtifact {
  const raw = readFileSync(
    join(HERE, "..", "..", "kit", "artifacts", `${name}.artifact.json`),
    "utf8",
  );
  return JSON.parse(raw) as CompiledContractArtifact;
}

export const cannedEventArtifact = loadArtifact("event");
export const cannedBurnArtifact = loadArtifact("burn");
export const cannedBurnTemplateHash = Buffer.from(cannedBurnArtifact.template_hash).toString("hex");

/**
 * A contract-faithful double for the covenant compiler. Each function records
 * its arguments (so tests can assert the exact inputs) and returns the canned
 * committed artifact — a pre-ready response, never a blind `() => undefined`.
 */
export function createCompilerMock() {
  return {
    compileEventArtifact: vi.fn(() => cannedEventArtifact),
    compileBurnArtifact: vi.fn(() => cannedBurnArtifact),
    burnTemplateHashOf: vi.fn(() => cannedBurnTemplateHash),
    // push(32-byte buyer pubkey) || selector — mirrors the mint sig-script shape.
    eventMintSigScript: vi.fn((_constants: unknown, buyerPkh: string) => `20${buyerPkh}01`),
  };
}
