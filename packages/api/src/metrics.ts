// Prometheus metrics for the API (KTK deployment readiness).
//
// The API exposes metrics on a dedicated internal port (`METRICS_PORT`, default
// 9090) that is never part of the public Service — only the metrics Service and
// the VictoriaMetrics `VMServiceScrape` reach it.
//
// Cardinality is bounded on purpose: label values are method names, route
// templates, status classes, upstream operation names and flow names. Raw URLs,
// wallet addresses, transaction ids, user ids and request ids are never used as
// labels — they vary per request and would explode the time series.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { createServer } from "node:http";

export type HttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
export type UpstreamOutcome = "success" | "error" | "retry";
export type WarmupResult = "success" | "partial" | "error";
export type FlowResult = "success" | "error";

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const UPSTREAM_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const FLOW_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

/** Prometheus status-class label for an HTTP status code (1xx–5xx, clamped). */
export function statusClassOf(statusCode: number): HttpStatusClass {
  switch (Math.floor(statusCode / 100)) {
    case 1:
      return "1xx";
    case 2:
      return "2xx";
    case 3:
      return "3xx";
    case 4:
      return "4xx";
    default:
      return "5xx";
  }
}

/** Seconds elapsed since a `process.hrtime()` start mark. */
export function elapsedSeconds(start: [number, number]): number {
  const seconds = process.hrtime(start);
  return seconds[0] + seconds[1] / 1e9;
}

/** The application metrics registry plus the typed recorders around it. */
export class Metrics {
  readonly registry: Registry;
  readonly #httpRequests: Counter<"method" | "route" | "status_class">;
  readonly #httpErrors: Counter<"method" | "route" | "status_class">;
  readonly #httpDuration: Histogram<"method" | "route">;
  readonly #upstreamRequests: Counter<"operation" | "outcome">;
  readonly #upstreamDuration: Histogram<"operation">;
  readonly #flows: Counter<"flow" | "result">;
  readonly #flowDuration: Histogram<"flow">;
  readonly #warmupRuns: Counter<"result">;
  readonly #warmupDuration: Histogram<string>;
  readonly #warmupLastSuccess: Gauge<string>;
  readonly #eventsRegistered: Counter<string>;
  readonly #buildInfo: Gauge<"version" | "network">;

  constructor(registry: Registry = new Registry()) {
    this.registry = registry;
    collectDefaultMetrics({ register: registry });

    const registers = [registry];

    this.#httpRequests = new Counter({
      name: "kticket_http_requests_total",
      help: "Total HTTP requests handled, by method, route template and status class.",
      labelNames: ["method", "route", "status_class"] as const,
      registers,
    });
    this.#httpErrors = new Counter({
      name: "kticket_http_errors_total",
      help: "Total HTTP responses with a 4xx/5xx status class.",
      labelNames: ["method", "route", "status_class"] as const,
      registers,
    });
    this.#httpDuration = new Histogram({
      name: "kticket_http_request_duration_seconds",
      help: "HTTP request duration in seconds, by method and route template.",
      labelNames: ["method", "route"] as const,
      buckets: HTTP_DURATION_BUCKETS,
      registers,
    });
    this.#upstreamRequests = new Counter({
      name: "kticket_upstream_requests_total",
      help: "Kaspa upstream operations, by operation and outcome (retry counts attempts).",
      labelNames: ["operation", "outcome"] as const,
      registers,
    });
    this.#upstreamDuration = new Histogram({
      name: "kticket_upstream_request_duration_seconds",
      help: "Kaspa upstream operation duration in seconds, by operation.",
      labelNames: ["operation"] as const,
      buckets: UPSTREAM_DURATION_BUCKETS,
      registers,
    });
    this.#flows = new Counter({
      name: "kticket_flows_total",
      help: "User transaction/discovery flows, by flow and result.",
      labelNames: ["flow", "result"] as const,
      registers,
    });
    this.#flowDuration = new Histogram({
      name: "kticket_flow_duration_seconds",
      help: "User flow duration in seconds, by flow.",
      labelNames: ["flow"] as const,
      buckets: FLOW_DURATION_BUCKETS,
      registers,
    });
    this.#warmupRuns = new Counter({
      name: "kticket_warmup_runs_total",
      help: "Background event warm-up runs, by result.",
      labelNames: ["result"] as const,
      registers,
    });
    this.#warmupDuration = new Histogram({
      name: "kticket_warmup_duration_seconds",
      help: "Background event warm-up duration in seconds.",
      buckets: FLOW_DURATION_BUCKETS,
      registers,
    });
    this.#warmupLastSuccess = new Gauge({
      name: "kticket_warmup_last_success_timestamp_seconds",
      help: "Unix timestamp of the last fully successful background warm-up.",
      registers,
    });
    this.#eventsRegistered = new Counter({
      name: "kticket_events_registered_total",
      help: "Events registered into the discovery registry.",
      registers,
    });
    this.#buildInfo = new Gauge({
      name: "kticket_build_info",
      help: "Build identity of the running API (always 1).",
      labelNames: ["version", "network"] as const,
      registers,
    });
  }

  observeHttp(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const status_class = statusClassOf(statusCode);
    this.#httpRequests.inc({ method, route, status_class });
    this.#httpDuration.observe({ method, route }, durationSeconds);
    if (statusCode >= 400) this.#httpErrors.inc({ method, route, status_class });
  }

  observeUpstream(operation: string, outcome: UpstreamOutcome, durationSeconds = 0): void {
    this.#upstreamRequests.inc({ operation, outcome });
    if (outcome !== "retry") this.#upstreamDuration.observe({ operation }, durationSeconds);
  }

  observeFlow(flow: string, result: FlowResult, durationSeconds: number): void {
    this.#flows.inc({ flow, result });
    this.#flowDuration.observe({ flow }, durationSeconds);
  }

  observeWarmup(result: WarmupResult, durationSeconds: number): void {
    this.#warmupRuns.inc({ result });
    this.#warmupDuration.observe(durationSeconds);
    if (result === "success") this.#warmupLastSuccess.set(Date.now() / 1000);
  }

  recordEventRegistered(): void {
    this.#eventsRegistered.inc();
  }

  setBuildInfo(version: string, network: string): void {
    this.#buildInfo.set({ version, network }, 1);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  /** Test hook: clear all samples while keeping the metric definitions. */
  reset(): void {
    this.registry.resetMetrics();
  }
}

/** The process-wide metrics instance shared by the wiring points. */
export const metrics = new Metrics();

const requestStarts = new WeakMap<FastifyRequest, [number, number]>();

/** The matched route template (never the raw URL) or `unmatched` for a 404. */
function routeTemplate(req: FastifyRequest): string {
  const url = req.routeOptions?.url;
  return url && url.length > 0 ? url : "unmatched";
}

/** The flow name a route opted into via `config.kticketFlow`, if any. */
function flowName(req: FastifyRequest): string | undefined {
  const config = req.routeOptions?.config as { kticketFlow?: unknown } | undefined;
  return typeof config?.kticketFlow === "string" ? config.kticketFlow : undefined;
}

/**
 * Attach the HTTP + flow recorders. HTTP metrics always record; flow metrics
 * record only for routes that declare `config.kticketFlow`, so prepares and
 * finalizes are measured without touching generic reads.
 */
export function registerHttpMetrics(app: FastifyInstance, m: Metrics = metrics): void {
  app.addHook("onRequest", async (req) => {
    requestStarts.set(req, process.hrtime());
  });

  app.addHook("onResponse", async (req, reply) => {
    const start = requestStarts.get(req);
    requestStarts.delete(req);
    const elapsed = start ? elapsedSeconds(start) : 0;
    const route = routeTemplate(req);
    m.observeHttp(req.method, route, reply.statusCode, elapsed);

    const flow = flowName(req);
    if (flow) m.observeFlow(flow, reply.statusCode < 400 ? "success" : "error", elapsed);
  });
}

export interface MetricsServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start the internal metrics listener. It answers `/metrics` only; everything
 * else is a 404. Binding on all interfaces is required so the in-cluster
 * VictoriaMetrics agent can scrape the pod.
 */
export function startMetricsServer(options: {
  port: number;
  host?: string;
  registry?: Registry;
}): Promise<MetricsServer> {
  const registry = options.registry ?? metrics.registry;
  const server = createServer((req, res) => {
    if (req.url === "/metrics" || req.url?.startsWith("/metrics?")) {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { "content-type": registry.contentType });
          res.end(body);
        })
        .catch((err: unknown) => {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(`metrics collection failed: ${String(err)}`);
        });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
