import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodeCodemapPublishResult } from "../publish/code-pipeline.js";
import type { KnowledgeCodemapPublishResult } from "../publish/knowledge-pipeline.js";
import type { CodemapTrigger } from "../runtime/index.js";

export const TELEMETRY_ENV_VAR = "CODEMAP_TELEMETRY_URL";
export const TELEMETRY_TIMEOUT_MS = 3000;
export const TELEMETRY_SCHEMA_VERSION = 1;

export type TelemetryDomain = "code" | "knowledge";

export interface TelemetryIncidentSummary {
  total: number;
  high: number;
  medium: number;
  low: number;
}

export interface TelemetryCounts {
  claims: number;
  snapshots: number;
  evidence: number;
  verificationRecords: number;
  conflicts: number;
}

export interface TelemetryEvent {
  type: "codemap_publish";
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  timestamp: string;
  cliVersion: string;
  projectHash: string;
  domain: TelemetryDomain;
  trigger: CodemapTrigger;
  counts: TelemetryCounts;
  incidents: TelemetryIncidentSummary;
  decisionsRecordedTotal: number;
}

// Stable, opaque identifier per (machine, project) pair. Not reversible without
// knowing the project's absolute path on the user's machine. Sent to the
// telemetry endpoint so events can be grouped per project across runs.
export function computeProjectHash(repoRoot: string): string {
  return createHash("sha256")
    .update(`${hostname()}:${repoRoot}`)
    .digest("hex")
    .slice(0, 12);
}

function summarizeIncidents(
  incidents: ReadonlyArray<{ severity: string }>,
): TelemetryIncidentSummary {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const incident of incidents) {
    if (incident.severity === "high") high++;
    else if (incident.severity === "medium") medium++;
    else if (incident.severity === "low") low++;
  }
  return { total: incidents.length, high, medium, low };
}

export interface BuildTelemetryEventOptions {
  repoRoot: string;
  cliVersion: string;
  trigger: CodemapTrigger;
  decisionsRecordedTotal: number;
}

export function buildCodeTelemetryEvent(
  result: CodeCodemapPublishResult,
  options: BuildTelemetryEventOptions,
): TelemetryEvent {
  return {
    type: "codemap_publish",
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    cliVersion: options.cliVersion,
    projectHash: computeProjectHash(options.repoRoot),
    domain: "code",
    trigger: options.trigger,
    counts: {
      claims: result.claims,
      snapshots: result.snapshots,
      evidence: result.evidence,
      verificationRecords: result.verificationRecords,
      conflicts: result.conflicts,
    },
    incidents: summarizeIncidents(result.incidents),
    decisionsRecordedTotal: options.decisionsRecordedTotal,
  };
}

export function buildKnowledgeTelemetryEvent(
  result: KnowledgeCodemapPublishResult,
  options: BuildTelemetryEventOptions,
): TelemetryEvent {
  return {
    type: "codemap_publish",
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    cliVersion: options.cliVersion,
    projectHash: computeProjectHash(options.repoRoot),
    domain: "knowledge",
    trigger: options.trigger,
    counts: {
      // Use the knowledge-only counts from the publish result. The general
      // claims/snapshots/evidence fields include code claims preserved
      // across runs, which would inflate the knowledge signal.
      claims: result.knowledgeClaims,
      snapshots: result.knowledgeSnapshots,
      evidence: result.knowledgeEvidence,
      verificationRecords: result.verificationRecords,
      conflicts: result.conflicts,
    },
    incidents: summarizeIncidents(result.incidents),
    decisionsRecordedTotal: options.decisionsRecordedTotal,
  };
}

export function formatSlackPayload(event: TelemetryEvent): { text: string } {
  const emoji =
    event.incidents.high > 0
      ? ":red_circle:"
      : event.incidents.medium > 0
        ? ":large_yellow_circle:"
        : ":bar_chart:";
  const incidentSummary =
    event.incidents.total === 0
      ? "0 incidents"
      : `${event.incidents.total} incidents (high=${event.incidents.high}, medium=${event.incidents.medium}, low=${event.incidents.low})`;
  const text = [
    `${emoji} codemap:\`${event.projectHash}\` [${event.domain}] (${event.trigger}) v${event.cliVersion}`,
    `claims: ${event.counts.claims} · snapshots: ${event.counts.snapshots} · conflicts: ${event.counts.conflicts}`,
    `${incidentSummary} · decisions recorded: ${event.decisionsRecordedTotal}`,
  ].join("\n");
  return { text };
}

export async function countRecordedDecisions(repoRoot: string): Promise<number> {
  const dir = join(repoRoot, ".codemap", "notes", "decisions", "recorded");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

export async function postTelemetry(event: TelemetryEvent): Promise<void> {
  const url = process.env[TELEMETRY_ENV_VAR];
  if (!url) return;
  const isSlack = /hooks\.slack\.com/.test(url);
  const body = isSlack ? formatSlackPayload(event) : event;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  CodeMap telemetry skipped: ${message}\n`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
