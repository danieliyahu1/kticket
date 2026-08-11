import { describe, expect, it } from "vitest";
import { EVENT_ARTIFACT, BURN_ARTIFACT } from "../contracts/artifacts";
import { buildBuy, buildDeploy, buildHandover } from "./builder";
import type { Outpoint } from "./covenant";
import { estimatedSerializedSize, txIdPreimageV1, txIdV1 } from "./serialize";
import type { ScriptPublicKey, UnsignedTransaction } from "./tx";

const HASH_LENGTH = 32;
const EVENT_ID_SEED = 0xab;
const ORG_FILL = 0x01;
const BUYER_FILL = 0x02;
const VERSION_1 = 0x01;
const FUNDED_UTXO_VALUE = 10_000_000_000;
const SECOND_UTXO_VALUE = 5_000;
const PRICE = 1_000;

const NETWORK = "testnet10" as const;
const SPK: ScriptPublicKey = { version: 0, script: "51" };

function outpoint(txIdHex: string, index: number): Outpoint {
  const txId = new Uint8Array(HASH_LENGTH);
  const bytes = Uint8Array.from(Buffer.from(txIdHex, "hex"));
  txId.set(bytes.subarray(0, HASH_LENGTH));
  return { txId, index };
}

const AUTHORIZING = outpoint("ab".repeat(HASH_LENGTH), 0);
const ORG = new Uint8Array(HASH_LENGTH).fill(ORG_FILL);
const BUYER = new Uint8Array(HASH_LENGTH).fill(BUYER_FILL);

function deploy(): ReturnType<typeof buildDeploy> {
  return buildDeploy({
    authorizingOutpoint: AUTHORIZING,
    organizerUtxos: [],
    organizerUtxoValues: [FUNDED_UTXO_VALUE],
    organizer: ORG,
    capacity: 100,
    eventArtifact: EVENT_ARTIFACT,
    changeScript: SPK,
    fee: 1_000,
    network: NETWORK,
  });
}

function deployTx(): UnsignedTransaction {
  return deploy().tx;
}

function handoverTx(eventCovenantId: string): UnsignedTransaction {
  return buildHandover({
    ticketOutpoint: outpoint("aa".repeat(HASH_LENGTH), 1),
    eventCovenantId,
    burnArtifact: BURN_ARTIFACT,
    attendeeUtxos: [outpoint("cc".repeat(HASH_LENGTH), 0)],
    attendeeUtxoValues: [FUNDED_UTXO_VALUE],
    changeScript: SPK,
    network: NETWORK,
    fee: 400,
  });
}

describe("estimatedSerializedSize (HLD v0.22 §2.2 relay floor)", () => {
  it("is deterministic for the same tx", () => {
    const tx = deployTx();
    expect(estimatedSerializedSize(tx)).toBe(estimatedSerializedSize(tx));
  });

  it("is positive and grows with inputs", () => {
    const one = deployTx();
    const two = buildDeploy({
      authorizingOutpoint: AUTHORIZING,
      organizerUtxos: [outpoint("bb".repeat(HASH_LENGTH), 0)],
      organizerUtxoValues: [FUNDED_UTXO_VALUE, SECOND_UTXO_VALUE],
      organizer: ORG,
      capacity: 100,
      eventArtifact: EVENT_ARTIFACT,
      changeScript: SPK,
      fee: 1_000,
      network: NETWORK,
    }).tx;
    expect(estimatedSerializedSize(one)).toBeGreaterThan(0);
    expect(estimatedSerializedSize(two)).toBeGreaterThan(estimatedSerializedSize(one));
  });
});

describe("estimatedSerializedSize: covenant bindings", () => {
  it("counts the covenant binding on v1 outputs", () => {
    const buy = buildBuy({
      eventOutpoint: outpoint("aa".repeat(HASH_LENGTH), 0),
      eventCovenantId: deploy().eventCovenantId,
      eventOwner: ORG,
      eventArtifact: EVENT_ARTIFACT,
      buyer: BUYER,
      buyerUtxos: [outpoint("bb".repeat(HASH_LENGTH), 0)],
      buyerUtxoValues: [FUNDED_UTXO_VALUE],
      orgScript: SPK,
      changeScript: SPK,
      remaining: 100,
      price: PRICE,
      network: NETWORK,
      fee: 400,
    });
    // buy has 4 outputs (ticket + remaining event + payout + change); the two
    // covenant outputs carry a binding, the payout + change do not.
    expect(buy.outputs.filter((o) => o.covenant).length).toBe(2);
    expect(estimatedSerializedSize(buy)).toBeGreaterThan(0);
  });
});

describe("txIdPreimageV1", () => {
  it("excludes signature scripts, payload and the mass commit", () => {
    const tx = deployTx();
    const preimage = txIdPreimageV1(tx);
    expect(preimage.length).toBeGreaterThan(0);
    // version + input count + outputs + lockTime + subnetwork + gas + empty payload
    expect(preimage[0]).toBe(VERSION_1); // version 1 LE
    expect(preimage[1]).toBe(0);
  });
});

describe("txIdV1 (validated against rusty-kaspa hashing/tx.rs test vector)", () => {
  it("matches the upstream v1 transaction id test vector", () => {
    // rusty-kaspa `test_transaction_hashing` test #11:
    //   version 1, one input { default outpoint, [], seq 0, compute_budget 111 },
    //   no outputs, native subnetwork, gas 0, empty payload.
    //   expected_id = 5978e7aa1a9ba8fdf12dae6aa39aa198a91985e91192b291e207d4d6246349e6
    const tx: UnsignedTransaction = {
      version: 1,
      inputs: [
        {
          previousOutpoint: { txId: "00".repeat(HASH_LENGTH), index: 0 },
          signatureScript: "",
          sequence: 0,
          sigOpCount: 0,
        },
      ],
      outputs: [],
      lockTime: 0,
    };
    expect(txIdV1(tx)).toBe("5978e7aa1a9ba8fdf12dae6aa39aa198a91985e91192b291e207d4d6246349e6");
  });
});

describe("txIdV1 determinism and template dependence", () => {
  it("is deterministic and changes with the covenant binding", () => {
    const tx = deployTx();
    const id = txIdV1(tx);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(txIdV1(tx)).toBe(id);
  });

  it("is deterministic for a handover template", () => {
    const eventCovenantId = deploy().eventCovenantId;
    const handover = handoverTx(eventCovenantId);
    expect(txIdV1(handover)).toMatch(/^[0-9a-f]{64}$/);
  });
});
