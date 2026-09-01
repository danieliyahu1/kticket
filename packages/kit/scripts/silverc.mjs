// silverc — Node wrapper around the kticket-silverc Rust bin (KTK-88 A3).
//
// Replaces the hand-rolled stub compiler. Invokes `kticket-silverc` to compile
// the real SilverScript contracts (contracts/*.sil) into kticket artifact JSON.
//
//   npm run build           compile all contracts -> artifacts/*.artifact.json
//   npm run check:contracts verify committed artifacts are in sync
//   node scripts/silverc.mjs --compile <path.sil>  print one artifact to stdout
//
// The Rust bin is built with cargo in packages/kit/silverc; its pinned
// silverscript-lang rev is tracked there (KTK-88 A1/A7).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTRACTS_DIR = join(KIT_ROOT, "contracts");
const ARTIFACTS_DIR = join(KIT_ROOT, "artifacts");

const BIN_NAME = process.platform === "win32" ? "kticket-silverc.exe" : "kticket-silverc";
const BIN_PATH = join(KIT_ROOT, "silverc", "target", "release", BIN_NAME);

// Reference constructor args for the committed artifacts. Deterministic so
// `npm run build` reproduces byte-for-byte identical artifacts.
const REFERENCE_TXID_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const REFERENCE_PRICE = 100_000_000;
const REFERENCE_ORG_PKH_HEX = "1112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f30";

const CONTRACT_NAMES = ["event", "burn"];

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return Array.from(bytes);
}

function bytesArg(hex) {
  return { kind: "bytes", value: hexToBytes(hex) };
}

function intArg(value) {
  return { kind: "int", value };
}

function writeCtorFile(ctorArgs) {
  const tmp = join(KIT_ROOT, ".silverc-ctor.json");
  writeFileSync(tmp, JSON.stringify(ctorArgs));
  return tmp;
}

function runRust(args) {
  if (!existsSync(BIN_PATH)) {
    throw new Error(
      `kticket-silverc binary not found at ${BIN_PATH}; run \`cargo build --release\` in packages/kit/silverc`,
    );
  }
  return execFileSync(BIN_PATH, args, { encoding: "utf8" });
}

function compileContract(name, ctorArgs) {
  const ctorFile = writeCtorFile(ctorArgs);
  try {
    return JSON.parse(runRust(["compile", join(CONTRACTS_DIR, `${name}.sil`), "--ctor", ctorFile]));
  } finally {
    unlinkSync(ctorFile);
  }
}

// The event contract's constructor args depend on the compiled burn template
// (prefix/suffix/hash), so compile burn first and derive its template parts.
// `org_pkh` is the organizer pubkey (x-coordinate) baked into the P2PK
// `org_spk` — the gate co-signature key (mark_used, KTK-118).
function eventCtorArgs(txidHex) {
  const burn = compileContract("burn", [bytesArg(txidHex)]);
  const start = burn.state_layout.start;
  const len = burn.state_layout.len;
  const prefix = burn.bytecode.slice(0, start);
  const suffix = burn.bytecode.slice(start + len);
  const hash = burn.template_hash;
  const orgSpk = `20${REFERENCE_ORG_PKH_HEX}ac`;
  const orgSpkFull = `0000${orgSpk}`;

  return [
    bytesArg(txidHex),
    intArg(REFERENCE_PRICE),
    // `org_spk` is baked as the full script public key bytes (u16 LE version
    // prefix + script) to match the covenant VM's `tx.outputs[i].scriptPubKey`
    // introspection (KTK-102 follow-up).
    bytesArg(orgSpkFull),
    bytesArg(Buffer.from(hash).toString("hex")),
    bytesArg(Buffer.from(prefix).toString("hex")),
    bytesArg(Buffer.from(suffix).toString("hex")),
    bytesArg(REFERENCE_ORG_PKH_HEX),
  ];
}

function ctorArgsFor(name, txidHex) {
  return name === "burn" ? [bytesArg(txidHex)] : eventCtorArgs(txidHex);
}

function artifactJson(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function compileAll() {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  for (const name of CONTRACT_NAMES) {
    const artifact = compileContract(name, ctorArgsFor(name, REFERENCE_TXID_HEX));
    writeFileSync(join(ARTIFACTS_DIR, `${name}.artifact.json`), artifactJson(artifact));
  }
  process.stdout.write(`silverc: compiled ${CONTRACT_NAMES.length} contracts -> ${ARTIFACTS_DIR}\n`);
}

function checkArtifacts() {
  let stale = false;
  for (const name of CONTRACT_NAMES) {
    const artifact = compileContract(name, ctorArgsFor(name, REFERENCE_TXID_HEX));
    const path = join(ARTIFACTS_DIR, `${name}.artifact.json`);
    if (!existsSync(path) || readFileSync(path, "utf8") !== artifactJson(artifact)) {
      process.stderr.write(`silverc: artifact out of sync: ${path}\n`);
      stale = true;
    }
  }
  if (stale) {
    process.stderr.write("silverc: run `npm run build --workspace @kticket/kit` to regenerate\n");
    process.exit(1);
  }
  process.stdout.write("silverc: artifacts up to date\n");
}

function main(argv) {
  const [mode, arg] = argv;

  if (mode === "--check") {
    checkArtifacts();
    return;
  }

  if (mode === "--compile") {
    const path = arg;
    const name = path.split(/[\\/]/).pop().replace(/\.sil$/, "");
    const ctorFile = writeCtorFile(ctorArgsFor(name, REFERENCE_TXID_HEX));
    try {
      const artifact = JSON.parse(runRust(["compile", path, "--ctor", ctorFile]));
      process.stdout.write(artifactJson(artifact));
    } finally {
      unlinkSync(ctorFile);
    }
    return;
  }

  compileAll();
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
