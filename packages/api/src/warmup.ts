// Background warm-up (KTK-89): on boot, verify every registered event so the
// first directory read hits a warm memo cache instead of paying the chain-read
// latency inline. Fire-and-forget: a slow or failing warm-up never blocks
// startup or requests — the request path re-verifies (and caches) on demand.
//
// The same pass enforces the paid-only rule: a registered event whose verified
// price is below the floor is removed from the discovery registry. Reads filter
// unpaid events too, so the cleanup can lag without ever serving one.
//
// The run is measured for operational visibility: how long it took, how many
// runs succeeded fully / partially / not at all, and when the last full success
// happened (so a permanently failing warm-up is visible as a stale timestamp).

import { elapsedSeconds, metrics } from "./metrics.js";
import { isPaidEvent } from "./event-policy.js";
import type { AppContext } from "./routes.js";

interface WarmupLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export async function warmVerifiedEvents(
  ctx: AppContext,
  logger?: WarmupLogger,
): Promise<void> {
  const started = process.hrtime();
  const entries = ctx.events.list();
  let failures = 0;
  let removed = 0;

  await Promise.all(
    entries.map(async (entry) => {
      try {
        const event = await ctx.verified.verify(ctx.kaspa, ctx.network, entry.deployTxId);
        if (isPaidEvent(event)) return;
        await ctx.events.remove(entry.covenantId);
        removed += 1;
      } catch {
        failures += 1;
      }
    }),
  );

  if (removed > 0) {
    logger?.info({ removed }, "removed unpaid events from registry");
  }

  const result = failures === 0 ? "success" : failures === entries.length ? "error" : "partial";
  metrics.observeWarmup(result, elapsedSeconds(started));
}
