#!/usr/bin/env node
// silverc — reference SilverScript → WASM compiler for kticket (build-time only).
//
// The published silverc (Rust) toolchain is not available yet (HLD v0.21 open
// question (e): "Pin the exact script_public_key byte layout SilverScript
// emits"). This reference implementation parses the SilverScript subset used by
// the Ticket / Burn contracts and emits a WASM artifact that the kit runtime
// instantiates and executes. It is intentionally small, deterministic, and
// side-effect-free except for writing artifacts under packages/kit/artifacts.
//
// ABI (also mirrored in src/contracts/covenant.ts): the host writes inputs into
// the exported linear memory, calls transition() -> i32, and reads outputs.
//
//   offset  field                     notes
//   0       entry (u8)                0=buy 1=transfer 2=use
//   4       prevPhase (u8)            0=available 1=owned
//   8       authOutputCount (u8)      buy: OpAuthOutputCount must be 1 (FR-17)
//   12      hasOrgPayout (u8)         buy (price>0): payout present (FR-18)
//   16      holderSigned (u8)         transfer/use: checkSigFromStack (NFR-4)
//   20      successorIsBurn (u8)      use: validateOutputStateWithTemplate (FR-9)
//   24      arg (32 bytes)            buyer_pkh / new_owner
//   64      newPhase (u8) output      0/1/2 (2 = gone)
//   68      newOwner (32 bytes) out
//   128     constPrice (i64 LE)       frozen at genesis (FR-7); read-only here
//
// Result codes: 0 OK, 1 ERR_PHASE, 2 ERR_AUTH_OUTPUT, 3 ERR_PAYOUT,
//               4 ERR_SIG, 5 ERR_BURN_TEMPLATE, 6 ERR_FUNCTION, 7 ERR_UNSPENDABLE

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const CONTRACTS_DIR = join(PACKAGE_ROOT, "contracts");
const ARTIFACTS_DIR = join(PACKAGE_ROOT, "artifacts");

const SCHEMA = "kticket/silverscript-artifact/v1";
const COMPILER = "silverc";
const COMPILER_VERSION = "0.1.0";

const CONTRACT_SOURCES = ["ticket.silverscript", "burn.silverscript"];

const ABI = {
  entry: 0,
  prevPhase: 4,
  authOutputCount: 8,
  hasOrgPayout: 12,
  holderSigned: 16,
  successorIsBurn: 20,
  arg: 24,
  newPhase: 64,
  newOwner: 68,
  ownerLen: 32,
  constPrice: 128,
  constPriceBytes: 8,
};

const RESULT_CODES = {
  OK: 0,
  ERR_PHASE: 1,
  ERR_AUTH_OUTPUT: 2,
  ERR_PAYOUT: 3,
  ERR_SIG: 4,
  ERR_BURN_TEMPLATE: 5,
  ERR_FUNCTION: 6,
  ERR_UNSPENDABLE: 7,
};

const ENTRYPOINT_IDS = { buy: 0, transfer: 1, use: 2 };

const REQUIRED_GUARDS = {
  buy: ["phase", "authOutputCount", "hasOrgPayout"],
  transfer: ["phase", "holderSigned"],
  use: ["phase", "holderSigned", "successorIsBurn"],
};

// --- errors ---------------------------------------------------------------

function compileError(message) {
  const err = new Error(message);
  err.name = "SilverScriptError";
  return err;
}

// --- WASM binary writer ----------------------------------------------------

function uleb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

function sleb(n) {
  const out = [];
  let more = true;
  while (more) {
    let byte = n & 0x7f;
    n >>= 7;
    const sign = byte & 0x40;
    if ((n === 0 && sign === 0) || (n === -1 && sign !== 0)) {
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

function i32const(n) {
  return [0x41, ...sleb(n)];
}

function i64const(n) {
  return [0x42, ...sleb(n)];
}

function load8u(offset) {
  return [0x2d, 0x00, ...uleb(offset)];
}

function i64load(offset) {
  return [0x29, 0x00, ...uleb(offset)];
}

function store8(offset) {
  return [0x3a, 0x00, ...uleb(offset)];
}

const I32_EQZ = [0x45];
const I32_NE = [0x47];
const I32_EQ = [0x46];
const I64_GT_U = [0x55];
const IF = [0x04, 0x40];
const ELSE = [0x05];
const END = [0x0b];
const RET = [0x0f];
const UNREACHABLE = [0x00];

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

// buy: if constPrice > 0 then require hasOrgPayout (payout in same tx).
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

function setPhase(phase) {
  return [...i32const(ABI.newPhase), ...i32const(phase), ...store8(0)];
}

function copyArgToOwner() {
  const out = [];
  for (let i = 0; i < ABI.ownerLen; i++) {
    out.push(...i32const(ABI.newOwner + i), ...i32const(ABI.arg + i), ...load8u(0), ...store8(0));
  }
  return out;
}

function emitEntrypointBody(entrypoint) {
  const out = [];
  for (const guard of entrypoint.guards) {
    switch (guard.type) {
      case "phase":
        out.push(...guardEquals(ABI.prevPhase, guard.value, RESULT_CODES.ERR_PHASE));
        break;
      case "authOutputCount":
        out.push(...guardEquals(ABI.authOutputCount, guard.value, RESULT_CODES.ERR_AUTH_OUTPUT));
        break;
      case "hasOrgPayout":
        out.push(...payoutGuard(RESULT_CODES.ERR_PAYOUT));
        break;
      case "holderSigned":
        out.push(...guardZero(ABI.holderSigned, RESULT_CODES.ERR_SIG));
        break;
      case "successorIsBurn":
        out.push(...guardZero(ABI.successorIsBurn, RESULT_CODES.ERR_BURN_TEMPLATE));
        break;
      default:
        throw compileError(`unknown guard type: ${guard.type}`);
    }
  }
  out.push(...setPhase(entrypoint.result.phase));
  if (entrypoint.result.owner !== null) {
    out.push(...copyArgToOwner());
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

function emitWasm(entrypoints) {
  const magic = [0x00, 0x61, 0x73, 0x6d];
  const version = [0x01, 0x00, 0x00, 0x00];

  const typeSection = section(1, [0x01, 0x60, 0x00, 0x01, 0x7f]);
  const funcSection = section(3, [0x01, 0x00]);
  const memSection = section(5, [0x01, 0x00, 0x01]);
  const exportSection = section(7, [
    0x02,
    0x06,
    ...bytesOf("memory"),
    0x02,
    0x00,
    0x0a,
    ...bytesOf("transition"),
    0x00,
    0x00,
  ]);

  const body =
    entrypoints.length === 0
      ? [...i32const(RESULT_CODES.ERR_UNSPENDABLE), ...RET]
      : emitDispatch(entrypoints);

  const codeContent = [0x01, ...uleb(body.length + 2), 0x00, ...body, ...END];
  const codeSection = section(10, codeContent);

  return Uint8Array.from([
    ...magic,
    ...version,
    ...typeSection,
    ...funcSection,
    ...memSection,
    ...exportSection,
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
  let match = e.match(/^prev\.phase\s*==\s*(\d+)$/);
  if (match) return { type: "phase", value: Number(match[1]) };

  match = e.match(/^OpAuthOutputCount\([^)]*\)\s*==\s*(\d+)$/);
  if (match) return { type: "authOutputCount", value: Number(match[1]) };

  if (/^existsOutput\(org_spk,\s*price\)$/.test(e)) {
    return { type: "hasOrgPayout" };
  }
  if (/^checkSigFromStack\(prev\.owner\)$/.test(e)) {
    return { type: "holderSigned" };
  }
  if (/^validateOutputStateWithTemplate\([^)]*,\s*burn_tmpl\)$/.test(e)) {
    return { type: "successorIsBurn" };
  }
  fail(source, sourcePath, -1, `unsupported require expression: "${expr}"`);
}

function parseReturn(source, sourcePath, value) {
  const v = value.trim();
  if (v === "NONE") return { phase: 2, owner: null };
  const match = v.match(/^\{\s*phase\s*:\s*(\d+)\s*,\s*owner\s*:\s*(\w+)\s*\}$/);
  if (match) return { phase: Number(match[1]), owner: match[2] };
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

  const contractName = contractMatch[1];
  const params = parseParams(source, sourcePath, contractMatch[2]);

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

  const preambleEnd = headers.length > 0 ? headers[0].index : text.length;
  const preamble = text.slice(0, preambleEnd);

  const state = [];
  const stateRe = /(?:int|byte\[32\]|byte\[\]|template)\s+(\w+)\s*=\s*([^;]+);/g;
  let stateMatch = stateRe.exec(preamble);
  while (stateMatch !== null) {
    state.push({
      type: stateMatch[0].slice(0, stateMatch[0].indexOf(stateMatch[1])).trim(),
      name: stateMatch[1],
      initial: stateMatch[2].trim(),
    });
    stateMatch = stateRe.exec(preamble);
  }

  const entrypoints = [];
  for (const header of headers) {
    if (header.binding !== "auth") {
      fail(
        source,
        sourcePath,
        header.index,
        `entrypoint ${header.name}: only binding = auth is supported`,
      );
    }
    if (header.from !== 1 || header.to !== 1) {
      fail(
        source,
        sourcePath,
        header.index,
        `entrypoint ${header.name}: only from = 1, to = 1 covenants are supported`,
      );
    }
    if (!(header.name in ENTRYPOINT_IDS)) {
      fail(source, sourcePath, header.index, `unknown entrypoint name: ${header.name}`);
    }

    const bodyText = extractBalanced(source, sourcePath, text, header.index + header.length);
    const statements = bodyText
      .split(";")
      .map((stmt) => stmt.trim())
      .filter(Boolean);

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

    if (result === null) {
      fail(source, sourcePath, header.index, `entrypoint ${header.name}: missing return`);
    }

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

    const phaseGuard = guards.find((g) => g.type === "phase");
    const expectedPhase = header.name === "buy" ? 0 : 1;
    if (phaseGuard.value !== expectedPhase) {
      fail(
        source,
        sourcePath,
        header.index,
        `entrypoint ${header.name}: prev.phase must be ${expectedPhase}`,
      );
    }

    if (result.owner !== null && !header.args.includes(result.owner)) {
      fail(
        source,
        sourcePath,
        header.index,
        `entrypoint ${header.name}: return owner "${result.owner}" is not an argument`,
      );
    }

    entrypoints.push({
      name: header.name,
      id: ENTRYPOINT_IDS[header.name],
      binding: header.binding,
      from: header.from,
      to: header.to,
      args: header.args,
      guards,
      result,
    });
  }

  return { pragma: pragmaMatch[1], contractName, params, state, entrypoints };
}

// --- artifact --------------------------------------------------------------

function compileSource(source, sourcePath) {
  const parsed = parse(source, sourcePath);
  const wasm = emitWasm(parsed.entrypoints);

  const entrypoints = {};
  for (const ep of parsed.entrypoints) {
    entrypoints[ep.name] = {
      id: ep.id,
      binding: ep.binding,
      from: ep.from,
      to: ep.to,
      args: ep.args,
      guards: ep.guards.map((g) => g.type),
      result: ep.result,
    };
  }

  return {
    schema: SCHEMA,
    compiler: COMPILER,
    compilerVersion: COMPILER_VERSION,
    name: parsed.contractName,
    source: sourcePath.split(/[\\/]/).pop(),
    unspendable: parsed.entrypoints.length === 0,
    wasmBase64: Buffer.from(wasm).toString("base64"),
    contract: {
      pragma: parsed.pragma,
      params: parsed.params,
      state: parsed.state,
      entrypoints,
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

function main(argv) {
  const [mode, arg] = argv;

  if (mode === "--check") {
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
    return;
  }

  if (mode === "--compile") {
    const path = arg;
    const source = readFileSync(path, "utf8");
    process.stdout.write(artifactJson(compileSource(source, path)));
    return;
  }

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

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof Error && err.name === "SilverScriptError") {
    process.stderr.write(`silverc: compile error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
