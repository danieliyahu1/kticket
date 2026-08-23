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
  p2pkAddress,
  p2pkAddressFromScript,
  P2PK_ADDRESS_VERSION,
  pubkeyFromP2pkScript,
  pushData,
  readStateFromRedeem,
  scriptHash,
} from "./runtime/address.js";
import {
  buildBuy,
  buildDelist,
  buildDeploy,
  buildHandover,
  buildList,
  buildMarkUsed,
  buildPurchase,
  decodeMetadataFromPayload,
  DUST,
  encodeMetadataPayload,
  MAX_EVENT_CAPACITY,
  p2pkScriptFromPubkey,
  p2shScript,
} from "./runtime/builder.js";
import { covenantId } from "./runtime/covenant.js";
import { computeFee, kasToSompi, relayFloor, requiredInput, SOMPI_PER_KAS } from "./runtime/fee.js";
import { eventCommitmentMatches, eventOutputScript, organizerAddressFromPubkeyHex, organizerPkh, orgSpkFromPublicKey, recoverEventCapacity } from "./runtime/provenance.js";
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
import {
  decodeTicketId,
  decodeUsePayload,
  encodeTicketId,
  encodeUsePayload,
  type TicketId,
  type UsePayload,
} from "./runtime/payload.js";
import {
  assembleMarkUsedSigScript,
  markUsedSelector,
  usedStateAddress,
} from "./runtime/mark-used.js";
import {
  assembleDelistSigScript,
  assembleListSigScript,
  assemblePurchaseSigScript,
  listedStateAddress,
  pushI64,
  resaleSelector,
} from "./runtime/resale.js";

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
export type { EventState } from "./runtime/provenance.js";
export type {
  BuyInput,
  DelistInput,
  DeployInput,
  DeployResult,
  EventMetadata,
  HandoverInput,
  ListInput,
  MarkUsedInput,
  PurchaseInput,
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
export type { TicketId, UsePayload } from "./runtime/payload.js";
export type { KaspaNetwork, NetworkConfig };
export {
  assembleMarkUsedSigScript,
  markUsedSelector,
  usedStateAddress,
} from "./runtime/mark-used.js";
export {
  assembleDelistSigScript,
  assembleListSigScript,
  assemblePurchaseSigScript,
  listedStateAddress,
  pushI64,
  resaleSelector,
} from "./runtime/resale.js";
export {
  addressFor,
  addressFromScriptHash,
  availableTicketAddress,
  buildBurnRedeemScript,
  buildBuy,
  buildDelist,
  buildDeploy,
  buildHandover,
  buildList,
  buildMarkUsed,
  buildPurchase,
  buildRedeemScript,
  BURN_ARTIFACT,
  computeFee,
  computeMassLocal,
  covenantId,
  decodeConstants,
  decodeMetadataFromPayload,
  decodePreimage,
  decodeSigOpCount,
  decodeState,
  decodeTicketId,
  decodeUsePayload,
  decodeVarint,
  DUST,
  encodeAddress,
  encodeConstants,
  encodeMetadataPayload,
  encodePreimage,
  encodeState,
  encodeTicketId,
  encodeUsePayload,
  encodeVarint,
  estimatedSerializedSize,
  EVENT_ARTIFACT,
  eventCommitmentMatches,
  eventOutputScript,
  getNetworkConfig,
  injectState,
  isKaspaNetwork,
  kasToSompi,
  KASPA_NETWORK_IDS,
  MAX_EVENT_CAPACITY,
  NETWORKS,
  organizerAddressFromPubkeyHex,
  organizerPkh,
  orgSpkFromPublicKey,
  p2pkAddress,
  p2pkAddressFromScript,
  P2PK_ADDRESS_VERSION,
  p2pkScriptFromPubkey,
  p2shScript,
  payloadDigest,
  pubkeyFromP2pkScript,
  pushData,
  readStateFromRedeem,
  recoverEventCapacity,
  relayFloor,
  RESULT_CODES,
  requiredInput,
  resolveNetwork,
  scriptHash,
  SOMPI_PER_KAS,
  TICKET_ARTIFACT,
  txIdPreimageV1,
  txIdV1,
};
