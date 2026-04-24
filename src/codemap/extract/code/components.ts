import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComponentInfo, ScanResult } from "../../../types.js";
import { makeHashedCodemapId } from "../../model/ids.js";
import type { Claim, EvidenceSpan, SourceSnapshot } from "../../model/types.js";
import { createSourceSnapshot, normalizeSourcePath } from "../../snapshot/snapshotter.js";
import { createSourcePathMatcher, type SourcePathFilterOptions } from "./source-path-filter.js";

export interface ComponentClaimGraph {
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
  if (path.endsWith(".vue")) return "vue";
  if (path.endsWith(".svelte")) return "svelte";
  if (path.endsWith(".dart")) return "dart";
  if (path.endsWith(".swift")) return "swift";
  if (path.endsWith(".kt")) return "kotlin";
  if (path.endsWith(".xml")) return "xml";
  return undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function hashExcerpt(excerpt: string): string {
  return createHash("sha256").update(excerpt).digest("hex");
}

function componentRole(component: ComponentInfo): "client" | "server" | "shared" {
  if (component.isServer) {
    return "server";
  }
  if (component.isClient) {
    return "client";
  }
  return "shared";
}

function locateComponentEvidence(component: ComponentInfo, content: string): LocatedEvidence {
  const lines = content.split(/\r?\n/);
  const patterns = [
    `function ${component.name}`,
    `const ${component.name}`,
    `class ${component.name}`,
    `export default function ${component.name}`,
    `export function ${component.name}`,
    `struct ${component.name}`,
    `data class ${component.name}`,
    `class ${component.name}: View`,
    `@Composable\nfun ${component.name}`,
    `<component name="${component.name}"`,
  ];

  for (const [index, line] of lines.entries()) {
    for (const pattern of patterns) {
      if (line.includes(pattern)) {
        return {
          startLine: index + 1,
          endLine: index + 1,
          excerpt: line.trim(),
          labels: component.confidence === "regex" ? ["inferred"] : [],
        };
      }
    }
  }

  for (const [index, line] of lines.entries()) {
    if (line.includes(component.name)) {
      return {
        startLine: index + 1,
        endLine: index + 1,
        excerpt: line.trim(),
        labels: unique([
          "heuristic",
          ...(component.confidence === "regex" ? ["inferred"] : []),
        ]),
      };
    }
  }

  const fallbackLines = lines.slice(0, Math.min(lines.length, 4));
  return {
    startLine: 1,
    endLine: Math.max(fallbackLines.length, 1),
    excerpt: fallbackLines.join("\n"),
    labels: unique([
      "file-level",
      "inferred",
      ...(component.confidence === "regex" ? ["regex"] : []),
    ]),
  };
}

function createEvidenceEntry(
  snapshot: SourceSnapshot,
  located: LocatedEvidence,
  detectorMethod: EvidenceSpan["detectorMethod"],
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
    detectorMethod,
    confidence: detectorMethod === "regex" ? 0.74 : 0.95,
    labels: unique(located.labels).sort(),
  };
}

function buildComponentClaim(
  component: ComponentInfo,
  snapshot: SourceSnapshot,
  evidenceId: string,
  componentFramework: string,
): Claim {
  const role = componentRole(component);
  const propCount = component.props.length;
  const propsText = propCount > 0
    ? ` with props ${component.props.join(", ")}`
    : " with no detected props";
  const tags = [
    "component",
    "kind:component",
    `component-framework:${componentFramework}`,
    `component-role:${role}`,
    `prop-count:${propCount}`,
    ...component.props.map((prop) => `prop:${prop}`),
  ];
  if (component.confidence === "regex") {
    tags.push("inferred");
  }
  const inferred = tags.includes("inferred");

  return {
    id: makeHashedCodemapId("claim", ["component", component.name, snapshot.sourcePath]),
    type: "component",
    subject: component.name,
    text: `Component ${component.name} is defined in ${snapshot.sourcePath} as a ${role} component${propsText}.`,
    sourceSnapshotIds: [snapshot.id],
    evidenceSpanIds: [evidenceId],
    status: "candidate",
    supportScore: inferred ? 0.74 : 0.95,
    publicationConfidence: inferred ? 0.74 : 0.95,
    firstSeenAt: snapshot.createdAt,
    tags: unique(tags).sort(),
  };
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

export async function extractComponentClaimGraph(
  result: Pick<ScanResult, "project" | "components">,
  options: SourcePathFilterOptions = {},
): Promise<ComponentClaimGraph> {
  const matchesSourcePath = createSourcePathMatcher(options.sourcePaths);
  const components = (result.components ?? []).map((component) => ({
    ...component,
    file: normalizeSourcePath(component.file),
    props: unique(component.props).sort(),
  })).filter((component) => matchesSourcePath(component.file));

  const componentFiles = unique(components.map((component) => component.file)).sort();
  const snapshotsByFile = new Map<string, SourceSnapshot>();
  const fileContentByFile = new Map<string, string>();

  for (const componentFile of componentFiles) {
    const absolutePath = join(result.project.root, componentFile);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    fileContentByFile.set(componentFile, content);
    const snapshot = await createSourceSnapshot({
      repoRoot: result.project.root,
      absolutePath,
      sourceKind: "code",
      content,
      language: inferLanguageFromPath(componentFile),
    });
    snapshotsByFile.set(componentFile, snapshot);
  }

  const evidence: EvidenceSpan[] = [];
  const claims: Claim[] = [];

  for (const component of components) {
    const snapshot = snapshotsByFile.get(component.file);
    const content = fileContentByFile.get(component.file);
    if (!snapshot || content === undefined) {
      continue;
    }

    const detectorMethod = component.confidence === "regex" ? "regex" : "ast";
    const located = locateComponentEvidence(component, content);
    const evidenceEntry = createEvidenceEntry(snapshot, located, detectorMethod);
    evidence.push(evidenceEntry);
    claims.push(buildComponentClaim(component, snapshot, evidenceEntry.id, result.project.componentFramework));
  }

  return {
    snapshots: [...snapshotsByFile.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    evidence: uniqueById(evidence).sort((left, right) => left.id.localeCompare(right.id)),
    claims: uniqueById(claims).sort((left, right) => left.id.localeCompare(right.id)),
  };
}
