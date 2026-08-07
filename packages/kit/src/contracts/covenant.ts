import type { ContractArtifact, CovenantAbi } from "./artifact.js";
import { decodeBase64Wasm } from "./artifact.js";
import type {
  CovenantContext,
  ResultCode,
  TicketConstants,
  TicketEntrypoint,
  TicketState,
  TransitionResult,
} from "./types.js";
import { RESULT_CODES } from "./types.js";
import { getWasmRuntime } from "./wasm.js";

const RESULT_NAMES: Record<number, string> = {
  [RESULT_CODES.OK]: "OK",
  [RESULT_CODES.ERR_PHASE]: "ERR_PHASE",
  [RESULT_CODES.ERR_AUTH_OUTPUT]: "ERR_AUTH_OUTPUT",
  [RESULT_CODES.ERR_PAYOUT]: "ERR_PAYOUT",
  [RESULT_CODES.ERR_SIG]: "ERR_SIG",
  [RESULT_CODES.ERR_BURN_TEMPLATE]: "ERR_BURN_TEMPLATE",
  [RESULT_CODES.ERR_FUNCTION]: "ERR_FUNCTION",
  [RESULT_CODES.ERR_UNSPENDABLE]: "ERR_UNSPENDABLE",
};

export function availableTicket(): TicketState {
  return { phase: 0, owner: new Uint8Array(32) };
}

export function ownedTicket(owner: Uint8Array): TicketState {
  return { phase: 1, owner };
}

export class Covenant {
  readonly artifact: ContractArtifact;
  readonly constants: Readonly<TicketConstants>;

  #abi: CovenantAbi;
  #transition: () => number;
  #memory: Uint8Array;
  #entryIds: Record<string, number>;

  constructor(artifact: ContractArtifact, constants: TicketConstants) {
    this.artifact = artifact;
    this.#abi = artifact.abi;
    const wasm = getWasmRuntime();
    const module = new wasm.Module(decodeBase64Wasm(artifact.wasmBase64));
    const instance = new wasm.Instance(module, {});
    this.#transition = instance.exports.transition as () => number;
    const memory = instance.exports.memory as { buffer: ArrayBuffer };
    this.#memory = new Uint8Array(memory.buffer);
    this.#entryIds = Object.fromEntries(
      Object.entries(artifact.contract.entrypoints).map(([name, ep]) => [name, ep.id]),
    );
    const view = new DataView(this.#memory.buffer);
    view.setBigUint64(this.#abi.constPrice, BigInt(constants.price), true);
    this.constants = Object.freeze({ ...constants });
  }

  transition(
    entrypoint: TicketEntrypoint,
    prev: TicketState,
    arg: Uint8Array,
    ctx: CovenantContext,
  ): TransitionResult {
    if (this.artifact.unspendable) {
      return this.#fail(RESULT_CODES.ERR_UNSPENDABLE);
    }
    const id = this.#entryIds[entrypoint];
    if (id === undefined) {
      return this.#fail(RESULT_CODES.ERR_FUNCTION);
    }

    const mem = this.#memory;
    mem[this.#abi.entry] = id;
    mem[this.#abi.prevPhase] = prev.phase;
    mem[this.#abi.authOutputCount] = ctx.authOutputCount;
    mem[this.#abi.hasOrgPayout] = ctx.hasOrgPayout ? 1 : 0;
    mem[this.#abi.holderSigned] = ctx.holderSigned ? 1 : 0;
    mem[this.#abi.successorIsBurn] = ctx.successorIsBurn ? 1 : 0;
    mem.set(arg.subarray(0, this.#abi.ownerLen), this.#abi.arg);

    const code = this.#transition();
    if (code !== RESULT_CODES.OK) {
      return this.#fail(code as ResultCode);
    }

    const next: TicketState = {
      phase: mem[this.#abi.newPhase] as TicketState["phase"],
      owner: mem.slice(this.#abi.newOwner, this.#abi.newOwner + this.#abi.ownerLen),
    };
    return { ok: true, code: RESULT_CODES.OK, state: next };
  }

  #fail(code: ResultCode): TransitionResult {
    return { ok: false, code, reason: RESULT_NAMES[code] ?? `ERR_${code}` };
  }
}
