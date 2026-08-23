import burnArtifactJson from "../../artifacts/burn.artifact.json";
import eventArtifactJson from "../../artifacts/event.artifact.json";
import type { CompiledContractArtifact } from "./artifact.js";

/**
 * The event/ticket covenant (HLD v0.22 §2.1): `mint` splits off a ticket
 * (amount=1), `mark_used` checks it in at the door, resale moves it via
 * list / purchase / delist. A minted ticket is a covenant instance of this
 * same contract with amount=1.
 */
export const EVENT_ARTIFACT: CompiledContractArtifact = eventArtifactJson as CompiledContractArtifact;

/** Alias kept for code that treats a minted ticket as the covenant artifact. */
export const TICKET_ARTIFACT: CompiledContractArtifact = eventArtifactJson as CompiledContractArtifact;

/** Unspendable burn-owner covenant — the handover successor. */
export const BURN_ARTIFACT: CompiledContractArtifact = burnArtifactJson as CompiledContractArtifact;
