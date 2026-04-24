import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScanResult } from "../../../types.js";
import { makeHashedCodemapId } from "../../model/ids.js";
import type { Claim, EvidenceSpan, SourceSnapshot } from "../../model/types.js";
import { createSourceSnapshot, normalizeSourcePath } from "../../snapshot/snapshotter.js";
import { createSourcePathMatcher, type SourcePathFilterOptions } from "./source-path-filter.js";

export interface HotspotClaimGraph {
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
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".brs") || path.endsWith(".bs")) return "brightscript";
  if (path.endsWith(".xml")) return "xml";
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

function locateHotspotEvidence(content: string): LocatedEvidence {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length > 0) {
      return {
        startLine: index + 1,
        endLine: index + 1,
        excerpt: line.trim(),
        labels: [],
      };
    }
  }

  return {
    startLine: 1,
    endLine: 1,
    excerpt: "",
    labels: ["file-level", "heuristic"],
  };
}

function hotspotBucket(importedBy: number): "critical" | "high" | "medium" {
  if (importedBy >= 10) {
    return "critical";
  }
  if (importedBy >= 5) {
    return "high";
  }
  return "medium";
}

export async function extractHotspotClaimGraph(
  result: Pick<ScanResult, "project"> & Partial<Pick<ScanResult, "graph">>,
  options: SourcePathFilterOptions = {},
): Promise<HotspotClaimGraph> {
  const matchesSourcePath = createSourcePathMatcher(options.sourcePaths);
  const hotFiles = [...(result.graph?.hotFiles ?? [])]
    .map((entry) => ({
      ...entry,
      file: normalizeSourcePath(entry.file),
    }))
    .filter((entry) => entry.file.length > 0 && entry.importedBy > 0)
    .filter((entry) => matchesSourcePath(entry.file))
    .sort((left, right) => right.importedBy - left.importedBy || left.file.localeCompare(right.file));

  const snapshotsByFile = new Map<string, SourceSnapshot>();
  const fileContentByFile = new Map<string, string>();

  for (const hotFile of hotFiles) {
    const absolutePath = join(result.project.root, hotFile.file);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    fileContentByFile.set(hotFile.file, content);
    const snapshot = await createSourceSnapshot({
      repoRoot: result.project.root,
      absolutePath,
      sourceKind: "code",
      content,
      language: inferLanguageFromPath(hotFile.file),
    });
    snapshotsByFile.set(hotFile.file, snapshot);
  }

  const evidence: EvidenceSpan[] = [];
  const claims: Claim[] = [];

  for (const [index, hotFile] of hotFiles.entries()) {
    const snapshot = snapshotsByFile.get(hotFile.file);
    const content = fileContentByFile.get(hotFile.file);
    if (!snapshot || content === undefined) {
      continue;
    }

    const located = locateHotspotEvidence(content);
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
      detectorMethod: "imported",
      confidence: Math.min(0.82 + Math.min(hotFile.importedBy, 8) * 0.02, 0.98),
      labels: unique(located.labels).sort(),
    };
    evidence.push(evidenceEntry);

    claims.push({
      id: makeHashedCodemapId("claim", ["dependency_hotspot", snapshot.sourcePath]),
      type: "dependency_hotspot",
      subject: snapshot.sourcePath,
      text: `File ${snapshot.sourcePath} is imported by ${hotFile.importedBy} files and has elevated blast radius.`,
      sourceSnapshotIds: [snapshot.id],
      evidenceSpanIds: [evidenceEntry.id],
      status: "candidate",
      supportScore: Math.min(0.82 + Math.min(hotFile.importedBy, 8) * 0.02, 0.98),
      publicationConfidence: Math.min(0.82 + Math.min(hotFile.importedBy, 8) * 0.02, 0.98),
      firstSeenAt: snapshot.createdAt,
      tags: unique([
        "hotspot",
        "kind:dependency-hotspot",
        `imported-by-count:${hotFile.importedBy}`,
        `hotspot-rank:${index + 1}`,
        `hotspot-bucket:${hotspotBucket(hotFile.importedBy)}`,
      ]).sort(),
    });
  }

  return {
    snapshots: [...snapshotsByFile.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    evidence: uniqueById(evidence).sort((left, right) => left.id.localeCompare(right.id)),
    claims: uniqueById(claims).sort((left, right) => left.id.localeCompare(right.id)),
  };
}
