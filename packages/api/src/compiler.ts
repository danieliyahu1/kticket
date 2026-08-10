// Per-event contract compilation (KTK-88 A5).
//
// The real compiler bakes the event constants (constructor args) into the
// bytecode at compile time, so each event requires its own compile. This module
// invokes the kticket-silverc wrapper bin (packages/kit/silverc) to produce the
// per-event Event + Burn artifacts, then exposes helpers to derive the event
// redeem script / address / covenant_id for a given state.

import {
  type CompiledContractArtifact,
  covenantId,
  DUST,
  injectState,
  p2shScript,
  type ScriptPublicKey,
} from "@kticket/kit";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const API_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTRACTS_DIR = join(API_ROOT, "..", "kit", "contracts");
const BIN_NAME = process.platform === "win32" ? "kticket-silverc.exe" : "kticket-silverc";
const BIN_PATH = join(API_ROOT, "..", "kit", "silverc", "target", "release", BIN_NAME);

const FIXED32 = { base: "byte", array_dims: [{ kind: "fixed", value: 32 }] };
const DYNAMIC = { base: "byte", array_dims: [{ kind: "dynamic" }] };

function hexToByteExprs(hex: string): { kind: "byte"; data: number }[] {
  const bytes = hexToBytes(hex);
  return Array.from(bytes, (d) => ({ kind: "byte", data: d }));
}

function byteArrayArg(type: unknown, hex: string) {
  return { kind: "array", data: { type_ref: type, values: hexToByteExprs(hex) } };
}

function intArg(value: number) {
  return { kind: "int", data: value };
}

function runRust(args: string[]): string {
  if (!existsSync(BIN_PATH)) {
    throw new Error(
      `kticket-silverc binary not found at ${BIN_PATH}; run \`cargo build --release\` in packages/kit/silverc`,
    );
  }
  return execFileSync(BIN_PATH, args, { encoding: "utf8" });
}

function compileContract(name: string, ctorArgs: unknown[]): CompiledContractArtifact {
  const dir = mkdtempSync(join(tmpdir(), "kticket-ctor-"));
  const ctorFile = join(dir, "ctor.json");
  writeFileSync(ctorFile, JSON.stringify(ctorArgs));
  try {
    return JSON.parse(
      runRust(["compile", join(CONTRACTS_DIR, `${name}.sil`), "--ctor", ctorFile]),
    ) as CompiledContractArtifact;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compile the burn contract for one event (authorizing_txid baked). */
export function compileBurnArtifact(authorizingTxId: string): CompiledContractArtifact {
  return compileContract("burn", [byteArrayArg(FIXED32, authorizingTxId)]);
}

/** Compile the event contract for one event's constants (per-event compile). */
export function compileEventArtifact(constants: {
  authorizingTxId: string;
  price: number;
  orgSpk: string;
  burnTemplateHash: string;
}): CompiledContractArtifact {
  const burn = compileBurnArtifact(constants.authorizingTxId);
  const { start, len } = burn.state_layout;
  const prefix = burn.bytecode.slice(0, start);
  const suffix = burn.bytecode.slice(start + len);
  const hash = burn.template_hash;

  return compileContract("event", [
    byteArrayArg(FIXED32, constants.authorizingTxId),
    intArg(constants.price),
    byteArrayArg(DYNAMIC, constants.orgSpk),
    byteArrayArg(FIXED32, bytesToHex(Uint8Array.from(hash))),
    byteArrayArg(DYNAMIC, bytesToHex(Uint8Array.from(prefix))),
    byteArrayArg(DYNAMIC, bytesToHex(Uint8Array.from(suffix))),
  ]);
}

/** The authoritative burn template hash for an event (derived at compile time). */
export function burnTemplateHashOf(authorizingTxId: string): string {
  const burn = compileBurnArtifact(authorizingTxId);
  return bytesToHex(Uint8Array.from(burn.template_hash));
}

/** The event covenant P2SH output for a given state (owner, remaining). */
export function eventScript(
  eventArtifact: CompiledContractArtifact,
  state: { owner: string; amount: number },
): ScriptPublicKey {
  const redeem = injectState(eventArtifact, {
    owner: hexToBytes(state.owner),
    identifierType: 0,
    amount: state.amount,
    isMinter: false,
  });
  return p2shScript(redeem);
}

/** The event covenant's KIP-20 family covenant id (genesis output index 0). */
export function eventCovenantId(
  eventArtifact: CompiledContractArtifact,
  genesisTxId: string,
  orgPkh: string,
  capacity: number,
): string {
  const spk = eventScript(eventArtifact, { owner: orgPkh, amount: capacity });
  return bytesToHex(
    covenantId(
      { txId: hexToBytes(genesisTxId), index: 0 },
      [
        {
          index: 0,
          value: DUST,
          version: spk.version,
          script: hexToBytes(spk.script),
        },
      ],
    ),
  );
}
