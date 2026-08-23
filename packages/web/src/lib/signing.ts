import { devError, devLog, devWarn } from "./log";
import { network } from "../network";

/**
 * Ask the wallet to sign a signing template. Signing stays in the frontend —
 * the wallet owns the keys.
 *
 * Kastle's `signTx` signs the template (kaspa-wasm safe-JSON built by the
 * backend) without broadcasting: inputs owned by the connected account are
 * signed with SIGHASH_ALL, already-signed inputs are left untouched. Finalize
 * matches signatures by outpoint on the backend.
 *
 * We assume Kastle also signs script/covenant-locked inputs (KasWare force-
 * signed them via explicit input lists; resale list/delist, check-in QR and
 * gate co-sign depend on it). Dev builds log which inputs carry a script lock
 * and which came back signed; the authoritative per-input outcome is logged
 * server-side at finalize (`describeWalletSignatures` in the API), where it
 * belongs — production clients log nothing here.
 */
export async function signTemplate(
  signingTemplate: string | null | undefined,
): Promise<unknown> {
  const kastle = window.kastle;
  if (!(kastle && typeof kastle.signTx === "function")) {
    throw new Error("Kastle wallet not available");
  }
  if (!signingTemplate) {
    throw new Error("No signing template from build");
  }
  const requested = describeTemplateInputs(signingTemplate);
  devLog(`[kastle:sign] network=${network.networkId} inputs=[${kinds(requested)}]`);
  let result: unknown;
  try {
    result = await kastle.signTx(network.networkId, signingTemplate);
  } catch (err) {
    devError(
      "[kastle:sign] wallet rejected the signing request:",
      err instanceof Error ? err.message : typeof err,
    );
    throw err;
  }
  reportOutcome(requested, result);
  return result;
}

/** A v0 P2PK lock: push(33B compressed or 32B x-only pubkey) + OP_CHECKSIG. */
const P2PK_SCRIPT = /^2[01][0-9a-f]{64,66}ac$/;

interface InputFact {
  /** Correlation key `<txid>:<index>` shared by template and signed result. */
  key: string;
  index: number;
  kind: "p2pk" | "script";
}

function kinds(facts: InputFact[]): string {
  return facts.map((f) => `${f.index}:${f.kind}`).join(" ");
}

function outpointOf(input: Record<string, unknown>): { id?: unknown; index?: unknown } {
  const nested = input.previousOutpoint as Record<string, unknown> | undefined;
  if (nested && typeof nested === "object") {
    return { id: nested.transactionId, index: nested.index };
  }
  return { id: input.transactionId, index: input.index };
}

/** Best-effort inventory of the template's inputs; never throws. */
function describeTemplateInputs(signingTemplate: string): InputFact[] {
  try {
    const parsed = JSON.parse(signingTemplate) as { inputs?: unknown };
    if (!Array.isArray(parsed.inputs)) return [];
    const facts: InputFact[] = [];
    parsed.inputs.forEach((entry, position) => {
      if (typeof entry !== "object" || entry === null) return;
      const input = entry as Record<string, unknown>;
      const { id, index } = outpointOf(input);
      if (typeof id !== "string") return;
      const utxo = input.utxo as Record<string, unknown> | undefined;
      const spk = utxo?.scriptPublicKey as Record<string, unknown> | undefined;
      const script = typeof spk?.script === "string" ? spk.script : "";
      facts.push({
        key: `${id.toLowerCase()}:${String(index ?? position)}`,
        index: typeof index === "number" ? index : position,
        kind: P2PK_SCRIPT.test(script) ? "p2pk" : "script",
      });
    });
    return facts;
  } catch {
    return [];
  }
}

function extractSignedJson(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (typeof result === "object" && result !== null) {
    for (const key of ["txJson", "signedTx", "tx"]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
  }
  return null;
}

/** Compare what we asked for against what the wallet actually signed. */
function reportOutcome(requested: InputFact[], result: unknown): void {
  try {
    const json = extractSignedJson(result);
    if (json === null) {
      devWarn("[kastle:sign] could not inspect the signed result (unexpected shape)");
      return;
    }
    const parsed: unknown = JSON.parse(json);
    const signed = new Map<string, boolean>();
    if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { inputs?: unknown }).inputs)) {
      ((parsed as { inputs: unknown[] }).inputs).forEach((entry, position) => {
        if (typeof entry !== "object" || entry === null) return;
        const input = entry as Record<string, unknown>;
        const { id, index } = outpointOf(input);
        if (typeof id !== "string") return;
        signed.set(`${id.toLowerCase()}:${String(index ?? position)}`, typeof input.signatureScript === "string" && input.signatureScript.length > 0);
      });
    }

    // Input positions only — never outpoints, addresses or amounts.
    const parts = requested.map((fact) => {
      // An input missing from the result counts as unsigned — the wallet
      // either skipped it or returned a partial transaction.
      return `${fact.index}:${fact.kind}${signed.get(fact.key) ? ":signed" : ":UNSIGNED"}`;
    });
    devLog(`[kastle:sign] result=[${parts.join(" ")}]`);

    for (const fact of requested) {
      if (fact.kind === "script" && signed.get(fact.key)) {
        devLog("[kastle:sign] covenant/script input was signed — co-signing works");
      }
      if (fact.kind === "script" && !signed.get(fact.key)) {
        devWarn(
          `[kastle:sign] script/covenant input ${fact.index} came back UNSIGNED — Kastle did not co-sign it; if finalize requires this signature the flow will fail`,
        );
      }
    }
  } catch (err) {
    devWarn(
      "[kastle:sign] outcome inspection failed (signing itself succeeded):",
      err instanceof Error ? err.message : typeof err,
    );
  }
}
