// Background warm-up (KTK-89): on boot, verify every registered event so the
// first directory read hits a warm memo cache instead of paying the chain-read
// latency inline. Fire-and-forget: a slow or failing warm-up never blocks
// startup or requests — the request path re-verifies (and caches) on demand.

import type { AppContext } from "./routes.js";

export async function warmVerifiedEvents(ctx: AppContext): Promise<void> {
  await Promise.all(
    ctx.events
      .list()
      .map((entry) =>
        ctx.verified
          .verify(ctx.kaspa, ctx.network, entry.deployTxId)
          .catch(() => undefined),
      ),
  );
}
