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
  pubkeyFromP2pkScript,
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

/**
 * The event contract constructor args — authorizing_txid, price, org_spk,
 * burn_template_hash, the burn template prefix/suffix (derived from the burn
 * compile), and org_pkh. `org_pkh` is the organizer's 32-byte pubkey, extracted
 * from the P2PK `org_spk` script — the same key the gate co-signature must
 * verify against (mark_used, KTK-118). Shared by `compileEventArtifact` and the
 * covenant `sigscript` builder so both compile the identical bytecode.
 */
function eventConstructorArgs(constants: {
  authorizingTxId: string;
  price: number;
  orgSpk: string;
  burnTemplateHash: string;
}): unknown[] {
  const burn = compileBurnArtifact(constants.authorizingTxId);
  const { start, len } = burn.state_layout;
  const prefix = burn.bytecode.slice(0, start);
  const suffix = burn.bytecode.slice(start + len);
  const hash = burn.template_hash;
  // `org_spk` is baked as the full script public key bytes (`<u16 version LE> ||
  // script`). The covenant VM's `tx.outputs[i].scriptPubKey` introspection
  // returns exactly this serialized form, so `hasPayout()` only matches when the
  // constant carries the version prefix too (KTK-102 follow-up).
  const orgSpkFull = `0000${constants.orgSpk}`;
  const orgPkh = pubkeyFromP2pkScript(constants.orgSpk);
  if (!orgPkh) {
    throw new Error("org_spk is not a valid P2PK script (cannot derive org_pkh)");
  }
  return [
    byteArrayArg(FIXED32, constants.authorizingTxId),
    intArg(constants.price),
    byteArrayArg(DYNAMIC, orgSpkFull),
    byteArrayArg(FIXED32, bytesToHex(Uint8Array.from(hash))),
    byteArrayArg(DYNAMIC, bytesToHex(Uint8Array.from(prefix))),
    byteArrayArg(DYNAMIC, bytesToHex(Uint8Array.from(suffix))),
    byteArrayArg(FIXED32, bytesToHex(orgPkh)),
  ];
}

/** Compile the event contract for one event's constants (per-event compile). */
export function compileEventArtifact(constants: {
  authorizingTxId: string;
  price: number;
  orgSpk: string;
  burnTemplateHash: string;
}): CompiledContractArtifact {
  return compileContract("event", eventConstructorArgs(constants));
}

/**
 * The covenant spend script for the `mint` entrypoint (buy): `push(buyer_pkh)
 * || pushData(redeem)`. Built by silverc's `build_sig_script_for_covenant_decl`
 * so the arg encoding matches what the node's covenant VM expects — the
 * on-chain event covenant only knows the P2SH hash, so the spend must reveal
 * both the `buyer_pkh` call argument and the redeem script with the live state.
 */
export function eventMintSigScript(
  constants: {
    authorizingTxId: string;
    price: number;
    orgSpk: string;
    burnTemplateHash: string;
  },
  buyerPkhHex: string,
): string {
  const ctor = eventConstructorArgs(constants);
  const args = [byteArrayArg(FIXED32, buyerPkhHex)];
  const dir = mkdtempSync(join(tmpdir(), "kticket-sig-"));
  const ctorFile = join(dir, "ctor.json");
  const argsFile = join(dir, "args.json");
  writeFileSync(ctorFile, JSON.stringify(ctor));
  writeFileSync(argsFile, JSON.stringify(args));
  try {
    return runRust([
      "sigscript",
      "--ctor",
      ctorFile,
      "--args",
      argsFile,
      join(CONTRACTS_DIR, "event.sil"),
      "mint",
    ]).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    used: false,
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
