import type { WireTransaction } from "../api/types";

/** SIGHASH_ALL — the consensus default every signing template input is signed with. */
const SIGHASH_ALL = 1;

/**
 * Ask the wallet to sign a signing template. Signing stays in the frontend —
 * the wallet owns the keys. `signInputs` tells the wallet which inputs to sign
 * (the backend lists them in its prepare response).
 *
 * Every sign input carries an explicit `sighashType`. Kasware's `signPskt`
 * derives the sighash from the `sighashType` field and falls back to a zero
 * byte when it is absent; a zero sighash is invalid on-chain and panics
 * Kasware's `signSchnorrTransaction` wasm for multi-input buys. SIGHASH_ALL
 * is what the backend expects for each funded input.
 */
export async function signTemplate(
  signingTemplate: string | null | undefined,
  signInputs?: { index: number }[],
): Promise<unknown> {
  const kasware = window.kasware;
  if (!(kasware && "signPskt" in kasware)) {
    throw new Error("Kasware wallet not available");
  }
  if (!signingTemplate) {
    throw new Error("No signing template from build");
  }
  const inputs = signInputs?.map(({ index }) => ({ index, sighashType: SIGHASH_ALL }));
  return kasware.signPskt({
    txJsonString: signingTemplate,
    ...(inputs && inputs.length > 0 ? { options: { signInputs: inputs } } : {}),
  });
}
