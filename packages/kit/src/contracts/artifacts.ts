import burnArtifactJson from "../../artifacts/burn.artifact.json";
import eventArtifactJson from "../../artifacts/event.artifact.json";
import type { ContractArtifact } from "./artifact.js";

/**
 * The event/ticket covenant (HLD v0.22 §2.1): `mint` splits off a ticket
 * (amount=1), `transfer` re-binds a holder, `use` consumes into the burn-owner.
 * A minted ticket is a covenant instance of this same contract with amount=1.
 */
export const EVENT_ARTIFACT: ContractArtifact = eventArtifactJson;

/** Alias kept for code that treats a minted ticket as the covenant artifact. */
export const TICKET_ARTIFACT: ContractArtifact = eventArtifactJson;

/** Unspendable burn-owner covenant — the handover successor. */
export const BURN_ARTIFACT: ContractArtifact = burnArtifactJson;
