import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BURN_ARTIFACT, TICKET_ARTIFACT } from "./artifacts";

const KIT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SILVERC = fileURLToPath(new URL("../../scripts/silverc.mjs", import.meta.url));

function runCompiler(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [SILVERC, ...args], {
      cwd: KIT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

describe("silverc compile pipeline", () => {
  it("compiled artifacts are in sync with the committed ones", () => {
    const ticket = runCompiler(["--compile", "contracts/ticket.silverscript"]);
    expect(ticket.status).toBe(0);
    expect(JSON.parse(ticket.stdout)).toEqual(TICKET_ARTIFACT);

    const burn = runCompiler(["--compile", "contracts/burn.silverscript"]);
    expect(burn.status).toBe(0);
    expect(JSON.parse(burn.stdout)).toEqual(BURN_ARTIFACT);
  });

  it("produces deterministic output across runs", () => {
    const a = runCompiler(["--compile", "contracts/ticket.silverscript"]);
    const b = runCompiler(["--compile", "contracts/ticket.silverscript"]);
    expect(a.stdout).toBe(b.stdout);
  });

  it("fails with a clear message on a malformed contract", () => {
    const result = runCompiler(["--compile", "contracts/fixtures/bad.silverscript"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("compile error");
  });
});
