import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExportItem, LibExport, ScanResult } from "../../../types.js";
import { makeHashedCodemapId } from "../../model/ids.js";
import type { Claim, EvidenceSpan, SourceSnapshot } from "../../model/types.js";
import { createSourceSnapshot, normalizeSourcePath } from "../../snapshot/snapshotter.js";
import { createSourcePathMatcher, type SourcePathFilterOptions } from "./source-path-filter.js";

export interface LibraryClaimGraph {
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
  if (path.endsWith(".dart")) return "dart";
  if (path.endsWith(".swift")) return "swift";
  if (path.endsWith(".cs")) return "csharp";
  if (path.endsWith(".php")) return "php";
  if (path.endsWith(".brs") || path.endsWith(".bs")) return "brightscript";
  return undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function hashExcerpt(excerpt: string): string {
  return createHash("sha256").update(excerpt).digest("hex");
}

function libraryGroupKey(file: string): string {
  const parts = file.replace(/\\/g, "/").split("/");
  const generic = new Set(["src", "lib", "source", "packages", "apps", "modules", "core", "internal"]);
  if (parts.length >= 2 && generic.has(parts[0])) {
    return parts[1];
  }
  return parts[0];
}

function findExportLine(line: string, exportName: string): boolean {
  return line.includes(` ${exportName}`) ||
    line.includes(`${exportName}(`) ||
    line.includes(`${exportName}:`) ||
    line.includes(`${exportName} =`) ||
    line.includes(`${exportName}<`) ||
    line.includes(`${exportName} {`);
}

function locateLibraryEvidence(library: LibExport, content: string): LocatedEvidence {
  const lines = content.split(/\r?\n/);

  for (const exportItem of library.exports) {
    for (const [index, line] of lines.entries()) {
      if (findExportLine(line, exportItem.name)) {
        return {
          startLine: index + 1,
          endLine: index + 1,
          excerpt: line.trim(),
          labels: [],
        };
      }
    }
  }

  const fallbackLines = lines.slice(0, Math.min(lines.length, 4));
  return {
    startLine: 1,
    endLine: Math.max(fallbackLines.length, 1),
    excerpt: fallbackLines.join("\n"),
    labels: ["file-level"],
  };
}

function createEvidenceEntry(
  snapshot: SourceSnapshot,
  located: LocatedEvidence,
): EvidenceSpan {
  const excerptHash = hashExcerpt(located.excerpt);
  return {
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
    confidence: 0.9,
    labels: unique(located.labels).sort(),
  };
}

function formatExportSummary(exports: ExportItem[]): string {
  const names = exports.map((entry) => entry.name);
  return names.slice(0, 6).join(", ") + (names.length > 6 ? ", …" : "");
}

function buildLibraryClaim(
  library: LibExport,
  snapshot: SourceSnapshot,
  evidenceId: string,
): Claim {
  const exportCount = library.exports.length;
  const group = libraryGroupKey(snapshot.sourcePath);
  const tags = [
    "library",
    "kind:library-module",
    `library-group:${group}`,
    `language:${inferLanguageFromPath(snapshot.sourcePath) ?? "unknown"}`,
    `export-count:${exportCount}`,
    ...library.exports.map((entry) => `export:${entry.kind}:${entry.name}`),
  ];

  return {
    id: makeHashedCodemapId("claim", ["library_module", snapshot.sourcePath]),
    type: "library_module",
    subject: snapshot.sourcePath,
    text: `Library module ${snapshot.sourcePath} exports ${exportCount} reusable symbols: ${formatExportSummary(library.exports)}.`,
    sourceSnapshotIds: [snapshot.id],
    evidenceSpanIds: [evidenceId],
    status: "candidate",
    supportScore: 0.9,
    publicationConfidence: 0.9,
    firstSeenAt: snapshot.createdAt,
    tags: unique(tags).sort(),
  };
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

export async function extractLibraryClaimGraph(
  result: Pick<ScanResult, "project" | "libs">,
  options: SourcePathFilterOptions = {},
): Promise<LibraryClaimGraph> {
  const matchesSourcePath = createSourcePathMatcher(options.sourcePaths);
  const libraries = (result.libs ?? []).map((library) => ({
    ...library,
    file: normalizeSourcePath(library.file),
    exports: uniqueById(
      library.exports.map((entry) => ({
        ...entry,
        id: `${entry.kind}:${entry.name}`,
      })),
    ).map(({ id: _id, ...entry }) => entry).sort((left, right) => left.name.localeCompare(right.name)),
  })).filter((library) => matchesSourcePath(library.file));

  const libraryFiles = unique(libraries.map((library) => library.file)).sort();
  const snapshotsByFile = new Map<string, SourceSnapshot>();
  const fileContentByFile = new Map<string, string>();

  for (const libraryFile of libraryFiles) {
    const absolutePath = join(result.project.root, libraryFile);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    fileContentByFile.set(libraryFile, content);
    const snapshot = await createSourceSnapshot({
      repoRoot: result.project.root,
      absolutePath,
      sourceKind: "code",
      content,
      language: inferLanguageFromPath(libraryFile),
    });
    snapshotsByFile.set(libraryFile, snapshot);
  }

  const evidence: EvidenceSpan[] = [];
  const claims: Claim[] = [];

  for (const library of libraries) {
    const snapshot = snapshotsByFile.get(library.file);
    const content = fileContentByFile.get(library.file);
    if (!snapshot || content === undefined) {
      continue;
    }

    const located = locateLibraryEvidence(library, content);
    const evidenceEntry = createEvidenceEntry(snapshot, located);
    evidence.push(evidenceEntry);
    claims.push(buildLibraryClaim(library, snapshot, evidenceEntry.id));
  }

  return {
    snapshots: [...snapshotsByFile.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    evidence: uniqueById(evidence).sort((left, right) => left.id.localeCompare(right.id)),
    claims: uniqueById(claims).sort((left, right) => left.id.localeCompare(right.id)),
  };
}
