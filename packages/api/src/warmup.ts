// Background warm-up (KTK-89): on boot, verify every registered event so the
// first directory read hits a warm memo cache instead of paying the chain-read
// latency inline. Fire-and-forget: a slow or failing warm-up never blocks
// startup or requests — the request path re-verifies (and caches) on demand.
//
// The run is measured for operational visibility: how long it took, how many
// runs succeeded fully / partially / not at all, and when the last full success
// happened (so a permanently failing warm-up is visible as a stale timestamp).

import { elapsedSeconds, metrics } from "./metrics.js";
import type { AppContext } from "./routes.js";

export async function warmVerifiedEvents(ctx: AppContext): Promise<void> {
  const started = process.hrtime();
  const entries = ctx.events.list();
  let failures = 0;

  await Promise.all(
    entries.map((entry) =>
      ctx.verified
        .verify(ctx.kaspa, ctx.network, entry.deployTxId)
        .catch(() => {
          failures += 1;
          return undefined;
        }),
    ),
  );

  const result = failures === 0 ? "success" : failures === entries.length ? "error" : "partial";
  metrics.observeWarmup(result, elapsedSeconds(started));
}
