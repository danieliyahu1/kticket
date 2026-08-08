import { orgSpkFromPublicKey } from "./crypto";
import type { WireScriptPublicKey, WireUtxo, WireUtxoMeta } from "./types";

const KASPA_API_URL = "https://api-tn10.kaspa.org";

export interface KaspaUtxoEntry {
  amount: number;
  scriptPublicKey: { version: number; script: string };
  blockDaaScore: number;
  isCoinbase: boolean;
  outpoint: { transactionId: string; index: number };
  address?: string;
}

interface KaspaUtxo {
  address?: string;
  outpoint: { transactionId: string; index: number };
  utxoEntry: {
    amount: string;
    scriptPublicKey: { scriptPublicKey: string };
    blockDaaScore: string;
    isCoinbase: boolean;
  };
}

export async function fetchUtxos(address: string): Promise<KaspaUtxoEntry[]> {
  const res = await fetch(`${KASPA_API_URL}/addresses/${address}/utxos`);
  if (!res.ok) {
    throw new Error("No connection");
  }
  const utxos: KaspaUtxo[] = await res.json();
  return utxos
    .filter((u) => u.outpoint && u.utxoEntry)
    .map((u) => ({
      amount: Number(u.utxoEntry.amount),
      scriptPublicKey: { version: 0, script: u.utxoEntry.scriptPublicKey.scriptPublicKey },
      blockDaaScore: Number(u.utxoEntry.blockDaaScore),
      isCoinbase: u.utxoEntry.isCoinbase,
      outpoint: { transactionId: u.outpoint.transactionId, index: u.outpoint.index },
      ...(typeof u.address === "string" ? { address: u.address } : {}),
    }))
    .sort((a, b) => b.amount - a.amount);
}

export function toWireUtxo(u: KaspaUtxoEntry): WireUtxo {
  return {
    transaction_id: u.outpoint.transactionId,
    index: u.outpoint.index,
    value: u.amount,
  };
}

export function toWireUtxoMeta(u: KaspaUtxoEntry): WireUtxoMeta {
  return {
    transaction_id: u.outpoint.transactionId,
    index: u.outpoint.index,
    value: u.amount,
    script_public_key: { version: u.scriptPublicKey.version, script: u.scriptPublicKey.script },
    block_daa_score: u.blockDaaScore,
    is_coinbase: u.isCoinbase,
    ...(typeof u.address === "string" ? { address: u.address } : {}),
  };
}

export function changeScriptFromPublicKey(publicKeyHex: string): WireScriptPublicKey {
  return { version: 0, script: orgSpkFromPublicKey(publicKeyHex) };
}
