// Validates the committed delivery artifacts before CI publishes anything.
// It complements kubeconform (schema) with the semantic contract this
// application depends on: immutable image reference, single replica, hardened
// pod, ClusterIP services, a scrapable metrics endpoint, and dashboard queries
// that reference metrics the API actually emits.
//
// usage: node scripts/validate-deploy.mjs

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deployDir = join(root, "deploy");

const errors = [];
const check = (condition, message) => {
  if (!condition) errors.push(message);
};

const manifests = readdirSync(deployDir)
  .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
  .map((file) => ({ file, doc: parse(readFileSync(join(deployDir, file), "utf8")) }));

const find = (kind, name) =>
  manifests.find((entry) => entry.doc?.kind === kind && entry.doc?.metadata?.name === name)?.doc;

// --- Deployment ------------------------------------------------------------
const deployment = find("Deployment", "kticket");
check(deployment !== undefined, "Deployment/kticket is missing");
if (deployment) {
  const podSpec = deployment.spec?.template?.spec ?? {};
  check(
    deployment.spec?.replicas === 1,
    "deployment must run exactly 1 replica (wallet nonces and index mirrors are process-local)",
  );

  const app = (podSpec.containers ?? []).find((container) => container.name === "app");
  check(app !== undefined, "deployment has no container named app");

  if (app) {
    const image = app.image ?? "";
    check(
      /^ghcr\.io\/[^:\s]+\/kticket:sha-[0-9a-f]{40}@sha256:[0-9a-f]{64}$/.test(image),
      `deployment image must be tag@digest (got ${image || "<empty>"})`,
    );

    const ports = Object.fromEntries((app.ports ?? []).map((port) => [port.name, port.containerPort]));
    check(ports.http === 3000, "app container must expose a named http port on 3000");
    check(ports.metrics === 9090, "app container must expose a named metrics port on 9090");

    const containerSecurity = app.securityContext ?? {};
    check(containerSecurity.readOnlyRootFilesystem === true, "readOnlyRootFilesystem must be true");
    check(
      containerSecurity.allowPrivilegeEscalation === false,
      "allowPrivilegeEscalation must be false",
    );
    check(
      (containerSecurity.capabilities?.drop ?? []).includes("ALL"),
      "container must drop ALL capabilities",
    );

    check(podSpec.automountServiceAccountToken === false, "automountServiceAccountToken must be false");

    const volumes = podSpec.volumes ?? [];
    check(volumes.some((volume) => volume.name === "tmp" && volume.emptyDir), "a writable /tmp emptyDir is required");
    check(
      (app.volumeMounts ?? []).some((mount) => mount.mountPath === "/tmp"),
      "the /tmp emptyDir must be mounted into the container",
    );

    for (const probe of ["startupProbe", "readinessProbe", "livenessProbe"]) {
      check(app[probe]?.httpGet?.path === "/health", `${probe} must GET /health`);
    }

    check(Boolean(app.resources?.requests?.cpu), "cpu request is required");
    check(Boolean(app.resources?.limits?.cpu), "cpu limit is required");
    check(Boolean(app.resources?.requests?.memory), "memory request is required");
    check(Boolean(app.resources?.limits?.memory), "memory limit is required");
  }

  const podSecurity = podSpec.securityContext ?? {};
  check(podSecurity.runAsNonRoot === true, "pod runAsNonRoot must be true");
  check(podSecurity.seccompProfile?.type === "RuntimeDefault", "pod seccompProfile must be RuntimeDefault");
  check(
    (podSpec.terminationGracePeriodSeconds ?? 0) >= 120,
    "terminationGracePeriodSeconds must be >= 120s to drain in-flight finalizes",
  );
}

// --- Services --------------------------------------------------------------
const publicService = find("Service", "kticket");
check(publicService?.spec?.type === "ClusterIP", "public Service must be ClusterIP");
const publicPorts = (publicService?.spec?.ports ?? []).map((port) => port.port);
check(publicPorts.includes(3000), "public Service must expose port 3000");
check(!publicPorts.includes(9090), "public Service must not expose the metrics port");

const metricsService = find("Service", "kticket-metrics");
check(metricsService?.spec?.type === "ClusterIP", "metrics Service must be ClusterIP");
const metricsPorts = metricsService?.spec?.ports ?? [];
check(
  metricsPorts.length === 1 && metricsPorts[0].name === "metrics" && metricsPorts[0].port === 9090,
  "metrics Service must expose exactly one named metrics port on 9090",
);

// --- VMServiceScrape -------------------------------------------------------
const scrape = find("VMServiceScrape", "kticket");
check(scrape !== undefined, "VMServiceScrape/kticket is missing");
if (scrape) {
  const selector = scrape.spec?.selector?.matchLabels ?? {};
  const metricsLabels = metricsService?.metadata?.labels ?? {};
  for (const [key, value] of Object.entries(selector)) {
    check(metricsLabels[key] === value, `VMServiceScrape selector ${key}=${value} does not match the metrics Service`);
  }
  check(
    (scrape.spec?.endpoints ?? []).some((endpoint) => endpoint.port === "metrics" && endpoint.path === "/metrics"),
    "VMServiceScrape must scrape the named metrics port at /metrics",
  );
  check(scrape.spec?.jobLabel === "app.kubernetes.io/name", "VMServiceScrape jobLabel should be app.kubernetes.io/name");

  const publicLabels = publicService?.metadata?.labels ?? {};
  const publicMatches = Object.entries(selector).every(([key, value]) => publicLabels[key] === value);
  check(!publicMatches, "VMServiceScrape selector must not also match the public Service");
}

// --- Grafana dashboard -----------------------------------------------------
const dashboard = find("ConfigMap", "kticket-dashboard");
check(dashboard?.metadata?.namespace === "observability", "dashboard ConfigMap must live in the observability namespace");
check(dashboard?.metadata?.labels?.grafana_dashboard === "1", "dashboard ConfigMap must carry grafana_dashboard=1");

const dashboardJson = Object.values(dashboard?.data ?? {}).find(
  (value) => typeof value === "string" && value.trim().startsWith("{"),
);
check(typeof dashboardJson === "string", "dashboard ConfigMap must contain a JSON document");

if (typeof dashboardJson === "string") {
  let json;
  try {
    json = JSON.parse(dashboardJson);
  } catch (err) {
    check(false, `dashboard JSON does not parse: ${err.message}`);
  }
  if (json) {
    const metricsSource = readFileSync(join(root, "packages/api/src/metrics.ts"), "utf8");
    const known = new Set(
      [...metricsSource.matchAll(/name:\s*"(kticket_[a-z0-9_]+)"/g)].map((match) => match[1]),
    );
    const expressions = [];
    for (const panel of json.panels ?? []) {
      for (const target of panel.targets ?? []) {
        if (typeof target.expr === "string") expressions.push(target.expr);
      }
    }
    check(expressions.length > 0, "dashboard has no queries");
    const referenced = new Set(
      expressions.flatMap((expr) => [...expr.matchAll(/\bkticket_[a-z0-9_]+/g)].map((m) => m[0])),
    );
    for (const metric of referenced) {
      const base = metric.replace(/_(bucket|sum|count)$/, "");
      check(known.has(metric) || known.has(base), `dashboard references unknown metric ${metric}`);
    }
  }
}

if (errors.length > 0) {
  console.error("deploy validation failed:");
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}

console.log(`deploy validation passed (${manifests.length} manifests checked).`);
