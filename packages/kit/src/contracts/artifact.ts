export interface CovenantAbi {
  entry: number;
  prevOwner: number;
  prevIdentifierType: number;
  prevAmount: number;
  prevIsMinter: number;
  authOutputCount: number;
  organizerSigned: number;
  holderSigned: number;
  successorIsBurn: number;
  hasOrgPayout: number;
  arg: number;
  newOwner: number;
  newAmount: number;
  newIdentifierType: number;
  newIsMinter: number;
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
  result: { amount: number | string | null; owner: string | null };
}

export interface ContractArtifact {
  schema: string;
  compiler: string;
  compilerVersion: string;
  name: string;
  source: string;
  unspendable: boolean;
  wasmBase64: string;
  /**
   * On-chain script code segment appended after the preimage pushes in the
   * redeem script (`OP_PUSH(state) OP_PUSH(constants) <code>`). Hex string.
   * Pending the pinned silverc script_public_key layout (HLD open question e)
   * this is a deterministic placeholder; see docs/decisions/spike-covenant-runtime.md.
   */
  code: string;
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
const BASE64_CHUNK_BITS = 6;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;
const ALPHABET_INDEX_SIZE = 128;

export function decodeBase64Wasm(wasmBase64: string): Uint8Array<ArrayBuffer> {
  const alphabetIndex = new Uint8Array(ALPHABET_INDEX_SIZE);
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
    buffer = (buffer << BASE64_CHUNK_BITS) | value;
    bits += BASE64_CHUNK_BITS;
    if (bits >= BYTE_BITS) {
      bits -= BYTE_BITS;
      bytes.push((buffer >> bits) & BYTE_MASK);
    }
  }
  return new Uint8Array(bytes);
}
