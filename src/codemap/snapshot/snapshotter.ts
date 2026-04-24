import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { makeHashedCodemapId } from "../model/ids.js";
import type { SourceKind, SourceSnapshot } from "../model/types.js";

export interface CreateSourceSnapshotInput {
  repoRoot: string;
  absolutePath: string;
  sourceKind: SourceKind;
  createdAt?: string;
  gitCommit?: string;
  language?: string;
  content?: string;
}

export function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function hashSnapshotContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createSnapshotId(sourcePath: string, contentHash: string): string {
  return makeHashedCodemapId("snapshot", [normalizeSourcePath(sourcePath), contentHash]);
}

export async function createSourceSnapshot(input: CreateSourceSnapshotInput): Promise<SourceSnapshot> {
  const content = input.content ?? await readFile(input.absolutePath, "utf-8");
  const sourcePath = normalizeSourcePath(relative(input.repoRoot, input.absolutePath));
  const contentHash = hashSnapshotContent(content);
  const sizeBytes = input.content !== undefined
    ? Buffer.byteLength(input.content)
    : (await stat(input.absolutePath)).size;

  return {
    id: createSnapshotId(sourcePath, contentHash),
    sourcePath,
    sourceKind: input.sourceKind,
    contentHash,
    gitCommit: input.gitCommit,
    language: input.language,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sizeBytes,
  };
}
