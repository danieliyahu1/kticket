// kticket compiled-contract artifact schema (KTK-88 A4).
//
// Mirrors the `CompiledContract` the `kticket-silverc` Rust wrapper emits
// (silverscript-lang): the full redeem script bytecode with the mutable state
// occupying a contiguous slot, plus the template hash of the non-state parts.

export interface CompiledStateLayout {
  start: number;
  len: number;
}

export interface FunctionInputAbi {
  name: string;
  type_name: string;
}

export interface FunctionAbiEntry {
  name: string;
  inputs: FunctionInputAbi[];
}

export interface CompiledContractArtifact {
  schema: "kticket/compiled-contract/v1";
  contract_name: string;
  compiler_version: string;
  silverscript_rev: string;
  /** Full redeem script = template prefix | state slot | template suffix. */
  bytecode: number[];
  /** Slice indices into `bytecode` where the mutable state lives. */
  state_layout: CompiledStateLayout;
  /** hash(prefix || suffix) — the burn-template hash concept. */
  template_hash: number[];
  /** Whether the bytecode omits the entrypoint selector (single entrypoint). */
  without_selector: boolean;
  /** Entrypoint selectors + typed args, consumed for sigscript construction. */
  abi: FunctionAbiEntry[];
}
