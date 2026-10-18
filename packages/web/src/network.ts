import { getNetworkConfig } from "@kticket/kit";

/**
 * The build-time network, used only as a fallback when `GET /v1/config` cannot
 * be reached (KTK-176). The deployed server is the authority at runtime; this
 * value keeps local development working before the API answers.
 */
export const fallbackNetwork = getNetworkConfig(import.meta.env.VITE_KASPANET);
