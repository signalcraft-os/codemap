import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EnvVar, ScanResult } from "../../../types.js";
import { makeHashedCodemapId } from "../../model/ids.js";
import type { Claim, EvidenceSpan, SourceSnapshot } from "../../model/types.js";
import { createSourceSnapshot, normalizeSourcePath } from "../../snapshot/snapshotter.js";
import { createSourcePathMatcher, type SourcePathFilterOptions } from "./source-path-filter.js";

export interface EnvClaimGraph {
  snapshots: SourceSnapshot[];
  evidence: EvidenceSpan[];
  claims: Claim[];
}

interface LocatedEvidence {
  startLine: number;
  endLine: number;
  excerpt: string;
  labels: string[];
}

function inferLanguageFromPath(path: string): string | undefined {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".toml")) return "toml";
  if (path.endsWith(".brs") || path.endsWith(".bs")) return "brightscript";
  return undefined;
}

function sourceKindFromPath(path: string): SourceSnapshot["sourceKind"] {
  const normalized = normalizeSourcePath(path);
  const name = basename(normalized).toLowerCase();
  if (
    name.startsWith(".env")
    || name === "manifest"
    || /appconfig\.brs$/i.test(normalized)
    || normalized.endsWith(".json")
    || normalized.endsWith(".yaml")
    || normalized.endsWith(".yml")
    || normalized.endsWith(".toml")
  ) {
    return "config";
  }
  return "code";
}

function envSourceRole(path: string): "declaration" | "usage" {
  const normalized = normalizeSourcePath(path);
  const name = basename(normalized).toLowerCase();
  if (name.startsWith(".env") || name === "manifest" || /appconfig\.brs$/i.test(normalized)) {
    return "declaration";
  }
  return "usage";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function hashExcerpt(excerpt: string): string {
  return createHash("sha256").update(excerpt).digest("hex");
}

function locateEnvEvidence(envVar: EnvVar, content: string): LocatedEvidence {
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (line.includes(envVar.name)) {
      return {
        startLine: index + 1,
        endLine: index + 1,
        excerpt: line.trim(),
        labels: [],
      };
    }
  }

  const fallbackLines = lines.slice(0, Math.min(lines.length, 4));
  return {
    startLine: 1,
    endLine: Math.max(fallbackLines.length, 1),
    excerpt: fallbackLines.join("\n"),
    labels: ["file-level", "heuristic"],
  };
}

function buildEnvClaim(
  envVar: EnvVar,
  snapshot: SourceSnapshot,
  evidenceId: string,
): Claim {
  const sourceRole = envSourceRole(snapshot.sourcePath);
  const requirementText = envVar.hasDefault
    ? "has a detected default value"
    : "must be provided externally";
  const sourceText = sourceRole === "declaration" ? "declared in" : "referenced from";
  const tags = [
    "env",
    "kind:env-var",
    envVar.hasDefault ? "has-default" : "required",
    `env-source:${sourceRole}`,
    `source-kind:${snapshot.sourceKind}`,
  ];

  return {
    id: makeHashedCodemapId("claim", ["env_var", envVar.name, snapshot.sourcePath]),
    type: "env_var",
    subject: envVar.name,
    text: `Environment variable ${envVar.name} is ${sourceText} ${snapshot.sourcePath} and ${requirementText}.`,
    sourceSnapshotIds: [snapshot.id],
    evidenceSpanIds: [evidenceId],
    status: "candidate",
    supportScore: sourceRole === "declaration" ? 0.93 : 0.88,
    publicationConfidence: sourceRole === "declaration" ? 0.93 : 0.88,
    firstSeenAt: snapshot.createdAt,
    tags: unique(tags).sort(),
  };
}

export async function extractEnvClaimGraph(
  result: Pick<ScanResult, "project"> & Partial<Pick<ScanResult, "config">>,
  options: SourcePathFilterOptions = {},
): Promise<EnvClaimGraph> {
  const matchesSourcePath = createSourcePathMatcher(options.sourcePaths);
  const envVars = (result.config?.envVars ?? []).map((envVar) => ({
    ...envVar,
    source: normalizeSourcePath(envVar.source),
  }))
    .filter((envVar) => envVar.source.length > 0)
    .filter((envVar) => matchesSourcePath(envVar.source));
  const envSources = unique(envVars.map((envVar) => envVar.source).filter(Boolean)).sort();
  const snapshotsByFile = new Map<string, SourceSnapshot>();
  const fileContentByFile = new Map<string, string>();

  for (const envSource of envSources) {
    const absolutePath = join(result.project.root, envSource);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    fileContentByFile.set(envSource, content);
    const snapshot = await createSourceSnapshot({
      repoRoot: result.project.root,
      absolutePath,
      sourceKind: sourceKindFromPath(envSource),
      content,
      language: inferLanguageFromPath(envSource),
    });
    snapshotsByFile.set(envSource, snapshot);
  }

  const evidence: EvidenceSpan[] = [];
  const claims: Claim[] = [];

  for (const envVar of envVars) {
    const snapshot = snapshotsByFile.get(envVar.source);
    const content = fileContentByFile.get(envVar.source);
    if (!snapshot || content === undefined) {
      continue;
    }

    const located = locateEnvEvidence(envVar, content);
    const excerptHash = hashExcerpt(located.excerpt);
    const evidenceEntry: EvidenceSpan = {
      id: makeHashedCodemapId("evidence", [
        snapshot.id,
        String(located.startLine),
        String(located.endLine),
        excerptHash,
      ]),
      snapshotId: snapshot.id,
      sourcePath: snapshot.sourcePath,
      startLine: located.startLine,
      endLine: located.endLine,
      excerptHash,
      detectorMethod: "heuristic",
      confidence: envSourceRole(snapshot.sourcePath) === "declaration" ? 0.93 : 0.88,
      labels: unique(located.labels).sort(),
    };
    evidence.push(evidenceEntry);
    claims.push(buildEnvClaim(envVar, snapshot, evidenceEntry.id));
  }

  return {
    snapshots: [...snapshotsByFile.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    evidence: uniqueById(evidence).sort((left, right) => left.id.localeCompare(right.id)),
    claims: uniqueById(claims).sort((left, right) => left.id.localeCompare(right.id)),
  };
}
