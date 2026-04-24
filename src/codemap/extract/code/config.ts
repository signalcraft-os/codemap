import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ScanResult } from "../../../types.js";
import { makeHashedCodemapId } from "../../model/ids.js";
import type { Claim, EvidenceSpan, SourceSnapshot } from "../../model/types.js";
import { createSourceSnapshot, normalizeSourcePath } from "../../snapshot/snapshotter.js";
import { createSourcePathMatcher, type SourcePathFilterOptions } from "./source-path-filter.js";

export interface ConfigClaimGraph {
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

const NOTABLE_DEPENDENCIES = new Set([
  "next", "react", "vue", "svelte", "hono", "express", "fastify", "koa",
  "@nestjs/core", "@nestjs/common", "elysia", "@adonisjs/core",
  "@sveltejs/kit", "@remix-run/node", "@remix-run/react", "nuxt",
  "drizzle-orm", "prisma", "@prisma/client", "typeorm", "mongoose", "sequelize",
  "pg", "mysql2", "better-sqlite3", "knex",
  "better-auth", "@clerk/nextjs", "next-auth", "lucia", "passport", "@auth/core",
  "stripe", "@polar-sh/sdk", "resend", "@lemonsqueezy/lemonsqueezy.js",
  "bullmq", "redis", "ioredis", "tailwindcss",
  "zod", "@trpc/server", "graphql", "@apollo/server",
  "@anthropic-ai/sdk", "openai", "ai", "langchain", "@google/generative-ai",
  "supabase", "@supabase/supabase-js", "firebase", "@firebase/app",
  "playwright", "puppeteer", "socket.io",
]);

function inferLanguageFromPath(path: string): string | undefined {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  if (path.endsWith(".toml")) return "toml";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
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

function configKindFromPath(path: string): string {
  const normalized = normalizeSourcePath(path);
  const name = basename(normalized).toLowerCase();
  if (name === "package.json") return "package-manifest";
  if (name.startsWith("tsconfig")) return "typescript";
  if (name.startsWith("next.config")) return "next";
  if (name.startsWith("vite.config")) return "vite";
  if (name.startsWith("tailwind.config")) return "tailwind";
  if (name.startsWith("drizzle.config")) return "drizzle";
  if (name === ".env.example") return "env-example";
  if (name === "dockerfile" || name.startsWith("docker-compose")) return "container";
  if (name.endsWith(".toml")) return "toml";
  if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
  return name.replace(/\.[^.]+$/, "") || "config";
}

function locateConfigEvidence(content: string): LocatedEvidence {
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

function locateDependencyEvidence(name: string, content: string): LocatedEvidence {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.includes(`"${name}"`)) {
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
    endLine: Math.min(lines.length, 4) || 1,
    excerpt: lines.slice(0, 4).join("\n"),
    labels: ["file-level", "heuristic"],
  };
}

function buildConfigFileClaim(snapshot: SourceSnapshot, evidenceId: string): Claim {
  const configKind = configKindFromPath(snapshot.sourcePath);
  return {
    id: makeHashedCodemapId("claim", ["config_file", snapshot.sourcePath]),
    type: "config_file",
    subject: snapshot.sourcePath,
    text: `Config file ${snapshot.sourcePath} is part of the project setup surface.`,
    sourceSnapshotIds: [snapshot.id],
    evidenceSpanIds: [evidenceId],
    status: "candidate",
    supportScore: 0.94,
    publicationConfidence: 0.94,
    firstSeenAt: snapshot.createdAt,
    tags: unique([
      "config",
      "kind:config-file",
      `config-kind:${configKind}`,
      `source-kind:${snapshot.sourceKind}`,
    ]).sort(),
  };
}

function buildDependencyClaim(
  snapshot: SourceSnapshot,
  evidenceId: string,
  dependencyName: string,
  version: string,
  scope: "runtime" | "development",
): Claim {
  const tags = [
    "dependency",
    "kind:package-dependency",
    `dependency-scope:${scope}`,
    `dependency-version:${version}`,
  ];
  if (NOTABLE_DEPENDENCIES.has(dependencyName)) {
    tags.push("notable-dependency");
  }

  return {
    id: makeHashedCodemapId("claim", ["package_dependency", scope, dependencyName]),
    type: "package_dependency",
    subject: dependencyName,
    text: `Package dependency ${dependencyName} (${version}) is declared in ${snapshot.sourcePath} as a ${scope} dependency.`,
    sourceSnapshotIds: [snapshot.id],
    evidenceSpanIds: [evidenceId],
    status: "candidate",
    supportScore: NOTABLE_DEPENDENCIES.has(dependencyName) ? 0.93 : 0.88,
    publicationConfidence: NOTABLE_DEPENDENCIES.has(dependencyName) ? 0.93 : 0.88,
    firstSeenAt: snapshot.createdAt,
    tags: unique(tags).sort(),
  };
}

export async function extractConfigClaimGraph(
  result: Pick<ScanResult, "project"> & Partial<Pick<ScanResult, "config">>,
  options: SourcePathFilterOptions = {},
): Promise<ConfigClaimGraph> {
  const matchesSourcePath = createSourcePathMatcher(options.sourcePaths);
  const configFiles = (result.config?.configFiles ?? [])
    .map((configFile) => normalizeSourcePath(configFile))
    .filter((configFile) => configFile.length > 0)
    .filter((configFile) => matchesSourcePath(configFile))
    .sort();

  const snapshotsByFile = new Map<string, SourceSnapshot>();
  const fileContentByFile = new Map<string, string>();

  for (const configFile of configFiles) {
    const absolutePath = join(result.project.root, configFile);
    let content = "";
    try {
      content = await readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }

    fileContentByFile.set(configFile, content);
    const snapshot = await createSourceSnapshot({
      repoRoot: result.project.root,
      absolutePath,
      sourceKind: "config",
      content,
      language: inferLanguageFromPath(configFile),
    });
    snapshotsByFile.set(configFile, snapshot);
  }

  const hasPackageDependencies = Object.keys(result.config?.dependencies ?? {}).length > 0
    || Object.keys(result.config?.devDependencies ?? {}).length > 0;
  if (hasPackageDependencies && matchesSourcePath("package.json") && !snapshotsByFile.has("package.json")) {
    const absolutePath = join(result.project.root, "package.json");
    try {
      const content = await readFile(absolutePath, "utf-8");
      fileContentByFile.set("package.json", content);
      const snapshot = await createSourceSnapshot({
        repoRoot: result.project.root,
        absolutePath,
        sourceKind: "config",
        content,
        language: inferLanguageFromPath("package.json"),
      });
      snapshotsByFile.set("package.json", snapshot);
    } catch {
      // package.json is the canonical dependency source for current config detection.
      // If it is missing or unreadable, dependency claims are skipped for this pass.
    }
  }

  const evidence: EvidenceSpan[] = [];
  const claims: Claim[] = [];

  for (const configFile of configFiles) {
    const snapshot = snapshotsByFile.get(configFile);
    const content = fileContentByFile.get(configFile);
    if (!snapshot || content === undefined) {
      continue;
    }

    const located = locateConfigEvidence(content);
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
      confidence: 0.94,
      labels: unique(located.labels).sort(),
    };
    evidence.push(evidenceEntry);
    claims.push(buildConfigFileClaim(snapshot, evidenceEntry.id));
  }

  const packageSnapshot = snapshotsByFile.get("package.json");
  const packageContent = fileContentByFile.get("package.json");
  if (packageSnapshot && packageContent !== undefined) {
    const runtimeDeps = Object.entries(result.config?.dependencies ?? {})
      .sort(([left], [right]) => left.localeCompare(right));
    const devDeps = Object.entries(result.config?.devDependencies ?? {})
      .sort(([left], [right]) => left.localeCompare(right));

    for (const [dependencyName, version] of runtimeDeps) {
      const located = locateDependencyEvidence(dependencyName, packageContent);
      const excerptHash = hashExcerpt(located.excerpt);
      const evidenceEntry: EvidenceSpan = {
        id: makeHashedCodemapId("evidence", [
          packageSnapshot.id,
          dependencyName,
          "runtime",
          String(located.startLine),
          excerptHash,
        ]),
        snapshotId: packageSnapshot.id,
        sourcePath: packageSnapshot.sourcePath,
        startLine: located.startLine,
        endLine: located.endLine,
        excerptHash,
        detectorMethod: "heuristic",
        confidence: NOTABLE_DEPENDENCIES.has(dependencyName) ? 0.93 : 0.88,
        labels: unique(located.labels).sort(),
      };
      evidence.push(evidenceEntry);
      claims.push(buildDependencyClaim(packageSnapshot, evidenceEntry.id, dependencyName, version, "runtime"));
    }

    for (const [dependencyName, version] of devDeps) {
      const located = locateDependencyEvidence(dependencyName, packageContent);
      const excerptHash = hashExcerpt(located.excerpt);
      const evidenceEntry: EvidenceSpan = {
        id: makeHashedCodemapId("evidence", [
          packageSnapshot.id,
          dependencyName,
          "development",
          String(located.startLine),
          excerptHash,
        ]),
        snapshotId: packageSnapshot.id,
        sourcePath: packageSnapshot.sourcePath,
        startLine: located.startLine,
        endLine: located.endLine,
        excerptHash,
        detectorMethod: "heuristic",
        confidence: NOTABLE_DEPENDENCIES.has(dependencyName) ? 0.91 : 0.86,
        labels: unique(located.labels).sort(),
      };
      evidence.push(evidenceEntry);
      claims.push(buildDependencyClaim(packageSnapshot, evidenceEntry.id, dependencyName, version, "development"));
    }
  }

  return {
    snapshots: [...snapshotsByFile.values()].sort((left, right) => left.sourcePath.localeCompare(right.sourcePath)),
    evidence: uniqueById(evidence).sort((left, right) => left.id.localeCompare(right.id)),
    claims: uniqueById(claims).sort((left, right) => left.id.localeCompare(right.id)),
  };
}
