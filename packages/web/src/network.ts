import { getNetworkConfig } from "@kticket/kit";

export const network = getNetworkConfig(import.meta.env.VITE_KASPANET);
