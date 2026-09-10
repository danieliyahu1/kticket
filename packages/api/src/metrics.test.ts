import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { EventStore } from "./eventstore";
import { KaspaClient } from "./kaspa-client";
import { metrics, startMetricsServer } from "./metrics";
import type { AppContext } from "./routes";
import { VerifiedEventCache } from "./verified-cache";
import { warmVerifiedEvents } from "./warmup";

const AUTH_SECRET = "test-secret-for-kticket-api";

function testConfig() {
  return loadConfig({ KASPANET: "testnet10", PORT: "0", AUTH_SECRET });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("metrics", () => {
  beforeEach(() => {
    metrics.reset();
  });

  it("records HTTP requests by route template and never the raw URL", async () => {
    const app = await buildApp(testConfig());
    app.get(
      "/widgets/:widgetId",
      { config: { kticketFlow: "widget.read" } },
      async () => ({ ok: true }),
    );

    await app.inject({ method: "GET", url: "/widgets/secret-widget-123" });

    const text = await metrics.render();
    expect(text).toContain(
      'kticket_http_requests_total{method="GET",route="/widgets/:widgetId",status_class="2xx"} 1',
    );
    expect(text).toContain('kticket_flows_total{flow="widget.read",result="success"} 1');
    expect(text).not.toContain("secret-widget-123");

    await app.close();
  });

  it("records 4xx errors on the unmatched route without leaking the URL", async () => {
    const app = await buildApp(testConfig());
    await app.inject({ method: "GET", url: "/nope-secret-456" });

    const text = await metrics.render();
    expect(text).toContain(
      'kticket_http_errors_total{method="GET",route="unmatched",status_class="4xx"} 1',
    );
    expect(text).not.toContain("nope-secret-456");

    await app.close();
  });

  it("does not expose /metrics on the public application", async () => {
    const app = await buildApp(testConfig());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("serves Prometheus text on the dedicated listener and 404s elsewhere", async () => {
    metrics.setBuildInfo("test-version", "testnet10");
    const server = await startMetricsServer({ port: 0, registry: metrics.registry });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const body = await res.text();
      expect(body).toContain('kticket_build_info{version="test-version",network="testnet10"} 1');

      const missing = await fetch(`http://127.0.0.1:${server.port}/health`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("records upstream retries and the final success", async () => {
    let calls = 0;
    const client = new KaspaClient("http://kaspa.test", {
      fetch: async () => {
        calls += 1;
        return calls < 3 ? new Response("", { status: 503 }) : jsonResponse([]);
      },
      sleep: async () => {},
      maxAttempts: 3,
    });

    await client.getUtxos("kaspa:qqexample");

    const text = await metrics.render();
    expect(text).toContain('kticket_upstream_requests_total{operation="utxos",outcome="retry"} 2');
    expect(text).toContain(
      'kticket_upstream_requests_total{operation="utxos",outcome="success"} 1',
    );
  });

  it("records a warm-up success and its last-success timestamp", async () => {
    const ctx = {
      kaspa: {},
      events: new EventStore(),
      verified: new VerifiedEventCache(),
      network: "testnet10",
    } as unknown as AppContext;

    await warmVerifiedEvents(ctx);

    const text = await metrics.render();
    expect(text).toContain('kticket_warmup_runs_total{result="success"} 1');
    expect(text).toMatch(/kticket_warmup_last_success_timestamp_seconds \d/);
  });
});
