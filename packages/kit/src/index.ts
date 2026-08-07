import { BURN_ARTIFACT, TICKET_ARTIFACT } from "./contracts/artifacts.js";
import { availableTicket, Covenant, ownedTicket, pkh } from "./contracts/covenant.js";
import { RESULT_CODES } from "./contracts/types.js";
import type { KaspiaNet, NetworkConfig } from "./network.js";
import { getNetworkConfig, isKaspiaNet, KASPANETS, NETWORKS, resolveNetwork } from "./network.js";

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
export type { KaspiaNet, NetworkConfig };
export {
  availableTicket,
  BURN_ARTIFACT,
  Covenant,
  getNetworkConfig,
  isKaspiaNet,
  KASPANETS,
  NETWORKS,
  ownedTicket,
  pkh,
  RESULT_CODES,
  resolveNetwork,
  TICKET_ARTIFACT,
};
