#!/usr/bin/env node
// silverc — reference SilverScript → WASM compiler for kticket (build-time only).
//
// The published silverc (Rust) toolchain is not available yet (HLD v0.22 open
// question (e)). This reference implementation parses the SilverScript subset
// used by the kticket KCC20-fork contracts and emits a WASM artifact that the
// kit runtime instantiates and executes. It is intentionally small,
// deterministic, and side-effect-free except for writing artifacts.
//
// ABI (mirrored in src/contracts/covenant.ts): the host writes inputs into the
// exported linear memory, calls transition() -> i32, and reads outputs.
//
//   offset  field                     notes
//   0       entry (u8)                0=mint 1=transfer 2=use
//   4       prevOwner (32 bytes)      the spent covenant's owner identifier
//   36      prevIdentifierType (u8)   0=pubkey 1=script-hash 2=covenant-id
//   40      prevAmount (i64 LE)       remaining tickets / ticket balance
//   48      prevIsMinter (u8)         fixed-supply events are never minter
//   52      authOutputCount (u8)      authorized outputs in the tx
//   56      organizerSigned (u8)      mint: checkSigFromStack(prev.owner)
//   60      holderSigned (u8)         transfer/use: checkSigFromStack(prev.owner)
//   64      successorIsBurn (u8)      use: validateOutputStateWithTemplate
//   68      hasOrgPayout (u8)         mint (price>0): payout present (FR-18)
//   72      arg (32 bytes)            buyer_pkh / new_owner
//   104     newOwner (32 bytes) out
//   136     newAmount (i64 LE) out    ticket successor amount
//   144     newIdentifierType (u8) out
//   148     newIsMinter (u8) out
//   160     constPrice (i64 LE)       frozen at deploy (FR-7)
//
// Result codes: 0 OK, 1 ERR_AMOUNT, 2 ERR_AUTH_OUTPUT, 3 ERR_SIG,
//               4 ERR_BURN_TEMPLATE, 5 ERR_FUNCTION, 6 ERR_UNSPENDABLE

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const CONTRACTS_DIR = join(PACKAGE_ROOT, "contracts");
const ARTIFACTS_DIR = join(PACKAGE_ROOT, "artifacts");

const SCHEMA = "kticket/silverscript-artifact/v2";
const COMPILER = "silverc";
const COMPILER_VERSION = "0.2.0";

// On-chain code segment emitted into the redeem script (after the preimage
// pushes). Pending the pinned script_public_key layout (HLD open question e)
// this is a deterministic, contract-name-derived placeholder:
//   event/ticket: 0x00 0x51 (spendable covenant VM code)
//   burn:         0x00 0x00 (unspendable covenant VM code)
function covenantCode(contractName) {
  const name = contractName.toLowerCase();
  if (name.includes("burn")) return "0000";
  return "0051";
}

const CONTRACT_SOURCES = ["event.silverscript", "burn.silverscript"];

const ABI = {
  entry: 0,
  prevOwner: 4,
  prevIdentifierType: 36,
  prevAmount: 40,
  prevIsMinter: 48,
  authOutputCount: 52,
  organizerSigned: 56,
  holderSigned: 60,
  successorIsBurn: 64,
  hasOrgPayout: 68,
  arg: 72,
  newOwner: 104,
  newAmount: 136,
  newIdentifierType: 144,
  newIsMinter: 148,
  ownerLen: 32,
  constPrice: 160,
  constPriceBytes: 8,
};

const RESULT_CODES = {
  OK: 0,
  ERR_AMOUNT: 1,
  ERR_AUTH_OUTPUT: 2,
  ERR_SIG: 3,
  ERR_BURN_TEMPLATE: 4,
  ERR_FUNCTION: 5,
  ERR_UNSPENDABLE: 6,
};

const ENTRYPOINT_IDS = { mint: 0, transfer: 1, use: 2 };

const REQUIRED_GUARDS = {
  mint: ["organizerSigned", "amountGtZero", "authOutputCount"],
  transfer: ["holderSigned", "amountOne"],
  use: ["holderSigned", "amountOne", "successorIsBurn"],
};

// --- errors ---------------------------------------------------------------

function compileError(message) {
  const err = new Error(message);
  err.name = "SilverScriptError";
  return err;
}

// --- WASM binary writer ---------------------------------------------------

function uleb(n) {
  let remaining = n;
  const out = [];
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    out.push(byte);
  } while (remaining !== 0);
  return out;
}

function sleb(n) {
  let remaining = n;
  const out = [];
  let more = true;
  while (more) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    const sign = byte & 0x40;
    if ((remaining === 0 && sign === 0) || (remaining === -1 && sign !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return out;
}

function section(id, content) {
  return [id, ...uleb(content.length), ...content];
}

function bytesOf(str) {
  return [...str].map((c) => c.charCodeAt(0));
}

// --- WASM binary format constants ------------------------------------------

const WASM_MAGIC = [0, ...bytesOf("asm")];
const WASM_VERSION = [1, 0, 0, 0];

const WASM_SECTION_TYPE = 1;
const WASM_SECTION_FUNCTION = 3;
const WASM_SECTION_MEMORY = 5;
const WASM_SECTION_EXPORT = 7;
const WASM_SECTION_CODE = 10;

const WASM_FUNC_TYPE = 0x60;
const WASM_VALTYPE_I32 = 0x7f;
const WASM_TYPE_SECTION_ENTRIES = 1;
const WASM_TYPE_SECTION_RESULT_COUNT = 1;
const WASM_FUNC_SECTION_COUNT = 1;
const WASM_MEMORY_SECTION_COUNT = 1;
const WASM_MEMORY_FLAGS = 0;
const WASM_MEMORY_MIN = 1;
const WASM_CODE_SECTION_COUNT = 1;
const WASM_EXPORT_COUNT = 0x02;
const WASM_EXPORT_KIND_MEMORY = 0x02;
const WASM_EXPORT_KIND_FUNCTION = 0;
const WASM_EXPORT_INDEX_ZERO = 0;

const WASM_OP_I32_CONST = 0x41;
const WASM_OP_I64_CONST = 0x42;
const WASM_OP_I32_LOAD8_U = 0x2d;
const WASM_OP_I64_LOAD = 0x29;
const WASM_OP_I32_STORE8 = 0x3a;
const WASM_OP_I64_STORE = 0x37;
const WASM_OP_I32_EQZ = 0x45;
const WASM_OP_I32_NE = 0x47;
const WASM_OP_I32_EQ = 0x46;
const WASM_OP_I64_EQ = 0x51;
const WASM_OP_I64_GT_U = 0x55;
const WASM_OP_IF = 0x04;
const WASM_OP_ELSE = 0x05;
const WASM_OP_END = 0x0b;
const WASM_OP_RET = 0x0f;
const WASM_OP_UNREACHABLE = 0x00;
const WASM_BLOCKTYPE_VOID = 0x40;
const WASM_ALIGN_ZERO = 0;

const I32_EQZ = [WASM_OP_I32_EQZ];
const I32_NE = [WASM_OP_I32_NE];
const I32_EQ = [WASM_OP_I32_EQ];
const I64_EQ = [WASM_OP_I64_EQ];
const I64_GT_U = [WASM_OP_I64_GT_U];
const IF = [WASM_OP_IF, WASM_BLOCKTYPE_VOID];
const ELSE = [WASM_OP_ELSE];
const END = [WASM_OP_END];
const RET = [WASM_OP_RET];
const UNREACHABLE = [WASM_OP_UNREACHABLE];

function i32const(n) {
  return [WASM_OP_I32_CONST, ...sleb(n)];
}

function i64const(n) {
  return [WASM_OP_I64_CONST, ...sleb(n)];
}

function load8u(offset) {
  return [WASM_OP_I32_LOAD8_U, WASM_ALIGN_ZERO, ...uleb(offset)];
}

function i64load(offset) {
  return [WASM_OP_I64_LOAD, WASM_ALIGN_ZERO, ...uleb(offset)];
}

function store8(offset) {
  return [WASM_OP_I32_STORE8, WASM_ALIGN_ZERO, ...uleb(offset)];
}

function store64(offset) {
  return [WASM_OP_I64_STORE, WASM_ALIGN_ZERO, ...uleb(offset)];
}

// Guards: emit `if (condition) return <code>`.

function guardEquals(offset, expected, code) {
  return [
    ...i32const(0),
    ...load8u(offset),
    ...i32const(expected),
    ...I32_NE,
    ...IF,
    ...i32const(code),
    ...RET,
    ...END,
  ];
}

function guardZero(offset, code) {
  return [...i32const(0), ...load8u(offset), ...I32_EQZ, ...IF, ...i32const(code), ...RET, ...END];
}

function guardAmountGtZero(code) {
  // if (!(prevAmount > 0)) return ERR_AMOUNT
  return [
    ...i32const(ABI.prevAmount),
    ...i64load(0),
    ...i64const(0),
    ...I64_GT_U,
    ...I32_EQZ,
    ...IF,
    ...i32const(code),
    ...RET,
    ...END,
  ];
}

function guardAmountOne(code) {
  // if (prevAmount != 1) return ERR_AMOUNT
  return [
    ...i32const(ABI.prevAmount),
    ...i64load(0),
    ...i64const(1),
    ...I64_EQ,
    ...I32_EQZ,
    ...IF,
    ...i32const(code),
    ...RET,
    ...END,
  ];
}

// mint: if constPrice > 0 then require hasOrgPayout (payout in same tx).
function payoutGuard(code) {
  return [
    ...i32const(0),
    ...i64load(ABI.constPrice),
    ...i64const(0),
    ...I64_GT_U,
    ...IF,
    ...guardZero(ABI.hasOrgPayout, code),
    ...END,
  ];
}

function setAmount(amount) {
  return [...i32const(ABI.newAmount), ...i64const(amount), ...store64(0)];
}

function setAmountFromPrev() {
  return [...i32const(ABI.newAmount), ...i32const(ABI.prevAmount), ...i64load(0), ...store64(0)];
}

function copyArgToOwner() {
  const out = [];
  for (let i = 0; i < ABI.ownerLen; i++) {
    out.push(...i32const(ABI.newOwner + i), ...i32const(ABI.arg + i), ...load8u(0), ...store8(0));
  }
  return out;
}

function copyPrevToNewOwner() {
  const out = [];
  for (let i = 0; i < ABI.ownerLen; i++) {
    out.push(
      ...i32const(ABI.newOwner + i),
      ...i32const(ABI.prevOwner + i),
      ...load8u(0),
      ...store8(0),
    );
  }
  return out;
}

function emitGuard(guard) {
  switch (guard.type) {
    case "organizerSigned":
      return guardZero(ABI.organizerSigned, RESULT_CODES.ERR_SIG);
    case "holderSigned":
      return guardZero(ABI.holderSigned, RESULT_CODES.ERR_SIG);
    case "amountGtZero":
      return guardAmountGtZero(RESULT_CODES.ERR_AMOUNT);
    case "amountOne":
      return guardAmountOne(RESULT_CODES.ERR_AMOUNT);
    case "authOutputCount":
      return guardEquals(ABI.authOutputCount, guard.value, RESULT_CODES.ERR_AUTH_OUTPUT);
    case "hasOrgPayout":
      return payoutGuard(RESULT_CODES.ERR_AUTH_OUTPUT);
    case "successorIsBurn":
      return guardZero(ABI.successorIsBurn, RESULT_CODES.ERR_BURN_TEMPLATE);
    default:
      throw compileError(`unknown guard type: ${guard.type}`);
  }
}

function emitEntrypointBody(entrypoint) {
  const out = [];
  for (const guard of entrypoint.guards) {
    out.push(...emitGuard(guard));
  }

  if (entrypoint.result.owner !== null) {
    if (entrypoint.result.owner === "arg") {
      out.push(...copyArgToOwner());
    } else {
      out.push(...copyPrevToNewOwner());
    }
  }
  if (entrypoint.result.amount !== null) {
    if (entrypoint.result.amount === "prev") {
      out.push(...setAmountFromPrev());
    } else {
      out.push(...setAmount(entrypoint.result.amount));
    }
  }
  out.push(...i32const(RESULT_CODES.OK), ...RET);
  return out;
}

function emitDispatch(entrypoints) {
  const out = [];
  for (let i = 0; i < entrypoints.length; i++) {
    const ep = entrypoints[i];
    if (i === 0) {
      out.push(...i32const(0), ...load8u(ABI.entry), ...i32const(ep.id), ...I32_EQ, ...IF);
    } else {
      out.push(...ELSE, ...i32const(0), ...load8u(ABI.entry), ...i32const(ep.id), ...I32_EQ, ...IF);
    }
    out.push(...emitEntrypointBody(ep));
  }
  out.push(...ELSE, ...i32const(RESULT_CODES.ERR_FUNCTION), ...RET);
  for (let i = 0; i < entrypoints.length; i++) {
    out.push(...END);
  }
  out.push(...UNREACHABLE);
  return out;
}

function exportSection() {
  return section(WASM_SECTION_EXPORT, [
    WASM_EXPORT_COUNT,
    ...uleb(bytesOf("memory").length),
    ...bytesOf("memory"),
    WASM_EXPORT_KIND_MEMORY,
    WASM_EXPORT_INDEX_ZERO,
    ...uleb(bytesOf("transition").length),
    ...bytesOf("transition"),
    WASM_EXPORT_KIND_FUNCTION,
    WASM_EXPORT_INDEX_ZERO,
  ]);
}

function emitBody(entrypoints) {
  return entrypoints.length === 0
    ? [...i32const(RESULT_CODES.ERR_UNSPENDABLE), ...RET]
    : emitDispatch(entrypoints);
}

function emitWasm(entrypoints) {
  const typeSection = section(WASM_SECTION_TYPE, [
    WASM_TYPE_SECTION_ENTRIES,
    WASM_FUNC_TYPE,
    0,
    WASM_TYPE_SECTION_RESULT_COUNT,
    WASM_VALTYPE_I32,
  ]);
  const funcSection = section(WASM_SECTION_FUNCTION, [WASM_FUNC_SECTION_COUNT, 0]);
  const memSection = section(WASM_SECTION_MEMORY, [
    WASM_MEMORY_SECTION_COUNT,
    WASM_MEMORY_FLAGS,
    WASM_MEMORY_MIN,
  ]);
  const exports = exportSection();

  const body = emitBody(entrypoints);
  const codeContent = [WASM_CODE_SECTION_COUNT, ...uleb(body.length + 2), 0, ...body, ...END];
  const codeSection = section(WASM_SECTION_CODE, codeContent);

  return Uint8Array.from([
    ...WASM_MAGIC,
    ...WASM_VERSION,
    ...typeSection,
    ...funcSection,
    ...memSection,
    ...exports,
    ...codeSection,
  ]);
}

// --- parser ----------------------------------------------------------------

function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}

function lineCol(source, index) {
  const before = source.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

function fail(source, sourcePath, index, message) {
  const pos = lineCol(source, index);
  throw compileError(`${message} (${sourcePath}:${pos.line}:${pos.col})`);
}

function parseParams(source, sourcePath, str) {
  return str
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.+?)\s+(\w+)$/);
      if (!match) {
        fail(source, sourcePath, -1, `malformed contract parameter: "${part}"`);
      }
      return { type: match[1].trim(), name: match[2] };
    });
}

function parseGuard(source, sourcePath, expr) {
  const e = expr.trim();
  if (/^checkSigFromStack\(prev\.owner\)$/.test(e)) {
    return { type: "prev.owner" };
  }
  let match = e.match(/^prev\.amount\s*>\s*0$/);
  if (match) return { type: "amountGtZero" };
  match = e.match(/^prev\.amount\s*==\s*1$/);
  if (match) return { type: "amountOne" };
  match = e.match(/^OpAuthOutputCount\([^)]*\)\s*==\s*(\d+)$/);
  if (match) return { type: "authOutputCount", value: Number(match[1]) };
  if (/^existsOutput\(org_spk,\s*price\)$/.test(e)) {
    return { type: "hasOrgPayout" };
  }
  if (/^validateOutputStateWithTemplate\([^)]*,\s*burn_tmpl\)$/.test(e)) {
    return { type: "successorIsBurn" };
  }
  fail(source, sourcePath, -1, `unsupported require expression: "${expr}"`);
}

function parseReturn(source, sourcePath, value) {
  const v = value.trim();
  if (v === "NONE") return { amount: null, owner: null };
  const match = v.match(/^\{\s*amount\s*:\s*(\d+)\s*,\s*owner\s*:\s*(\w+)\s*\}$/);
  if (match) return { amount: Number(match[1]), owner: "arg" };
  const keep = v.match(/^\{\s*amount\s*:\s*prev\.amount\s*,\s*owner\s*:\s*(\w+)\s*\}$/);
  if (keep) return { amount: "prev", owner: "arg" };
  fail(source, sourcePath, -1, `unsupported return: "${value}"`);
}

function parseStatement(source, sourcePath, stmt) {
  const s = stmt.trim();
  if (s === "") return null;

  let match = s.match(/^require\((.+)\)$/);
  if (match) return { kind: "guard", guard: parseGuard(source, sourcePath, match[1]) };

  match = s.match(/^if\s*\(\s*(.+?)\s*\)\s*require\((.+)\)$/);
  if (match) return { kind: "guard", guard: parseGuard(source, sourcePath, match[2]) };

  match = s.match(/^validateOutputStateWithTemplate\((.+)\)$/);
  if (match) return { kind: "guard", guard: { type: "successorIsBurn" } };

  if (/^int\s+\w+\s*=\s*.+$/.test(s)) {
    return { kind: "local" };
  }

  match = s.match(/^return\((.+)\)$/);
  if (match) {
    return {
      kind: "return",
      result: parseReturn(source, sourcePath, match[1]),
    };
  }

  fail(source, sourcePath, -1, `unsupported statement: "${stmt}"`);
}

function extractBalanced(source, sourcePath, text, start) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  if (depth !== 0) {
    fail(source, sourcePath, start, "unbalanced block: missing closing brace");
  }
  return text.slice(start, i - 1);
}

function parseEntrypointArgs(str) {
  return str
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const tokens = part.split(/\s+/);
      return tokens[tokens.length - 1];
    });
}

function validateEntrypointHeader(source, sourcePath, header) {
  if (header.binding !== "auth") {
    fail(
      source,
      sourcePath,
      header.index,
      `entrypoint ${header.name}: only binding = auth is supported`,
    );
  }
  if (header.from !== 1) {
    fail(source, sourcePath, header.index, `entrypoint ${header.name}: only from = 1 is supported`);
  }
  if (!(header.name in ENTRYPOINT_IDS)) {
    fail(source, sourcePath, header.index, `unknown entrypoint name: ${header.name}`);
  }
}

function validateEntrypointGuards(source, sourcePath, header, guards) {
  const required = REQUIRED_GUARDS[header.name] ?? [];
  const present = new Set(guards.map((g) => g.type));
  for (const type of required) {
    if (!present.has(type)) {
      fail(
        source,
        sourcePath,
        header.index,
        `entrypoint ${header.name}: missing required guard "${type}"`,
      );
    }
  }
}

function validateEntrypointResult(source, sourcePath, header, result) {
  if (result.owner !== null && !["arg", "prev.owner"].includes(result.owner)) {
    fail(
      source,
      sourcePath,
      header.index,
      `entrypoint ${header.name}: return owner "${result.owner}" is not "arg" or "prev.owner"`,
    );
  }
}

function entrypointFrom(header, guards, result) {
  return {
    name: header.name,
    id: ENTRYPOINT_IDS[header.name],
    binding: header.binding,
    from: header.from,
    to: header.to,
    args: header.args,
    guards,
    result,
  };
}

function parseEntrypointStatements(source, sourcePath, statements) {
  const guards = [];
  let result = null;
  for (const stmt of statements) {
    const parsed = parseStatement(source, sourcePath, stmt);
    if (parsed === null) continue;
    if (parsed.kind === "guard") {
      guards.push(parsed.guard);
    } else if (parsed.kind === "return") {
      result = parsed.result;
    }
  }
  return { guards, result };
}

function normalizeOwnerGuard(guards, header) {
  const ownerGuard = guards.find((g) => g.type === "prev.owner");
  if (ownerGuard) {
    ownerGuard.type = header.name === "mint" ? "organizerSigned" : "holderSigned";
  }
}

function parseEntrypoint(source, sourcePath, text, header) {
  validateEntrypointHeader(source, sourcePath, header);

  const bodyText = extractBalanced(source, sourcePath, text, header.index + header.length);
  const statements = bodyText
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean);

  const { guards, result } = parseEntrypointStatements(source, sourcePath, statements);

  if (result === null) {
    fail(source, sourcePath, header.index, `entrypoint ${header.name}: missing return`);
  }

  normalizeOwnerGuard(guards, header);
  validateEntrypointGuards(source, sourcePath, header, guards);
  validateEntrypointResult(source, sourcePath, header, result);

  return entrypointFrom(header, guards, result);
}

function parseHeaders(text) {
  const headerRe =
    /#\[covenant\s*\(\s*binding\s*=\s*(\w+)\s*,\s*from\s*=\s*(\d+)\s*,\s*to\s*=\s*(\d+)\s*\)\s*\]\s*function\s+(\w+)\s*\(([^)]*)\)\s*:\s*\(([^)]*)\)\s*\{/g;

  const headers = [];
  let match = headerRe.exec(text);
  while (match !== null) {
    headers.push({
      index: match.index,
      length: match[0].length,
      binding: match[1],
      from: Number(match[2]),
      to: Number(match[3]),
      name: match[4],
      args: parseEntrypointArgs(match[5]),
    });
    match = headerRe.exec(text);
  }
  return headers;
}

function parseState(preamble) {
  const state = [];
  const stateRe = /(?:int|byte\[32\]|byte\[\]|template|bool)\s+(\w+)\s*=\s*([^;]+);/g;
  let stateMatch = stateRe.exec(preamble);
  while (stateMatch !== null) {
    state.push({
      type: stateMatch[0].slice(0, stateMatch[0].indexOf(stateMatch[1])).trim(),
      name: stateMatch[1],
      initial: stateMatch[2].trim(),
    });
    stateMatch = stateRe.exec(preamble);
  }
  return state;
}

function parse(source, sourcePath) {
  const text = stripComments(source);

  const pragmaMatch = text.match(/pragma\s+silverscript\s+([^\s;]+)\s*;/);
  if (!pragmaMatch) {
    fail(source, sourcePath, 0, "missing `pragma silverscript <version>;` declaration");
  }

  const contractMatch = text.match(/contract\s+(\w+)\s*\(([^)]*)\)\s*\{/);
  if (!contractMatch) {
    fail(source, sourcePath, 0, "missing `contract <name>(<params>) {` declaration");
  }

  const headers = parseHeaders(text);
  const preambleEnd = headers.length > 0 ? headers[0].index : text.length;
  const state = parseState(text.slice(0, preambleEnd));

  const entrypoints = headers.map((header) => parseEntrypoint(source, sourcePath, text, header));

  return {
    pragma: pragmaMatch[1],
    contractName: contractMatch[1],
    params: parseParams(source, sourcePath, contractMatch[2]),
    state,
    entrypoints,
  };
}

// --- artifact --------------------------------------------------------------

function entrypointMap(entrypoints) {
  const map = {};
  for (const ep of entrypoints) {
    map[ep.name] = {
      id: ep.id,
      binding: ep.binding,
      from: ep.from,
      to: ep.to,
      args: ep.args,
      guards: ep.guards.map((g) => g.type),
      result: ep.result,
    };
  }
  return map;
}

function compileSource(source, sourcePath) {
  const parsed = parse(source, sourcePath);
  const wasm = emitWasm(parsed.entrypoints);

  return {
    schema: SCHEMA,
    compiler: COMPILER,
    compilerVersion: COMPILER_VERSION,
    name: parsed.contractName,
    source: sourcePath.split(/[\\/]/).pop(),
    unspendable: parsed.entrypoints.length === 0,
    wasmBase64: Buffer.from(wasm).toString("base64"),
    code: covenantCode(parsed.contractName),
    contract: {
      pragma: parsed.pragma,
      params: parsed.params,
      state: parsed.state,
      entrypoints: entrypointMap(parsed.entrypoints),
      constantsBaked: true,
    },
    abi: ABI,
    resultCodes: RESULT_CODES,
  };
}

function artifactPathFor(sourceName) {
  return join(ARTIFACTS_DIR, sourceName.replace(/\.silverscript$/, ".artifact.json"));
}

function artifactJson(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

// --- CLI -------------------------------------------------------------------

function checkArtifacts() {
  let stale = false;
  for (const sourceName of CONTRACT_SOURCES) {
    const source = readFileSync(join(CONTRACTS_DIR, sourceName), "utf8");
    const artifact = compileSource(source, sourceName);
    const path = artifactPathFor(sourceName);
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

function compileAll() {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  for (const sourceName of CONTRACT_SOURCES) {
    const source = readFileSync(join(CONTRACTS_DIR, sourceName), "utf8");
    const artifact = compileSource(source, sourceName);
    writeFileSync(artifactPathFor(sourceName), artifactJson(artifact));
  }
  process.stdout.write(
    `silverc: compiled ${CONTRACT_SOURCES.length} contracts -> ${ARTIFACTS_DIR}\n`,
  );
}

function main(argv) {
  const [mode, arg] = argv;

  if (mode === "--check") {
    checkArtifacts();
    return;
  }

  if (mode === "--compile") {
    const path = arg;
    const source = readFileSync(path, "utf8");
    process.stdout.write(artifactJson(compileSource(source, path)));
    return;
  }

  compileAll();
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof Error && err.name === "SilverScriptError") {
    process.stderr.write(`silverc: compile error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
