// Whole-issue integration test for KTK-119 (door flow, sub-issue KTK-147).
//
// The door flow as a black box through the API: owner prepare → owner signs →
// QR payload codec round-trip → gate sign-template re-derive → gate co-signs
// input 0 → gate finalize (merge, assemble, broadcast) → confirmed txid.
//
// The chain/wallet harness lives in test-chain.ts.

import {
  assembleMarkUsedSigScript,
  decodeUsePayload,
  encodeUsePayload,
  injectState,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import {
  B0_ID,
  FakeKaspa,
  OWNER_ADDRESS,
  OWNER_PUBKEY_HEX,
  OWNER_UTXO_TXID,
  TICKET_ID,
  TICKET_OWNER_HEX,
  USED_TXID,
  buildAppWith,
  eventArtifact,
  seedBaseChain,
} from "./test-chain";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

import { submitTransactionOverWrpc } from "./wrpc-client.js";

const mockedSubmit = vi.mocked(submitTransactionOverWrpc);

describe("door flow end-to-end (KTK-119 whole-issue integration)", () => {
  it("admits the holder: prepare → sign → QR round-trip → sign-template → co-sign → finalize → confirmed", async () => {
    const kaspa = new FakeKaspa();
    seedBaseChain(kaspa);
    mockedSubmit.mockResolvedValue(USED_TXID);
    kaspa.transactions.set(USED_TXID, { transaction_id: USED_TXID, inputs: [], outputs: [] });
    const app = await buildAppWith(kaspa);

    // 1. Owner prepare — the backend verifies + builds the mark_used template.
    const prepare = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/prepare`,
      payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS },
    });
    expect(prepare.statusCode).toBe(200);
    const prepared = prepare.json();
    expect(prepared.sign_inputs_owner).toEqual([{ index: 0 }, { index: 1 }]);

    // 2. Owner signs every input; the QR payload is built from the template.
    const owner_signed = {
      inputs: prepared.sign_inputs_owner.map(({ index }: { index: number }) => ({
        transactionId: index === 0 ? B0_ID : OWNER_UTXO_TXID,
        index,
        signatureScript: `41${"aa".repeat(65)}`,
      })),
    };
    const payload = { use_id: prepared.use_id, template: prepared.template, owner_signed };
    const qr = await encodeUsePayload(payload);
    const decoded = await decodeUsePayload(qr);
    expect(decoded).toEqual(payload);

    // 3. Gate scans → re-derives the signing template (stateless rebuild).
    const signTemplate = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/sign-template`,
      payload: { template: prepared.template },
    });
    expect(signTemplate.statusCode).toBe(200);
    expect(typeof signTemplate.json().signing_template).toBe("string");

    // 4. Gate co-signs input 0 only, then finalize assembles + broadcasts.
    const gate_signed = {
      inputs: [{ transactionId: B0_ID, index: 0, signatureScript: `41${"bb".repeat(65)}` }],
    };
    const finalize = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/finalize`,
      payload: {
        use_id: decoded.use_id,
        template: decoded.template,
        owner_signed: decoded.owner_signed,
        gate_signed,
      },
    });
    expect(finalize.statusCode).toBe(200);
    expect(finalize.json()).toEqual({ txid: USED_TXID });
    expect(kaspa.clearCalls).toBe(1);

    // 5. The broadcast tx's input 0 carries the assembled mark_used sig-script
    //    (push(owner_sig) || push(gate_sig) || selector || push(redeem)).
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    const broadcastArg = mockedSubmit.mock.calls[0]?.[1] as {
      inputs: { signature_script: string }[];
    };
    const ownerBytes = hexToBytes(`41${"aa".repeat(65)}`).slice(1);
    const gateBytes = hexToBytes(`41${"bb".repeat(65)}`).slice(1);
    const redeem = injectState(eventArtifact(), {
      owner: hexToBytes(TICKET_OWNER_HEX),
      identifierType: 0,
      amount: 1,
      isMinter: false,
      used: false,
      salePrice: 0,
    });
    const expectedScript = bytesToHex(
      assembleMarkUsedSigScript(eventArtifact(), ownerBytes, gateBytes, redeem),
    );
    expect(broadcastArg.inputs[0]?.signature_script).toBe(expectedScript);

    await app.close();
  });
});
