import type { BuildResult, WireTransaction } from "../api/types";

export const SOMPI_PER_KAS = 100_000_000;

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

export function mergeSignatures(
  template: WireTransaction,
  signed: unknown,
): WireTransaction {
  const json = typeof signed === "string" ? signed : String(signed);
  const parsed = JSON.parse(json) as {
    inputs?: Array<{ transactionId: string; index: number; signatureScript?: string }>;
  };
  const byInput = new Map(
    (parsed.inputs ?? []).map((input) => [
      `${input.transactionId}:${input.index}`,
      input,
    ]),
  );
  return {
    ...template,
    inputs: template.inputs.map((input) => {
      const key = `${input.previous_outpoint.transaction_id}:${input.previous_outpoint.index}`;
      const si = byInput.get(key);
      return {
        ...input,
        signature_script: si?.signatureScript ?? input.signature_script,
      };
    }),
  };
}
