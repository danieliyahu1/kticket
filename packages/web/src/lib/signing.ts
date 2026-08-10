import type { WireTransaction } from "../api/types";

export const SOMPI_PER_KAS = 100_000_000;

/**
 * Ask the wallet to sign a signing template. Signing stays in the frontend —
 * the wallet owns the keys. `signInputs` tells the wallet which inputs to sign
 * (the backend lists them in its prepare response).
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
  return kasware.signPskt({
    txJsonString: signingTemplate,
    ...(signInputs ? { options: { signInputs } } : {}),
  });
}
