import { BURN_ARTIFACT, EVENT_ARTIFACT, TICKET_ARTIFACT } from "./contracts/artifacts.js";
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
  buildBurnRedeemScript,
  buildRedeemScript,
  encodeAddress,
  injectState,
  pushData,
  readStateFromRedeem,
  scriptHash,
} from "./runtime/address.js";
import {
  buildBuy,
  buildDeploy,
  buildHandover,
  buildTransfer,
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
  decodeVarint,
  encodeConstants,
  encodePreimage,
  encodeState,
  encodeVarint,
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
  CompiledContractArtifact,
  CompiledStateLayout,
  FunctionAbiEntry,
  FunctionInputAbi,
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
  buildBurnRedeemScript,
  buildBuy,
  buildDeploy,
  buildHandover,
  buildRedeemScript,
  buildTransfer,
  BURN_ARTIFACT,
  computeFee,
  computeMassLocal,
  covenantId,
  decodeConstants,
  decodeMetadataFromPayload,
  decodePreimage,
  decodeSigOpCount,
  decodeState,
  decodeVarint,
  DUST,
  encodeAddress,
  encodeConstants,
  encodeMetadataPayload,
  encodePreimage,
  encodeState,
  encodeVarint,
  estimatedSerializedSize,
  EVENT_ARTIFACT,
  getNetworkConfig,
  injectState,
  isKaspaNetwork,
  KASPA_NETWORK_IDS,
  MAX_EVENT_CAPACITY,
  NETWORKS,
  p2shScript,
  payloadDigest,
  pushData,
  readStateFromRedeem,
  relayFloor,
  RESULT_CODES,
  requiredInput,
  resolveNetwork,
  scriptHash,
  TICKET_ARTIFACT,
  txIdPreimageV1,
  txIdV1,
};
