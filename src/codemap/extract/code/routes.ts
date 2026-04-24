import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RouteInfo, ScanResult } from "../../../types.js";
import { makeHashedCodemapId } from "../../model/ids.js";
import type { Claim, EvidenceSpan, SourceSnapshot } from "../../model/types.js";
import { createSourceSnapshot } from "../../snapshot/snapshotter.js";
import { createSourcePathMatcher, type SourcePathFilterOptions } from "./source-path-filter.js";

export interface RouteClaimGraph {
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
  if (path.endsWith(".java")) return "java";
  if (path.endsWith(".kt")) return "kotlin";
  if (path.endsWith(".swift")) return "swift";
  if (path.endsWith(".cs")) return "csharp";
  if (path.endsWith(".brs") || path.endsWith(".bs")) return "brightscript";
  return undefined;
}

function normalizeRouteFile(path: string): string {
  return path.replace(/\\/g, "/");
}

function hashExcerpt(excerpt: string): string {
  return createHash("sha256").update(excerpt).digest("hex");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function toRouteClaimText(route: RouteInfo): string {
  return `Route ${route.method} ${route.path} is defined in ${route.file}.`;
}

function toClaimTags(route: RouteInfo, evidenceLabels: string[]): string[] {
  const tags = [
    ...route.tags,
    `framework:${route.framework}`,
    `method:${route.method.toLowerCase()}`,
  ];
  if (route.confidence === "regex" || evidenceLabels.includes("inferred")) {
    tags.push("inferred");
  }
  return unique(tags).sort();
}

function buildPathCandidates(path: string): string[] {
  const normalized = path.replace(/\/+/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const candidates = [normalized];

  for (let index = 1; index < segments.length; index++) {
    candidates.push(`/${segments.slice(index).join("/")}`);
  }

  return unique(candidates.filter((candidate) => candidate.length > 1));
}

function locateRouteEvidence(route: RouteInfo, content: string): LocatedEvidence {
  const lines = content.split(/\r?\n/);
  const candidates = buildPathCandidates(route.path);
  const lowerMethod = route.method.toLowerCase();

  for (const [index, line] of lines.entries()) {
    const lowered = line.toLowerCase();

    for (const candidate of candidates) {
      if (!line.includes(candidate)) {
        continue;
      }

      const labels: string[] = [];
      if (candidate !== route.path || route.confidence === "regex") {
        labels.push("inferred");
      }
      if (!lowered.includes(lowerMethod) && route.method !== "ALL") {
        labels.push("heuristic");
      }

      return {
        startLine: index + 1,
        endLine: index + 1,
        excerpt: line.trim(),
        labels: unique(labels),
      };
    }
  }

  const fallbackLines = lines.slice(0, Math.min(lines.length, 3));
  return {
    startLine: 1,
    endLine: Math.max(fallbackLines.length, 1),
    excerpt: fallbackLines.join("\n"),
    labels: unique(["inferred", "file-level"]),
  };
}

export async function extractRouteClaimGraph(
  result: Pick<ScanResult, "project" | "routes">,
  options: SourcePathFilterOptions = {},
): Promise<RouteClaimGraph> {
  const matchesSourcePath = createSourcePathMatcher(options.sourcePaths);
  const routes = result.routes.filter((route) => matchesSourcePath(route.file));
  const routeFiles = unique(routes.map((route) => route.file).filter(Boolean)).sort();
  const snapshotsByFile = new Map<string, SourceSnapshot>();
  const fileContentByRouteFile = new Map<string, string>();

  for (const routeFile of routeFiles) {
    const absolutePath = join(result.project.root, routeFile);
    const content = await readFile(absolutePath, "utf-8");
    fileContentByRouteFile.set(routeFile, content);

    const snapshot = await createSourceSnapshot({
      repoRoot: result.project.root,
      absolutePath,
      sourceKind: "code",
      content,
      language: inferLanguageFromPath(routeFile),
    });
    snapshotsByFile.set(routeFile, snapshot);
  }

  const evidence: EvidenceSpan[] = [];
  const claims: Claim[] = [];

  for (const route of routes) {
    const normalizedRouteFile = normalizeRouteFile(route.file);
    const snapshot = snapshotsByFile.get(route.file);
    const content = fileContentByRouteFile.get(route.file);
    if (!snapshot || content === undefined) {
      continue;
    }

    const located = locateRouteEvidence(route, content);
    const excerptHash = hashExcerpt(located.excerpt);
    const evidenceId = makeHashedCodemapId("evidence", [
      snapshot.id,
      String(located.startLine),
      String(located.endLine),
      excerptHash,
    ]);

    const evidenceEntry: EvidenceSpan = {
      id: evidenceId,
      snapshotId: snapshot.id,
      sourcePath: snapshot.sourcePath,
      startLine: located.startLine,
      endLine: located.endLine,
      excerptHash,
      detectorMethod: route.confidence === "regex" ? "regex" : "ast",
      confidence: route.confidence === "regex" ? 0.72 : 0.96,
      labels: unique(located.labels).sort(),
    };
    evidence.push(evidenceEntry);

    const claimTags = toClaimTags(route, evidenceEntry.labels);
    const isInferred = claimTags.includes("inferred");
    const claim: Claim = {
      id: makeHashedCodemapId("claim", [route.method, route.path, snapshot.sourcePath]),
      type: "route",
      subject: `${route.method} ${route.path}`,
      text: `Route ${route.method} ${route.path} is defined in ${normalizedRouteFile}.`,
      sourceSnapshotIds: [snapshot.id],
      evidenceSpanIds: [evidenceId],
      status: "candidate",
      supportScore: isInferred ? 0.72 : 0.96,
      publicationConfidence: isInferred ? 0.72 : 0.96,
      firstSeenAt: snapshot.createdAt,
      tags: claimTags,
    };
    claims.push(claim);
  }

  return {
    snapshots: [...snapshotsByFile.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    evidence: evidence.sort((a, b) => a.id.localeCompare(b.id)),
    claims: claims.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
