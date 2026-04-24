import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScanResult, SchemaModel } from "../../../types.js";
import { makeHashedCodemapId } from "../../model/ids.js";
import type { Claim, EvidenceSpan, SourceKind, SourceSnapshot } from "../../model/types.js";
import { createSourceSnapshot, normalizeSourcePath } from "../../snapshot/snapshotter.js";
import { createSourcePathMatcher, type SourcePathFilterOptions } from "./source-path-filter.js";

export interface SchemaClaimGraph {
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

interface RelationDescriptor {
  name: string;
  detail: string;
}

const RELATION_TARGET_STOP_WORDS = new Set([
  "all",
  "and",
  "array",
  "belongs_to",
  "belongs",
  "fk",
  "from",
  "has_many",
  "has_one",
  "many",
  "many_to_many",
  "nullable",
  "one",
  "optional",
  "through",
  "to",
]);

function inferLanguageFromPath(path: string): string | undefined {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".rb")) return "ruby";
  if (path.endsWith(".php")) return "php";
  if (path.endsWith(".java")) return "java";
  if (path.endsWith(".kt")) return "kotlin";
  if (path.endsWith(".cs")) return "csharp";
  if (path.endsWith(".sql")) return "sql";
  if (path.endsWith(".prisma")) return "prisma";
  if (path.endsWith(".xml")) return "xml";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".json")) return "json";
  return undefined;
}

function inferSourceKindFromPath(path: string): SourceKind {
  if (
    path.endsWith(".json") ||
    path.endsWith(".yaml") ||
    path.endsWith(".yml") ||
    path.endsWith(".toml")
  ) {
    return "config";
  }
  return "code";
}

function hashExcerpt(excerpt: string): string {
  return createHash("sha256").update(excerpt).digest("hex");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function modelNameCandidates(schema: SchemaModel): string[] {
  const names = [schema.name];
  if (schema.name.startsWith("enum:")) {
    names.push(schema.name.slice("enum:".length));
  }
  const tableMatch = schema.name.match(/\(([^)]+)\)\s*$/);
  if (tableMatch) {
    names.push(tableMatch[1]);
    names.push(schema.name.slice(0, tableMatch.index).trim());
  }
  return unique(names.map((name) => name.trim()).filter(Boolean));
}

function locateModelEvidence(schema: SchemaModel, content: string): LocatedEvidence {
  const lines = content.split(/\r?\n/);
  const candidates = modelNameCandidates(schema);
  const preferredPatterns = candidates.flatMap((candidate) => [
    `model ${candidate}`,
    `class ${candidate}`,
    `enum ${candidate}`,
    `type ${candidate} struct`,
    `object ${candidate}`,
    `"${candidate}"`,
    `'${candidate}'`,
    `(${candidate})`,
    `<component name="${candidate}"`,
  ]);

  for (const [index, line] of lines.entries()) {
    for (const pattern of preferredPatterns) {
      if (!pattern.trim()) {
        continue;
      }
      if (line.includes(pattern)) {
        return {
          startLine: index + 1,
          endLine: index + 1,
          excerpt: line.trim(),
          labels: schema.confidence === "regex" ? ["inferred"] : [],
        };
      }
    }
  }

  for (const [index, line] of lines.entries()) {
    for (const candidate of candidates) {
      if (line.includes(candidate)) {
        return {
          startLine: index + 1,
          endLine: index + 1,
          excerpt: line.trim(),
          labels: unique([
            "heuristic",
            ...(schema.confidence === "regex" ? ["inferred"] : []),
          ]),
        };
      }
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
      ...(schema.confidence === "regex" ? ["regex"] : []),
    ]),
  };
}

function parseRelationDescriptor(relation: string): RelationDescriptor {
  if (relation.includes(" -> ")) {
    const [name, detail] = relation.split(" -> ", 2);
    return { name: name.trim(), detail: detail.trim() };
  }
  if (relation.includes(":")) {
    const [name, detail] = relation.split(":", 2);
    return { name: name.trim(), detail: detail.trim() };
  }
  return { name: relation.trim(), detail: relation.trim() };
}

function extractRelationTargetModels(detail: string): string[] {
  const targets = new Set<string>();

  const pushTarget = (value: string) => {
    const trimmed = value.trim().replace(/\[\]$/, "");
    if (!trimmed) {
      return;
    }
    const base = trimmed.split(".")[0]?.trim() ?? trimmed;
    if (!base || base === "?" || RELATION_TARGET_STOP_WORDS.has(base.toLowerCase())) {
      return;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) {
      return;
    }
    targets.add(base);
  };

  for (const match of detail.matchAll(/\(([A-Za-z_][A-Za-z0-9_.]*)\)/g)) {
    pushTarget(match[1]);
  }

  const bareMatch = detail.match(/^([A-Za-z_][A-Za-z0-9_.\[\]]*)$/);
  if (bareMatch) {
    pushTarget(bareMatch[1]);
  }

  const arrowMatch = detail.match(/^([A-Za-z_][A-Za-z0-9_.]*)/);
  if (arrowMatch) {
    pushTarget(arrowMatch[1]);
  }

  return [...targets].sort();
}

function locateRelationEvidence(
  schema: SchemaModel,
  relation: string,
  content: string,
  modelEvidence: LocatedEvidence
): LocatedEvidence {
  const lines = content.split(/\r?\n/);
  const descriptor = parseRelationDescriptor(relation);
  const targetTokens = descriptor.detail
    .split(/[^A-Za-z0-9_]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  for (const [index, line] of lines.entries()) {
    if (!line.includes(descriptor.name)) {
      continue;
    }

    if (targetTokens.length === 0 || targetTokens.some((token) => line.includes(token))) {
      return {
        startLine: index + 1,
        endLine: index + 1,
        excerpt: line.trim(),
        labels: unique([
          ...(schema.confidence === "regex" ? ["inferred"] : []),
        ]),
      };
    }
  }

  return {
    ...modelEvidence,
    labels: unique([
      ...modelEvidence.labels,
      "model-level",
      "inferred",
    ]),
  };
}

function createEvidenceEntry(
  snapshot: SourceSnapshot,
  located: LocatedEvidence,
  detectorMethod: EvidenceSpan["detectorMethod"]
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
    confidence: detectorMethod === "regex" ? 0.72 : 0.95,
    labels: unique(located.labels).sort(),
  };
}

function buildModelClaim(schema: SchemaModel, snapshot: SourceSnapshot, evidenceId: string): Claim {
  const tags = [
    "schema",
    "kind:model",
    `model:${schema.name}`,
    `orm:${schema.orm}`,
    `field-count:${schema.fields.length}`,
    `relation-count:${schema.relations.length}`,
  ];
  if (schema.confidence === "regex") {
    tags.push("inferred");
  }
  const inferred = tags.includes("inferred");

  return {
    id: makeHashedCodemapId("claim", ["model", schema.name, snapshot.sourcePath]),
    type: "model",
    subject: schema.name,
    text: `Model ${schema.name} is defined in ${snapshot.sourcePath} with ${schema.fields.length} fields and ${schema.relations.length} relations.`,
    sourceSnapshotIds: [snapshot.id],
    evidenceSpanIds: [evidenceId],
    status: "candidate",
    supportScore: inferred ? 0.72 : 0.95,
    publicationConfidence: inferred ? 0.72 : 0.95,
    firstSeenAt: snapshot.createdAt,
    tags: unique(tags).sort(),
  };
}

function buildRelationClaim(
  schema: SchemaModel,
  relation: string,
  snapshot: SourceSnapshot,
  evidenceId: string
): Claim {
  const descriptor = parseRelationDescriptor(relation);
  const relationTargets = extractRelationTargetModels(descriptor.detail);
  const tags = [
    "schema",
    "kind:relation",
    `model:${schema.name}`,
    `relation:${descriptor.name}`,
    `orm:${schema.orm}`,
    ...relationTargets.map((target) => `relation-target:${target}`),
  ];
  if (schema.confidence === "regex") {
    tags.push("inferred");
  }
  const inferred = tags.includes("inferred");

  return {
    id: makeHashedCodemapId("claim", ["relation", schema.name, relation, snapshot.sourcePath]),
    type: "relation",
    subject: `${schema.name}.${descriptor.name}`,
    text: `Relation ${schema.name}.${descriptor.name} => ${descriptor.detail} is defined in ${snapshot.sourcePath}.`,
    sourceSnapshotIds: [snapshot.id],
    evidenceSpanIds: [evidenceId],
    status: "candidate",
    supportScore: inferred ? 0.72 : 0.94,
    publicationConfidence: inferred ? 0.72 : 0.94,
    firstSeenAt: snapshot.createdAt,
    tags: unique(tags).sort(),
  };
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

export async function extractSchemaClaimGraph(
  result: Pick<ScanResult, "project" | "schemas">,
  options: SourcePathFilterOptions = {},
): Promise<SchemaClaimGraph> {
  const matchesSourcePath = createSourcePathMatcher(options.sourcePaths);
  const schemaModels = (result.schemas ?? [])
    .filter((schema) => schema.file)
    .filter((schema) => schema.fields.length > 0 || schema.relations.length > 0)
    .map((schema) => ({
      ...schema,
      file: normalizeSourcePath(schema.file!),
    }))
    .filter((schema) => matchesSourcePath(schema.file));

  const schemaFiles = unique(schemaModels.map((schema) => schema.file!)).sort();
  const snapshotsByFile = new Map<string, SourceSnapshot>();
  const fileContentBySchemaFile = new Map<string, string>();

  for (const schemaFile of schemaFiles) {
    const absolutePath = join(result.project.root, schemaFile);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    fileContentBySchemaFile.set(schemaFile, content);

    const snapshot = await createSourceSnapshot({
      repoRoot: result.project.root,
      absolutePath,
      sourceKind: inferSourceKindFromPath(schemaFile),
      content,
      language: inferLanguageFromPath(schemaFile),
    });
    snapshotsByFile.set(schemaFile, snapshot);
  }

  const evidence: EvidenceSpan[] = [];
  const claims: Claim[] = [];

  for (const schema of schemaModels) {
    const snapshot = snapshotsByFile.get(schema.file!);
    const content = fileContentBySchemaFile.get(schema.file!);
    if (!snapshot || content === undefined) {
      continue;
    }

    const detectorMethod = schema.confidence === "regex" ? "regex" : "ast";
    const modelEvidence = locateModelEvidence(schema, content);
    const modelEvidenceEntry = createEvidenceEntry(snapshot, modelEvidence, detectorMethod);
    evidence.push(modelEvidenceEntry);
    claims.push(buildModelClaim(schema, snapshot, modelEvidenceEntry.id));

    for (const relation of schema.relations) {
      const relationEvidence = locateRelationEvidence(schema, relation, content, modelEvidence);
      const relationEvidenceEntry = createEvidenceEntry(snapshot, relationEvidence, detectorMethod);
      evidence.push(relationEvidenceEntry);
      claims.push(buildRelationClaim(schema, relation, snapshot, relationEvidenceEntry.id));
    }
  }

  return {
    snapshots: [...snapshotsByFile.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    evidence: uniqueById(evidence).sort((a, b) => a.id.localeCompare(b.id)),
    claims: uniqueById(claims).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
