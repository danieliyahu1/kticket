import { BURN_ARTIFACT, EVENT_ARTIFACT, TICKET_ARTIFACT } from "./contracts/artifacts.js";
import { Covenant, eventCovenant, ticketCovenant } from "./contracts/covenant.js";
import { RESULT_CODES } from "./contracts/types.js";
import type { KaspaNetwork, NetworkConfig } from "./network.js";
import {
  getNetworkConfig,
  isKaspaNetwork,
  KASPA_NETWORK_IDS,
  NETWORKS,
  resolveNetwork,
} from "./network.js";
import {
  addressFor,
  addressFromScriptHash,
  availableTicketAddress,
  buildRedeemScript,
  encodeAddress,
  scriptHash,
} from "./runtime/address.js";
import {
  buildBuy,
  buildDeploy,
  buildHandover,
  buildTransfer,
  burnTemplateHash,
  decodeMetadataFromPayload,
  DUST,
  encodeMetadataPayload,
  MAX_EVENT_CAPACITY,
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
import {
  computeMassLocal,
  decodeSigOpCount,
  estimatedSerializedSize,
  payloadDigest,
  txIdPreimageV1,
  txIdV1,
} from "./runtime/serialize.js";

export type {
  ContractArtifact,
  ContractEntrypoint,
  CovenantAbi,
} from "./contracts/artifact.js";
export type {
  CovenantContext,
  IdentifierType,
  Kcc20Constants,
  Kcc20State,
  ResultCode,
  TicketEntrypoint,
  TransitionResult,
} from "./contracts/types.js";
export type {
  AddressNetwork,
  AddressOptions,
  RedeemScript,
} from "./runtime/address.js";
export type {
  BuyInput,
  DeployInput,
  DeployResult,
  EventMetadata,
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
  ScriptPublicKey,
  SerializedOutpoint as TxOutpoint,
  TxInput,
  TxOutput,
  UnsignedTransaction,
} from "./runtime/tx.js";
export type { KaspaNetwork, NetworkConfig };
export {
  addressFor,
  addressFromScriptHash,
  availableTicketAddress,
  BURN_ARTIFACT,
  buildBuy,
  buildDeploy,
  buildHandover,
  buildRedeemScript,
  buildTransfer,
  burnTemplateHash,
  Covenant,
  computeFee,
  computeMassLocal,
  covenantId,
  decodeConstants,
  decodeMetadataFromPayload,
  decodePreimage,
  decodeSigOpCount,
  decodeState,
  DUST,
  encodeAddress,
  encodeConstants,
  encodeMetadataPayload,
  encodePreimage,
  encodeState,
  estimatedSerializedSize,
  EVENT_ARTIFACT,
  eventCovenant,
  getNetworkConfig,
  isKaspaNetwork,
  KASPA_NETWORK_IDS,
  MAX_EVENT_CAPACITY,
  NETWORKS,
  p2shScript,
  payloadDigest,
  RESULT_CODES,
  relayFloor,
  requiredInput,
  resolveNetwork,
  scriptHash,
  TICKET_ARTIFACT,
  ticketCovenant,
  txIdPreimageV1,
  txIdV1,
};
