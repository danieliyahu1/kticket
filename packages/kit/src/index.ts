import { BURN_ARTIFACT, TICKET_ARTIFACT } from "./contracts/artifacts.js";
import { availableTicket, Covenant, ownedTicket, pkh } from "./contracts/covenant.js";
import { RESULT_CODES } from "./contracts/types.js";
import type { KaspiaNet, NetworkConfig } from "./network.js";
import { getNetworkConfig, isKaspiaNet, KASPANETS, NETWORKS, resolveNetwork } from "./network.js";
import {
  addressFor,
  availableTicketAddress,
  buildRedeemScript,
  encodeAddress,
  scriptHash,
} from "./runtime/address.js";
import {
  buildBuy,
  buildGenesis,
  buildHandover,
  buildTransfer,
  p2shScript,
} from "./runtime/builder.js";
import { covenantId } from "./runtime/covenant.js";
import { computeFee, relayFloor, requiredInput } from "./runtime/fee.js";
import {
  decodeConstants,
  decodePreimage,
  decodeState,
  encodeConstants,
  encodePreimage,
  encodeState,
} from "./runtime/preimage.js";

export type {
  ContractArtifact,
  ContractEntrypoint,
  CovenantAbi,
} from "./contracts/artifact.js";
export type {
  CovenantContext,
  ResultCode,
  TicketConstants,
  TicketEntrypoint,
  TicketPhase,
  TicketState,
  TransitionResult,
} from "./contracts/types.js";
export type {
  AddressNetwork,
  AddressOptions,
  RedeemScript,
} from "./runtime/address.js";
export type {
  BuyInput,
  GenesisInput,
  GenesisResult,
  HandoverInput,
  TransferInput,
} from "./runtime/builder.js";
export type { AuthorizedOutput, Outpoint } from "./runtime/covenant.js";
export type { FeeInput, FeeResult, MassAndSize } from "./runtime/fee.js";
export type {
  DecodedConstants,
  DecodedState,
  Preimage,
} from "./runtime/preimage.js";
export type {
  CovenantBinding,
  Outpoint as TxOutpoint,
  ScriptPublicKey,
  TxInput,
  TxOutput,
  UnsignedTransaction,
} from "./runtime/tx.js";
export type { KaspiaNet, NetworkConfig };
export {
  addressFor,
  availableTicket,
  availableTicketAddress,
  BURN_ARTIFACT,
  buildBuy,
  buildGenesis,
  buildHandover,
  buildRedeemScript,
  buildTransfer,
  Covenant,
  computeFee,
  covenantId,
  decodeConstants,
  decodePreimage,
  decodeState,
  encodeAddress,
  encodeConstants,
  encodePreimage,
  encodeState,
  getNetworkConfig,
  isKaspiaNet,
  KASPANETS,
  NETWORKS,
  ownedTicket,
  p2shScript,
  pkh,
  RESULT_CODES,
  relayFloor,
  requiredInput,
  resolveNetwork,
  scriptHash,
  TICKET_ARTIFACT,
};
