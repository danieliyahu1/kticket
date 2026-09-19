import { devError, devLog, devWarn } from "./log";
import { network } from "../network";

/** SIGHASH_ALL — the consensus default every signing template input is signed with. */
const SIGHASH_ALL = 1;

/**
 * Ask the wallet to sign a signing template. Signing stays in the frontend —
 * the wallet owns the keys.
 *
 * Kasware's `signPskt` signs the template (kaspa-wasm safe-JSON built by the
 * backend) without broadcasting. `signInputs` tells the wallet which inputs to
 * sign (the backend lists them in its prepare response); omitting it makes the
 * wallet sign every input it owns. Every requested input carries an explicit
 * `sighashType` — Kasware falls back to a zero byte when it is absent, and a
 * zero sighash is invalid on-chain (it panics Kasware's Schnorr wasm for
 * multi-input spends). SIGHASH_ALL is what the backend expects per funded
 * input. Finalize matches signatures by outpoint on the backend.
 */
export async function signTemplate(
  signingTemplate: string | null | undefined,
  signInputs?: { index: number }[],
): Promise<unknown> {
  const kasware = window.kasware;
  if (!(kasware && typeof kasware.signPskt === "function")) {
    throw new Error("Kasware wallet not available");
  }
  if (!signingTemplate) {
    throw new Error("No signing template from build");
  }
  const requested = describeTemplateInputs(signingTemplate);
  devLog(`[kasware:sign] network=${network.networkId} inputs=[${kinds(requested)}]`);
  const inputs = signInputs?.map(({ index }) => ({ index, sighashType: SIGHASH_ALL }));
  let result: unknown;
  try {
    result = await kasware.signPskt({
      txJsonString: signingTemplate,
      ...(inputs && inputs.length > 0 ? { options: { signInputs: inputs } } : {}),
    });
  } catch (err) {
    devError(
      "[kasware:sign] wallet rejected the signing request:",
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
    for (const key of ["txJsonString", "txJson", "signedTx", "tx"]) {
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
      devWarn("[kasware:sign] could not inspect the signed result (unexpected shape)");
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
    devLog(`[kasware:sign] result=[${parts.join(" ")}]`);

    for (const fact of requested) {
      if (fact.kind === "script" && signed.get(fact.key)) {
        devLog("[kasware:sign] covenant/script input was signed — co-signing works");
      }
      if (fact.kind === "script" && !signed.get(fact.key)) {
        devWarn(
          `[kasware:sign] script/covenant input ${fact.index} came back UNSIGNED — Kasware did not co-sign it; if finalize requires this signature the flow will fail`,
        );
      }
    }
  } catch (err) {
    devWarn(
      "[kasware:sign] outcome inspection failed (signing itself succeeded):",
      err instanceof Error ? err.message : typeof err,
    );
  }
}
