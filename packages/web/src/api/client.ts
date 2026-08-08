import type {
  BroadcastResult,
  BuildResult,
  WireScriptPublicKey,
  WireUtxo,
  WireUtxoMeta,
} from "./types";

async function apiFetch<T>(path: string, body: unknown): Promise<T> {
  const url = path;
  console.log(`[api] POST ${url}`, JSON.stringify(body));
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[api] fetch failed: ${url}`, err);
    throw new Error("No connection");
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(`[api] ${res.status} ${url}`, text);
    const json = parseErrorJson(text);
    const msg = json?.error?.message ?? `API error ${res.status}`;
    if (msg.toLowerCase().includes("fee") || msg.toLowerCase().includes("mass")) {
      throw new Error("Not enough funds");
    }
    throw new Error(msg);
  }

  const text = await res.text();
  console.log(`[api] 200 ${url}`, text);
  return JSON.parse(text) as T;
}

function parseErrorJson(text: string): { error?: { message?: string } } | null {
  try {
    return JSON.parse(text) as { error?: { message?: string } };
  } catch {
    return null;
  }
}

export interface DeployBuildRequest {
  capacity: number;
  eventId: string;
  price: number;
  orgSpk: string;
  burnTemplateHash: string;
  organizer: string;
  authorizingOutpoint: WireUtxo;
  organizerUtxos: WireUtxo[];
  changeSpk: WireScriptPublicKey;
  inputUtxoMetas: WireUtxoMeta[];
}

export function buildDeployTx(req: DeployBuildRequest): Promise<BuildResult> {
  return apiFetch<BuildResult>("/v1/tx/build", {
    type: "deploy",
    capacity: req.capacity,
    constants: {
      event_id: req.eventId,
      price: req.price,
      org_spk: req.orgSpk,
      burn_template_hash: req.burnTemplateHash,
    },
    organizer: req.organizer,
    authorizing_outpoint: req.authorizingOutpoint,
    organizer_utxos: req.organizerUtxos,
    change_spk: req.changeSpk,
    input_utxo_metas: req.inputUtxoMetas,
  });
}

export function broadcastTx(transaction: unknown): Promise<BroadcastResult> {
  return apiFetch<BroadcastResult>("/v1/tx/broadcast", { transaction });
}
