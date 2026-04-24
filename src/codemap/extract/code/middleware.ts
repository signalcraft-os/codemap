import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MiddlewareInfo, ScanResult } from "../../../types.js";
import { makeHashedCodemapId } from "../../model/ids.js";
import type { Claim, EvidenceSpan, SourceSnapshot } from "../../model/types.js";
import { createSourceSnapshot, normalizeSourcePath } from "../../snapshot/snapshotter.js";
import { createSourcePathMatcher, type SourcePathFilterOptions } from "./source-path-filter.js";

export interface MiddlewareClaimGraph {
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
  if (path.endsWith(".rb")) return "ruby";
  if (path.endsWith(".php")) return "php";
  if (path.endsWith(".brs") || path.endsWith(".bs")) return "brightscript";
  return undefined;
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

function locateMiddlewareEvidence(middleware: MiddlewareInfo, content: string): LocatedEvidence {
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (line.includes(middleware.name)) {
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

function buildMiddlewareClaim(
  middleware: MiddlewareInfo,
  snapshot: SourceSnapshot,
  evidenceId: string,
): Claim {
  const tags = [
    "middleware",
    "kind:middleware",
    `middleware-type:${middleware.type}`,
  ];

  return {
    id: makeHashedCodemapId("claim", ["middleware", middleware.name, snapshot.sourcePath]),
    type: "middleware",
    subject: middleware.name,
    text: `Middleware ${middleware.name} is detected in ${snapshot.sourcePath} and classified as ${middleware.type}.`,
    sourceSnapshotIds: [snapshot.id],
    evidenceSpanIds: [evidenceId],
    status: "candidate",
    supportScore: 0.87,
    publicationConfidence: 0.87,
    firstSeenAt: snapshot.createdAt,
    tags: unique(tags).sort(),
  };
}

export async function extractMiddlewareClaimGraph(
  result: Pick<ScanResult, "project" | "middleware">,
  options: SourcePathFilterOptions = {},
): Promise<MiddlewareClaimGraph> {
  const matchesSourcePath = createSourcePathMatcher(options.sourcePaths);
  const middlewareEntries = (result.middleware ?? []).map((middleware) => ({
    ...middleware,
    file: normalizeSourcePath(middleware.file),
  })).filter((middleware) => matchesSourcePath(middleware.file));
  const middlewareFiles = unique(middlewareEntries.map((middleware) => middleware.file).filter(Boolean)).sort();
  const snapshotsByFile = new Map<string, SourceSnapshot>();
  const fileContentByFile = new Map<string, string>();

  for (const middlewareFile of middlewareFiles) {
    const absolutePath = join(result.project.root, middlewareFile);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    fileContentByFile.set(middlewareFile, content);
    const snapshot = await createSourceSnapshot({
      repoRoot: result.project.root,
      absolutePath,
      sourceKind: "code",
      content,
      language: inferLanguageFromPath(middlewareFile),
    });
    snapshotsByFile.set(middlewareFile, snapshot);
  }

  const evidence: EvidenceSpan[] = [];
  const claims: Claim[] = [];

  for (const middleware of middlewareEntries) {
    const snapshot = snapshotsByFile.get(middleware.file);
    const content = fileContentByFile.get(middleware.file);
    if (!snapshot || content === undefined) {
      continue;
    }

    const located = locateMiddlewareEvidence(middleware, content);
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
      confidence: 0.87,
      labels: unique(located.labels).sort(),
    };
    evidence.push(evidenceEntry);
    claims.push(buildMiddlewareClaim(middleware, snapshot, evidenceEntry.id));
  }

  return {
    snapshots: [...snapshotsByFile.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    evidence: uniqueById(evidence).sort((left, right) => left.id.localeCompare(right.id)),
    claims: uniqueById(claims).sort((left, right) => left.id.localeCompare(right.id)),
  };
}
