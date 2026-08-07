export interface CovenantAbi {
  entry: number;
  prevPhase: number;
  authOutputCount: number;
  hasOrgPayout: number;
  holderSigned: number;
  successorIsBurn: number;
  arg: number;
  newPhase: number;
  newOwner: number;
  ownerLen: number;
  constPrice: number;
  constPriceBytes: number;
}

export interface ContractEntrypoint {
  id: number;
  binding: string;
  from: number;
  to: number;
  args: string[];
  guards: string[];
  result: { phase: number; owner: string | null };
}

export interface ContractArtifact {
  schema: string;
  compiler: string;
  compilerVersion: string;
  name: string;
  source: string;
  unspendable: boolean;
  wasmBase64: string;
  contract: {
    pragma: string;
    params: { type: string; name: string }[];
    state: { type: string; name: string; initial: string }[];
    entrypoints: Record<string, ContractEntrypoint>;
    constantsBaked: boolean;
  };
  abi: CovenantAbi;
  resultCodes: Record<string, number>;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function decodeBase64Wasm(wasmBase64: string): Uint8Array<ArrayBuffer> {
  const alphabetIndex = new Uint8Array(128);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    alphabetIndex[BASE64_ALPHABET.charCodeAt(i)] = i;
  }

  const clean = wasmBase64.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = alphabetIndex[code];
    if (value === undefined) {
      throw new Error(`invalid base64 character at index ${i}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
