import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { makeCodemapStorageBasename, makeHashedCodemapId } from "../model/ids.js";
import { CODEMAP_DIRECTORIES, CODEMAP_FILES } from "../model/layout.js";
import type {
  ClaimHistoryEntry,
  CodemapHistoryPolicy,
  CodemapHistoryPolicyMode,
  HistoryArchiveAction,
  HistoryArchiveBundle,
  HistoryArchiveClaimIndex,
  HistoryArchiveClaimIndexEntry,
  HistoryArchiveCandidate,
  HistoryArchiveManifest,
  HistoryPartitionIndex,
  HistoryPartitionIndexEntry,
  HistoryArchiveRunIndex,
  HistoryArchiveRunIndexEntry,
  HistoryArchiveSegment,
  HistoryRunIndex,
  HistoryRunIndexEntry,
  PublishRunRecord,
  SnapshotArchiveBundle,
  SnapshotArchiveCandidate,
  SnapshotArchiveIndex,
  SnapshotArchiveIndexEntry,
  SnapshotArchiveManifest,
  SnapshotArchiveSegment,
  SnapshotManifest,
  SnapshotStorageStatus,
  SourceSnapshot,
  VerificationHistoryEntry,
  HistoryStorageStatus,
} from "../model/types.js";
import { readJsonFile, readNdjsonFile, resolveCodemapPath, writeJsonFile, writeNdjsonFile } from "../store/fs.js";

const DEFAULT_MAX_HOT_BYTES = 256 * 1024 * 1024;
const DEFAULT_TARGET_HOT_BYTES = 192 * 1024 * 1024;
const DEFAULT_WARN_AT_PERCENT = 0.8;
const DEFAULT_SEGMENT_TARGET_BYTES = 32 * 1024 * 1024;

function compareArchiveCandidate(left: HistoryArchiveCandidate, right: HistoryArchiveCandidate): number {
  return left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId);
}

function compareArchiveSegment(left: HistoryArchiveSegment, right: HistoryArchiveSegment): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareSnapshotArchiveCandidate(left: SnapshotArchiveCandidate, right: SnapshotArchiveCandidate): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.sourcePath.localeCompare(right.sourcePath)
    || left.snapshotId.localeCompare(right.snapshotId);
}

function compareSnapshotArchiveSegment(left: SnapshotArchiveSegment, right: SnapshotArchiveSegment): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.sourcePath.localeCompare(right.sourcePath)
    || left.id.localeCompare(right.id);
}

function compareHistoryIndexEntry(left: HistoryPartitionIndexEntry, right: HistoryPartitionIndexEntry): number {
  return left.claimId.localeCompare(right.claimId);
}

function compareRunHistoryIndexEntry(left: HistoryRunIndexEntry, right: HistoryRunIndexEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId);
}

function compareArchiveClaimIndexEntry(
  left: HistoryArchiveClaimIndexEntry,
  right: HistoryArchiveClaimIndexEntry,
): number {
  return left.claimId.localeCompare(right.claimId);
}

function compareArchiveRunIndexEntry(
  left: HistoryArchiveRunIndexEntry,
  right: HistoryArchiveRunIndexEntry,
): number {
  return (left.createdAt ?? "").localeCompare(right.createdAt ?? "") || left.runId.localeCompare(right.runId);
}

function compareSnapshotArchiveIndexEntry(
  left: SnapshotArchiveIndexEntry,
  right: SnapshotArchiveIndexEntry,
): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.sourcePath.localeCompare(right.sourcePath)
    || left.snapshotId.localeCompare(right.snapshotId);
}

function compareClaimHistory(left: ClaimHistoryEntry, right: ClaimHistoryEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareVerificationHistory(left: VerificationHistoryEntry, right: VerificationHistoryEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function normalizeMode(mode: CodemapHistoryPolicyMode | undefined): CodemapHistoryPolicyMode {
  return mode ?? "observe";
}

function normalizePositiveInteger(value: unknown, fallback: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(Math.floor(value), 0);
}

function normalizeWarnAtPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_WARN_AT_PERCENT;
  }
  return Math.min(Math.max(value, 0), 1);
}

function normalizeHistoryPolicy(
  policy: Partial<CodemapHistoryPolicy> | null | undefined,
  updatedAt: string,
): CodemapHistoryPolicy {
  const maxHotBytes = normalizePositiveInteger(policy?.maxHotBytes, DEFAULT_MAX_HOT_BYTES);
  const rawTargetHotBytes = normalizePositiveInteger(policy?.targetHotBytes, DEFAULT_TARGET_HOT_BYTES);
  const targetHotBytes = maxHotBytes === undefined
    ? rawTargetHotBytes
    : Math.min(rawTargetHotBytes ?? DEFAULT_TARGET_HOT_BYTES, maxHotBytes);

  return {
    version: 1,
    updatedAt: policy?.updatedAt ?? updatedAt,
    mode: normalizeMode(policy?.mode),
    maxHotBytes,
    targetHotBytes,
    warnAtPercent: normalizeWarnAtPercent(policy?.warnAtPercent),
    segmentTargetBytes: normalizePositiveInteger(policy?.segmentTargetBytes, DEFAULT_SEGMENT_TARGET_BYTES)
      ?? DEFAULT_SEGMENT_TARGET_BYTES,
    preserveFullLedgers: policy?.preserveFullLedgers ?? true,
  };
}

function normalizeArchiveSegment(segment: HistoryArchiveSegment): HistoryArchiveSegment {
  return {
    ...segment,
    mode: normalizeMode(segment.mode),
    state: segment.state === "archived" ? "archived" : "planned",
    runIds: [...new Set(segment.runIds)].sort(),
    partitionPaths: [...new Set(segment.partitionPaths)].sort(),
    claimHistoryEntries: Math.max(0, Math.floor(segment.claimHistoryEntries)),
    verificationHistoryEntries: Math.max(0, Math.floor(segment.verificationHistoryEntries)),
    bytes: Math.max(0, Math.floor(segment.bytes)),
    compression: segment.compression === "gzip" ? "gzip" : "none",
    bundlePath: segment.bundlePath,
  };
}

function normalizeArchiveManifest(
  manifest: Partial<HistoryArchiveManifest> | null | undefined,
  generatedAt: string,
): HistoryArchiveManifest {
  const segments = (manifest?.segments ?? [])
    .map((segment) => normalizeArchiveSegment(segment))
    .sort(compareArchiveSegment);

  return {
    version: 1,
    generatedAt: manifest?.generatedAt ?? generatedAt,
    mode: normalizeMode(manifest?.mode),
    segments,
    totalArchiveBytes: segments
      .filter((segment) => segment.state === "archived")
      .reduce((sum, segment) => sum + segment.bytes, 0),
    plannedBytes: segments
      .filter((segment) => segment.state === "planned")
      .reduce((sum, segment) => sum + segment.bytes, 0),
  };
}

function normalizeSnapshotArchiveSegment(segment: SnapshotArchiveSegment): SnapshotArchiveSegment {
  return {
    ...segment,
    state: segment.state === "archived" ? "archived" : "planned",
    compression: segment.compression === "gzip" ? "gzip" : "none",
    bytes: Math.max(0, Math.floor(segment.bytes)),
    sizeBytes: Math.max(0, Math.floor(segment.sizeBytes)),
    bundlePath: segment.bundlePath,
    metadataPath: segment.metadataPath,
    contentPath: segment.contentPath,
  };
}

function normalizeSnapshotArchiveManifest(
  manifest: Partial<SnapshotArchiveManifest> | null | undefined,
  generatedAt: string,
): SnapshotArchiveManifest {
  const segments = (manifest?.segments ?? [])
    .map((segment) => normalizeSnapshotArchiveSegment(segment))
    .sort(compareSnapshotArchiveSegment);

  return {
    version: 1,
    generatedAt: manifest?.generatedAt ?? generatedAt,
    mode: normalizeMode(manifest?.mode),
    segments,
    totalArchiveBytes: segments
      .filter((segment) => segment.state === "archived")
      .reduce((sum, segment) => sum + segment.bytes, 0),
    plannedBytes: segments
      .filter((segment) => segment.state === "planned")
      .reduce((sum, segment) => sum + segment.bytes, 0),
  };
}

function selectHotSnapshotIds(manifest: SnapshotManifest | null | undefined): Set<string> {
  const latestBySourcePath = new Map<string, SnapshotManifest["entries"][number]>();

  for (const entry of manifest?.entries ?? []) {
    const existing = latestBySourcePath.get(entry.sourcePath);
    if (!existing) {
      latestBySourcePath.set(entry.sourcePath, entry);
      continue;
    }

    const existingSortKey = `${existing.createdAt}\u0000${existing.snapshotId}`;
    const nextSortKey = `${entry.createdAt}\u0000${entry.snapshotId}`;
    if (nextSortKey > existingSortKey) {
      latestBySourcePath.set(entry.sourcePath, entry);
    }
  }

  return new Set([...latestBySourcePath.values()].map((entry) => entry.snapshotId));
}

function getHotSnapshotFilePath(repoRoot: string, snapshotId: string): string {
  return resolveCodemapPath(
    repoRoot,
    `${CODEMAP_DIRECTORIES.snapshotFiles}/${makeCodemapStorageBasename(snapshotId, ".json")}`,
  );
}

function getHotSnapshotContentPath(repoRoot: string, snapshotId: string): string {
  const basename = createHash("sha256").update(snapshotId).digest("hex");
  return resolveCodemapPath(repoRoot, `${CODEMAP_DIRECTORIES.snapshotContents}/${basename}.txt.gz`);
}

function getSnapshotArchiveSegmentFile(snapshotId: string): string {
  const basename = createHash("sha256").update(snapshotId).digest("hex");
  return `${CODEMAP_DIRECTORIES.archiveSnapshotSegments}/${basename}.json.gz`;
}

function getSnapshotArchiveMetadataFile(snapshotId: string): string {
  const basename = createHash("sha256").update(snapshotId).digest("hex");
  return `${CODEMAP_DIRECTORIES.archiveSnapshotFiles}/${basename}.json`;
}

function getSnapshotArchiveContentFile(snapshotId: string): string {
  const basename = createHash("sha256").update(snapshotId).digest("hex");
  return `${CODEMAP_DIRECTORIES.archiveSnapshotContents}/${basename}.txt.gz`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function measureFileBytes(repoRoot: string, codemapPath: string): Promise<number> {
  try {
    const fileStat = await stat(resolveCodemapPath(repoRoot, codemapPath));
    return fileStat.isFile() ? fileStat.size : 0;
  } catch {
    return 0;
  }
}

async function measureDirectoryTree(path: string): Promise<{ bytes: number; files: number }> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    let bytes = 0;
    let files = 0;

    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        const nested = await measureDirectoryTree(entryPath);
        bytes += nested.bytes;
        files += nested.files;
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const entryStat = await stat(entryPath);
      bytes += entryStat.size;
      files += 1;
    }

    return { bytes, files };
  } catch {
    return { bytes: 0, files: 0 };
  }
}

function getRecommendedAction(mode: CodemapHistoryPolicyMode): HistoryArchiveAction {
  switch (mode) {
    case "compact":
      return "compact";
    case "delete":
      return "delete";
    default:
      return "archive";
  }
}

interface HotSnapshotRecord {
  snapshot: SourceSnapshot;
  snapshotPath: string;
  contentPath?: string;
  metadataBytes: number;
  contentBytes: number;
}

interface SnapshotHotUsage {
  activeBytes: number;
  historicalBytes: number;
  hotBytes: number;
  activeSnapshots: number;
  historicalHotSnapshots: number;
}

async function collectHotSnapshotRecords(
  repoRoot: string,
  activeSnapshotIds: Set<string>,
): Promise<{ active: HotSnapshotRecord[]; historical: HotSnapshotRecord[] }> {
  const active: HotSnapshotRecord[] = [];
  const historical: HotSnapshotRecord[] = [];
  const snapshotDir = resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.snapshotFiles);

  try {
    const entries = await readdir(snapshotDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const snapshotPath = resolveCodemapPath(repoRoot, `${CODEMAP_DIRECTORIES.snapshotFiles}/${entry.name}`);
      const snapshot = await readJsonFile<SourceSnapshot>(snapshotPath);
      if (!snapshot) {
        continue;
      }
      const snapshotId = snapshot.id;

      const metadataBytes = await measureFileBytes(repoRoot, `${CODEMAP_DIRECTORIES.snapshotFiles}/${entry.name}`);
      const contentPath = getHotSnapshotContentPath(repoRoot, snapshotId);
      const contentBytes = await fileExists(contentPath) ? (await stat(contentPath)).size : 0;
      const record: HotSnapshotRecord = {
        snapshot,
        snapshotPath: `${CODEMAP_DIRECTORIES.snapshotFiles}/${entry.name}`,
        contentPath: contentBytes > 0
          ? `${CODEMAP_DIRECTORIES.snapshotContents}/${createHash("sha256").update(snapshotId).digest("hex")}.txt.gz`
          : undefined,
        metadataBytes,
        contentBytes,
      };

      if (activeSnapshotIds.has(snapshotId)) {
        active.push(record);
      } else {
        historical.push(record);
      }
    }
  } catch {}

  active.sort((left, right) => compareSnapshotArchiveCandidate({
    snapshotId: left.snapshot.id,
    sourcePath: left.snapshot.sourcePath,
    createdAt: left.snapshot.createdAt,
    contentHash: left.snapshot.contentHash,
    estimatedBytes: left.metadataBytes + left.contentBytes,
    snapshotPath: left.snapshotPath,
    contentPath: left.contentPath,
  }, {
    snapshotId: right.snapshot.id,
    sourcePath: right.snapshot.sourcePath,
    createdAt: right.snapshot.createdAt,
    contentHash: right.snapshot.contentHash,
    estimatedBytes: right.metadataBytes + right.contentBytes,
    snapshotPath: right.snapshotPath,
    contentPath: right.contentPath,
  }));
  historical.sort((left, right) => compareSnapshotArchiveCandidate({
    snapshotId: left.snapshot.id,
    sourcePath: left.snapshot.sourcePath,
    createdAt: left.snapshot.createdAt,
    contentHash: left.snapshot.contentHash,
    estimatedBytes: left.metadataBytes + left.contentBytes,
    snapshotPath: left.snapshotPath,
    contentPath: left.contentPath,
  }, {
    snapshotId: right.snapshot.id,
    sourcePath: right.snapshot.sourcePath,
    createdAt: right.snapshot.createdAt,
    contentHash: right.snapshot.contentHash,
    estimatedBytes: right.metadataBytes + right.contentBytes,
    snapshotPath: right.snapshotPath,
    contentPath: right.contentPath,
  }));

  return { active, historical };
}

function summarizeHotSnapshotUsage(records: {
  active: HotSnapshotRecord[];
  historical: HotSnapshotRecord[];
}): SnapshotHotUsage {
  const activeBytes = records.active.reduce((sum, record) => sum + record.metadataBytes + record.contentBytes, 0);
  const historicalBytes = records.historical.reduce((sum, record) => sum + record.metadataBytes + record.contentBytes, 0);
  return {
    activeBytes,
    historicalBytes,
    hotBytes: activeBytes + historicalBytes,
    activeSnapshots: records.active.length,
    historicalHotSnapshots: records.historical.length,
  };
}

function buildSnapshotArchiveCandidates(records: HotSnapshotRecord[]): SnapshotArchiveCandidate[] {
  return records
    .map((record) => ({
      snapshotId: record.snapshot.id,
      sourcePath: record.snapshot.sourcePath,
      createdAt: record.snapshot.createdAt,
      contentHash: record.snapshot.contentHash,
      estimatedBytes: record.metadataBytes + record.contentBytes,
      snapshotPath: record.snapshotPath,
      contentPath: record.contentPath,
    }))
    .sort(compareSnapshotArchiveCandidate);
}

function buildSnapshotArchiveSegments(
  policy: CodemapHistoryPolicy,
  candidates: SnapshotArchiveCandidate[],
): SnapshotArchiveSegment[] {
  return candidates
    .map<SnapshotArchiveSegment>((candidate) => ({
      id: makeHashedCodemapId("snapshot", ["archive", candidate.snapshotId]),
      snapshotId: candidate.snapshotId,
      sourcePath: candidate.sourcePath,
      createdAt: candidate.createdAt,
      contentHash: candidate.contentHash,
      sizeBytes: candidate.estimatedBytes,
      bytes: candidate.estimatedBytes,
      state: "planned",
      compression: "none",
    }))
    .sort(compareSnapshotArchiveSegment);
}

async function readExistingArchivedSnapshotSegments(
  repoRoot: string,
  manifest: SnapshotArchiveManifest,
): Promise<SnapshotArchiveSegment[]> {
  const archivedSegments = manifest.segments.filter((segment) => segment.state === "archived");
  const resolved: SnapshotArchiveSegment[] = [];

  for (const segment of archivedSegments) {
    if (segment.metadataPath
      && (await fileExists(resolveCodemapPath(repoRoot, segment.metadataPath)))) {
      resolved.push(segment);
      continue;
    }
    if (segment.bundlePath
      && (await fileExists(resolveCodemapPath(repoRoot, segment.bundlePath)))) {
      resolved.push(segment);
    }
  }

  return resolved.sort(compareSnapshotArchiveSegment);
}

async function readSnapshotArchiveBundle(
  repoRoot: string,
  bundlePath: string,
): Promise<SnapshotArchiveBundle | null> {
  try {
    const compressed = await readFile(resolveCodemapPath(repoRoot, bundlePath));
    return JSON.parse(gunzipSync(compressed).toString("utf-8")) as SnapshotArchiveBundle;
  } catch {
    return null;
  }
}

async function materializeSnapshotArchiveSegments(
  repoRoot: string,
  segments: SnapshotArchiveSegment[],
  _mode: CodemapHistoryPolicyMode,
): Promise<SnapshotArchiveSegment[]> {
  const materialized: SnapshotArchiveSegment[] = [];

  for (const segment of segments) {
    const snapshot = await readJsonFile<SourceSnapshot>(getHotSnapshotFilePath(repoRoot, segment.snapshotId));
    if (!snapshot) {
      continue;
    }

    let compressedContent: Buffer | undefined;
    try {
      compressedContent = await readFile(getHotSnapshotContentPath(repoRoot, segment.snapshotId));
    } catch {}

    const metadataPath = getSnapshotArchiveMetadataFile(segment.snapshotId);
    const absoluteMetadataPath = resolveCodemapPath(repoRoot, metadataPath);
    await mkdir(dirname(absoluteMetadataPath), { recursive: true });
    const metadataBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    await writeFile(absoluteMetadataPath, metadataBytes);

    let contentPath: string | undefined;
    let contentBytes = 0;
    if (compressedContent) {
      contentPath = getSnapshotArchiveContentFile(segment.snapshotId);
      const absoluteContentPath = resolveCodemapPath(repoRoot, contentPath);
      await mkdir(dirname(absoluteContentPath), { recursive: true });
      await writeFile(absoluteContentPath, compressedContent);
      contentBytes = compressedContent.byteLength;
    }

    materialized.push({
      ...segment,
      state: "archived",
      compression: "gzip",
      bundlePath: undefined,
      metadataPath,
      contentPath,
      bytes: metadataBytes.byteLength + contentBytes,
      sizeBytes: snapshot.sizeBytes,
    });
  }

  return materialized.sort(compareSnapshotArchiveSegment);
}

async function cleanupSnapshotArchiveFiles(
  repoRoot: string,
  segments: SnapshotArchiveSegment[],
): Promise<void> {
  const expectedBundleFiles = new Set(
    segments
      .map((segment) => segment.bundlePath?.split("/").at(-1))
      .filter((name): name is string => Boolean(name)),
  );
  const expectedMetadataFiles = new Set(
    segments
      .map((segment) => segment.metadataPath?.split("/").at(-1))
      .filter((name): name is string => Boolean(name)),
  );
  const expectedContentFiles = new Set(
    segments
      .map((segment) => segment.contentPath?.split("/").at(-1))
      .filter((name): name is string => Boolean(name)),
  );
  const archiveDir = resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.archiveSnapshotSegments);
  const filesDir = resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.archiveSnapshotFiles);
  const contentsDir = resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.archiveSnapshotContents);

  try {
    const existingFiles = await readdir(archiveDir, { withFileTypes: true });
    for (const file of existingFiles) {
      if (!file.isFile() || !file.name.endsWith(".json.gz")) {
        continue;
      }
      if (!expectedBundleFiles.has(file.name)) {
        await rm(join(archiveDir, file.name), { force: true });
      }
    }
  } catch {}

  try {
    const existingFiles = await readdir(filesDir, { withFileTypes: true });
    for (const file of existingFiles) {
      if (!file.isFile() || !file.name.endsWith(".json")) {
        continue;
      }
      if (!expectedMetadataFiles.has(file.name)) {
        await rm(join(filesDir, file.name), { force: true });
      }
    }
  } catch {}

  try {
    const existingFiles = await readdir(contentsDir, { withFileTypes: true });
    for (const file of existingFiles) {
      if (!file.isFile() || !file.name.endsWith(".txt.gz")) {
        continue;
      }
      if (!expectedContentFiles.has(file.name)) {
        await rm(join(contentsDir, file.name), { force: true });
      }
    }
  } catch {}
}

function buildSnapshotArchiveIndex(
  generatedAt: string,
  segments: SnapshotArchiveSegment[],
): SnapshotArchiveIndex {
  return {
    version: 1,
    generatedAt,
    snapshots: segments
      .filter((segment) =>
        segment.state === "archived"
        && (Boolean(segment.metadataPath) || Boolean(segment.bundlePath)))
      .map((segment) => ({
        snapshotId: segment.snapshotId,
        sourcePath: segment.sourcePath,
        createdAt: segment.createdAt,
        contentHash: segment.contentHash,
        sizeBytes: segment.sizeBytes,
        bytes: segment.bytes,
        segmentId: segment.id,
        bundlePath: segment.bundlePath,
        metadataPath: segment.metadataPath,
        contentPath: segment.contentPath,
      }))
      .sort(compareSnapshotArchiveIndexEntry),
  };
}

async function compactHotSnapshots(
  repoRoot: string,
  archivedSnapshotIds: Set<string>,
): Promise<void> {
  for (const snapshotId of archivedSnapshotIds) {
    await rm(getHotSnapshotFilePath(repoRoot, snapshotId), { force: true });
    await rm(getHotSnapshotContentPath(repoRoot, snapshotId), { force: true });
  }
}

function makeHistoryPartitionBasename(claimId: string): string {
  return `${createHash("sha256").update(claimId).digest("hex")}.ndjson`;
}

function makeRunHistoryPartitionBasename(runId: string): string {
  return `${createHash("sha256").update(runId).digest("hex")}.ndjson`;
}

function getClaimHistoryPartitionFile(claimId: string): string {
  return `${CODEMAP_DIRECTORIES.historyClaimPartitions}/${makeHistoryPartitionBasename(claimId)}`;
}

function getVerificationHistoryPartitionFile(claimId: string): string {
  return `${CODEMAP_DIRECTORIES.historyVerificationPartitions}/${makeHistoryPartitionBasename(claimId)}`;
}

function getClaimRunHistoryPartitionFile(runId: string): string {
  return `${CODEMAP_DIRECTORIES.historyRunClaimPartitions}/${makeRunHistoryPartitionBasename(runId)}`;
}

function getVerificationRunHistoryPartitionFile(runId: string): string {
  return `${CODEMAP_DIRECTORIES.historyRunVerificationPartitions}/${makeRunHistoryPartitionBasename(runId)}`;
}

export function getArchiveSegmentFile(segmentId: string): string {
  const basename = segmentId.split(":").at(-1) ?? segmentId;
  return `${CODEMAP_DIRECTORIES.archiveSegments}/${basename}.json.gz`;
}

function buildHistoryPartitionIndex<T extends { claimId: string; createdAt: string }>(
  entries: T[],
  partitionPathForClaimId: (claimId: string) => string,
): HistoryPartitionIndex {
  const countsByClaim = new Map<string, { entries: number; latestCreatedAt?: string }>();
  for (const entry of entries) {
    const existing = countsByClaim.get(entry.claimId);
    const latestCreatedAt = !existing || !existing.latestCreatedAt || existing.latestCreatedAt < entry.createdAt
      ? entry.createdAt
      : existing.latestCreatedAt;
    countsByClaim.set(entry.claimId, {
      entries: (existing?.entries ?? 0) + 1,
      latestCreatedAt,
    });
  }

  return {
    generatedAt: entries.map((entry) => entry.createdAt).sort().at(-1) ?? "",
    claims: [...countsByClaim.entries()]
      .map(([claimId, meta]) => ({
        claimId,
        entries: meta.entries,
        latestCreatedAt: meta.latestCreatedAt,
        partitionPath: partitionPathForClaimId(claimId),
      }))
      .sort(compareHistoryIndexEntry),
  };
}

function buildRunHistoryIndex(
  publishRuns: PublishRunRecord[],
  claimHistoryEntries: ClaimHistoryEntry[],
  verificationHistoryEntries: VerificationHistoryEntry[],
): HistoryRunIndex {
  const claimCountByRun = new Map<string, number>();
  const verificationCountByRun = new Map<string, number>();

  for (const entry of claimHistoryEntries) {
    claimCountByRun.set(entry.runId, (claimCountByRun.get(entry.runId) ?? 0) + 1);
  }
  for (const entry of verificationHistoryEntries) {
    verificationCountByRun.set(entry.runId, (verificationCountByRun.get(entry.runId) ?? 0) + 1);
  }

  return {
    generatedAt: publishRuns.map((run) => run.createdAt).sort().at(-1) ?? "",
    runs: [...publishRuns]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((run) => ({
        runId: run.id,
        createdAt: run.createdAt,
        trigger: run.trigger,
        refreshMode: run.refreshMode,
        changedFiles: [...run.changedFiles].sort(),
        impactedClaimTypes: [...run.impactedClaimTypes].sort(),
        targetedSourcePaths: [...run.targetedSourcePaths].sort(),
        claimHistoryEntries: claimCountByRun.get(run.id) ?? 0,
        verificationHistoryEntries: verificationCountByRun.get(run.id) ?? 0,
        claimPartitionPath: getClaimRunHistoryPartitionFile(run.id),
        verificationPartitionPath: getVerificationRunHistoryPartitionFile(run.id),
      }))
      .sort(compareRunHistoryIndexEntry),
  };
}

async function measureRunPartitionBytes(repoRoot: string, run: HistoryRunIndex["runs"][number]): Promise<number> {
  const [claimBytes, verificationBytes] = await Promise.all([
    measureFileBytes(repoRoot, run.claimPartitionPath),
    measureFileBytes(repoRoot, run.verificationPartitionPath),
  ]);
  return claimBytes + verificationBytes;
}

function buildArchiveCandidates(
  repoRoot: string,
  policy: CodemapHistoryPolicy,
  runIndex: HistoryRunIndex | null,
  hotBytes: number,
  archivedRunIds: Set<string>,
): Promise<HistoryArchiveCandidate[]> | HistoryArchiveCandidate[] {
  if (!policy.maxHotBytes || !runIndex || hotBytes <= policy.maxHotBytes) {
    return [];
  }

  return Promise.all(
    [...runIndex.runs]
      .filter((run) => !archivedRunIds.has(run.runId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId))
      .map(async (run) => ({
        runId: run.runId,
        createdAt: run.createdAt,
        recommendedAction: getRecommendedAction(policy.mode),
        estimatedBytes: await measureRunPartitionBytes(repoRoot, run),
        claimHistoryEntries: run.claimHistoryEntries,
        verificationHistoryEntries: run.verificationHistoryEntries,
        claimPartitionPath: run.claimPartitionPath,
        verificationPartitionPath: run.verificationPartitionPath,
      })),
  );
}

function planArchiveCandidates(
  policy: CodemapHistoryPolicy,
  candidates: HistoryArchiveCandidate[],
  hotBytes: number,
): HistoryArchiveCandidate[] {
  if (!policy.maxHotBytes || hotBytes <= policy.maxHotBytes) {
    return [];
  }

  const targetHotBytes = policy.targetHotBytes ?? policy.maxHotBytes;
  const planned: HistoryArchiveCandidate[] = [];
  let reclaimableBytes = 0;

  for (const candidate of [...candidates].sort(compareArchiveCandidate)) {
    if (candidate.estimatedBytes <= 0) {
      continue;
    }
    planned.push(candidate);
    reclaimableBytes += candidate.estimatedBytes;
    if (hotBytes - reclaimableBytes <= targetHotBytes) {
      break;
    }
  }

  return planned.sort(compareArchiveCandidate);
}

function buildPlannedSegments(
  generatedAt: string,
  policy: CodemapHistoryPolicy,
  candidates: HistoryArchiveCandidate[],
): HistoryArchiveSegment[] {
  if (candidates.length === 0) {
    return [];
  }

  const segments: HistoryArchiveSegment[] = [];
  let current: HistoryArchiveCandidate[] = [];
  let currentBytes = 0;

  for (const candidate of [...candidates].sort(compareArchiveCandidate)) {
    const nextBytes = currentBytes + candidate.estimatedBytes;
    if (current.length > 0 && nextBytes > policy.segmentTargetBytes) {
      const runIds = current.map((entry) => entry.runId).sort();
      segments.push({
        id: makeHashedCodemapId("history", ["archive-segment", "archive", ...runIds]),
        createdAt: generatedAt,
        mode: policy.mode,
        state: "planned",
        runIds,
        claimHistoryEntries: current.reduce((sum, entry) => sum + entry.claimHistoryEntries, 0),
        verificationHistoryEntries: current.reduce((sum, entry) => sum + entry.verificationHistoryEntries, 0),
        bytes: current.reduce((sum, entry) => sum + entry.estimatedBytes, 0),
        compression: "none",
        partitionPaths: current
          .flatMap((entry) => [entry.claimPartitionPath, entry.verificationPartitionPath])
          .sort(),
      });
      current = [];
      currentBytes = 0;
    }

    current.push(candidate);
    currentBytes += candidate.estimatedBytes;
  }

  if (current.length > 0) {
    const runIds = current.map((entry) => entry.runId).sort();
    segments.push({
      id: makeHashedCodemapId("history", ["archive-segment", "archive", ...runIds]),
      createdAt: generatedAt,
      mode: policy.mode,
      state: "planned",
      runIds,
      claimHistoryEntries: current.reduce((sum, entry) => sum + entry.claimHistoryEntries, 0),
      verificationHistoryEntries: current.reduce((sum, entry) => sum + entry.verificationHistoryEntries, 0),
      bytes: current.reduce((sum, entry) => sum + entry.estimatedBytes, 0),
      compression: "none",
      partitionPaths: current
        .flatMap((entry) => [entry.claimPartitionPath, entry.verificationPartitionPath])
        .sort(),
    });
  }

  return segments.sort(compareArchiveSegment);
}

function groupClaimHistoryByRun(entries: ClaimHistoryEntry[]): Map<string, ClaimHistoryEntry[]> {
  const grouped = new Map<string, ClaimHistoryEntry[]>();
  for (const entry of entries) {
    if (!grouped.has(entry.runId)) {
      grouped.set(entry.runId, []);
    }
    grouped.get(entry.runId)!.push(entry);
  }
  for (const rows of grouped.values()) {
    rows.sort(compareClaimHistory);
  }
  return grouped;
}

function groupVerificationHistoryByRun(entries: VerificationHistoryEntry[]): Map<string, VerificationHistoryEntry[]> {
  const grouped = new Map<string, VerificationHistoryEntry[]>();
  for (const entry of entries) {
    if (!grouped.has(entry.runId)) {
      grouped.set(entry.runId, []);
    }
    grouped.get(entry.runId)!.push(entry);
  }
  for (const rows of grouped.values()) {
    rows.sort(compareVerificationHistory);
  }
  return grouped;
}

async function readExistingArchivedSegments(
  repoRoot: string,
  manifest: HistoryArchiveManifest,
): Promise<HistoryArchiveSegment[]> {
  const archivedSegments = manifest.segments.filter((segment) => segment.state === "archived");
  const resolved: HistoryArchiveSegment[] = [];

  for (const segment of archivedSegments) {
    if (!segment.bundlePath) {
      continue;
    }
    if (!(await fileExists(resolveCodemapPath(repoRoot, segment.bundlePath)))) {
      continue;
    }
    resolved.push(segment);
  }

  return resolved.sort(compareArchiveSegment);
}

async function materializeArchiveSegments(
  repoRoot: string,
  segments: HistoryArchiveSegment[],
  claimHistory: ClaimHistoryEntry[],
  verificationHistory: VerificationHistoryEntry[],
): Promise<HistoryArchiveSegment[]> {
  const claimHistoryByRun = groupClaimHistoryByRun(claimHistory);
  const verificationHistoryByRun = groupVerificationHistoryByRun(verificationHistory);
  const materialized: HistoryArchiveSegment[] = [];

  for (const segment of segments) {
    const claimRows = segment.runIds
      .flatMap((runId) => claimHistoryByRun.get(runId) ?? [])
      .sort(compareClaimHistory);
    const verificationRows = segment.runIds
      .flatMap((runId) => verificationHistoryByRun.get(runId) ?? [])
      .sort(compareVerificationHistory);
    const bundle: HistoryArchiveBundle = {
      version: 1,
      segmentId: segment.id,
      createdAt: segment.createdAt,
      mode: segment.mode,
      runIds: [...segment.runIds],
      claimHistory: claimRows,
      verificationHistory: verificationRows,
      partitionPaths: [...segment.partitionPaths],
    };
    const bundlePath = getArchiveSegmentFile(segment.id);
    const absoluteBundlePath = resolveCodemapPath(repoRoot, bundlePath);
    await mkdir(dirname(absoluteBundlePath), { recursive: true });
    const compressedBundle = gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8"));
    await writeFile(absoluteBundlePath, compressedBundle);

    materialized.push({
      ...segment,
      state: "archived",
      compression: "gzip",
      bundlePath,
      bytes: compressedBundle.byteLength,
    });
  }

  return materialized.sort(compareArchiveSegment);
}

async function cleanupArchiveSegmentFiles(
  repoRoot: string,
  segments: HistoryArchiveSegment[],
): Promise<void> {
  const expectedFiles = new Set(
    segments
      .map((segment) => segment.bundlePath?.split("/").at(-1))
      .filter((name): name is string => Boolean(name)),
  );
  const archiveDir = resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.archiveSegments);

  try {
    const existingFiles = await readdir(archiveDir, { withFileTypes: true });
    for (const file of existingFiles) {
      if (!file.isFile() || !file.name.endsWith(".json.gz")) {
        continue;
      }
      if (!expectedFiles.has(file.name)) {
        await rm(join(archiveDir, file.name), { force: true });
      }
    }
  } catch {}
}

async function writeHistoryPartitions<T extends { claimId: string; createdAt: string; id: string }>(
  repoRoot: string,
  entries: T[],
  partitionDir: string,
  partitionPathForClaimId: (claimId: string) => string,
  indexPath: string,
  compareEntries: (left: T, right: T) => number,
): Promise<void> {
  const grouped = new Map<string, T[]>();
  for (const entry of entries) {
    if (!grouped.has(entry.claimId)) {
      grouped.set(entry.claimId, []);
    }
    grouped.get(entry.claimId)!.push(entry);
  }

  const expectedFiles = new Set<string>();
  for (const [claimId, groupedEntries] of grouped.entries()) {
    const partitionPath = partitionPathForClaimId(claimId);
    expectedFiles.add(partitionPath.split("/").at(-1) ?? "");
    await writeNdjsonFile(
      resolveCodemapPath(repoRoot, partitionPath),
      [...new Map(groupedEntries.map((entry) => [entry.id, entry])).values()].sort(compareEntries),
    );
  }

  try {
    const existingFiles = await readdir(resolveCodemapPath(repoRoot, partitionDir), { withFileTypes: true });
    for (const file of existingFiles) {
      if (!file.isFile() || !file.name.endsWith(".ndjson")) {
        continue;
      }
      if (!expectedFiles.has(file.name)) {
        await rm(resolveCodemapPath(repoRoot, `${partitionDir}/${file.name}`), { force: true });
      }
    }
  } catch {}

  await writeJsonFile(
    resolveCodemapPath(repoRoot, indexPath),
    buildHistoryPartitionIndex(entries, partitionPathForClaimId),
  );
}

async function writeGroupedHistoryPartitions<T extends { id: string }>(
  repoRoot: string,
  entriesByKey: Map<string, T[]>,
  partitionDir: string,
  partitionPathForKey: (key: string) => string,
  compareEntries: (left: T, right: T) => number,
): Promise<void> {
  const expectedFiles = new Set<string>();
  for (const [key, groupedEntries] of entriesByKey.entries()) {
    const partitionPath = partitionPathForKey(key);
    expectedFiles.add(partitionPath.split("/").at(-1) ?? "");
    await writeNdjsonFile(
      resolveCodemapPath(repoRoot, partitionPath),
      [...new Map(groupedEntries.map((entry) => [entry.id, entry])).values()].sort(compareEntries),
    );
  }

  try {
    const existingFiles = await readdir(resolveCodemapPath(repoRoot, partitionDir), { withFileTypes: true });
    for (const file of existingFiles) {
      if (!file.isFile() || !file.name.endsWith(".ndjson")) {
        continue;
      }
      if (!expectedFiles.has(file.name)) {
        await rm(resolveCodemapPath(repoRoot, `${partitionDir}/${file.name}`), { force: true });
      }
    }
  } catch {}
}

async function writeCompactedHotHistory(
  repoRoot: string,
  publishRuns: PublishRunRecord[],
  claimHistory: ClaimHistoryEntry[],
  verificationHistory: VerificationHistoryEntry[],
): Promise<void> {
  const dedupedClaimHistory = [...new Map(claimHistory.map((entry) => [entry.id, entry])).values()].sort(compareClaimHistory);
  const dedupedVerificationHistory = [...new Map(verificationHistory.map((entry) => [entry.id, entry])).values()]
    .sort(compareVerificationHistory);

  await writeNdjsonFile(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.claimHistoryNdjson),
    dedupedClaimHistory,
  );
  await writeNdjsonFile(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.verificationHistoryNdjson),
    dedupedVerificationHistory,
  );

  await writeHistoryPartitions(
    repoRoot,
    dedupedClaimHistory,
    CODEMAP_DIRECTORIES.historyClaimPartitions,
    getClaimHistoryPartitionFile,
    CODEMAP_FILES.claimHistoryIndex,
    compareClaimHistory,
  );
  await writeHistoryPartitions(
    repoRoot,
    dedupedVerificationHistory,
    CODEMAP_DIRECTORIES.historyVerificationPartitions,
    getVerificationHistoryPartitionFile,
    CODEMAP_FILES.verificationHistoryIndex,
    compareVerificationHistory,
  );

  const claimEntriesByRun = new Map<string, ClaimHistoryEntry[]>();
  const verificationEntriesByRun = new Map<string, VerificationHistoryEntry[]>();

  for (const entry of dedupedClaimHistory) {
    if (!claimEntriesByRun.has(entry.runId)) {
      claimEntriesByRun.set(entry.runId, []);
    }
    claimEntriesByRun.get(entry.runId)!.push(entry);
  }
  for (const entry of dedupedVerificationHistory) {
    if (!verificationEntriesByRun.has(entry.runId)) {
      verificationEntriesByRun.set(entry.runId, []);
    }
    verificationEntriesByRun.get(entry.runId)!.push(entry);
  }

  await writeGroupedHistoryPartitions(
    repoRoot,
    claimEntriesByRun,
    CODEMAP_DIRECTORIES.historyRunClaimPartitions,
    getClaimRunHistoryPartitionFile,
    compareClaimHistory,
  );
  await writeGroupedHistoryPartitions(
    repoRoot,
    verificationEntriesByRun,
    CODEMAP_DIRECTORIES.historyRunVerificationPartitions,
    getVerificationRunHistoryPartitionFile,
    compareVerificationHistory,
  );
  await writeJsonFile(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.publishRunsIndex),
    buildRunHistoryIndex(publishRuns, dedupedClaimHistory, dedupedVerificationHistory),
  );
}

async function measureHotHistoryUsage(repoRoot: string): Promise<{
  ledgerBytes: number;
  metadataBytes: number;
  byClaimPartitionBytes: number;
  byRunPartitionBytes: number;
  hotBytes: number;
  claimPartitionFiles: number;
  verificationPartitionFiles: number;
  runClaimPartitionFiles: number;
  runVerificationPartitionFiles: number;
}> {
  const [
    claimLedgerBytes,
    verificationLedgerBytes,
    publishRunLedgerBytes,
    claimIndexBytes,
    verificationIndexBytes,
    publishRunsIndexBytes,
    policyBytes,
    { bytes: claimPartitionBytes, files: claimPartitionFiles },
    { bytes: verificationPartitionBytes, files: verificationPartitionFiles },
    { bytes: runClaimPartitionBytes, files: runClaimPartitionFiles },
    { bytes: runVerificationPartitionBytes, files: runVerificationPartitionFiles },
  ] = await Promise.all([
    measureFileBytes(repoRoot, CODEMAP_FILES.claimHistoryNdjson),
    measureFileBytes(repoRoot, CODEMAP_FILES.verificationHistoryNdjson),
    measureFileBytes(repoRoot, CODEMAP_FILES.publishRunsNdjson),
    measureFileBytes(repoRoot, CODEMAP_FILES.claimHistoryIndex),
    measureFileBytes(repoRoot, CODEMAP_FILES.verificationHistoryIndex),
    measureFileBytes(repoRoot, CODEMAP_FILES.publishRunsIndex),
    measureFileBytes(repoRoot, CODEMAP_FILES.historyPolicy),
    measureDirectoryTree(resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.historyClaimPartitions)),
    measureDirectoryTree(resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.historyVerificationPartitions)),
    measureDirectoryTree(resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.historyRunClaimPartitions)),
    measureDirectoryTree(resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.historyRunVerificationPartitions)),
  ]);

  const ledgerBytes = claimLedgerBytes + verificationLedgerBytes + publishRunLedgerBytes;
  const metadataBytes = claimIndexBytes + verificationIndexBytes + publishRunsIndexBytes + policyBytes;
  const byClaimPartitionBytes = claimPartitionBytes + verificationPartitionBytes;
  const byRunPartitionBytes = runClaimPartitionBytes + runVerificationPartitionBytes;
  const hotBytes = ledgerBytes + metadataBytes + byClaimPartitionBytes + byRunPartitionBytes;

  return {
    ledgerBytes,
    metadataBytes,
    byClaimPartitionBytes,
    byRunPartitionBytes,
    hotBytes,
    claimPartitionFiles,
    verificationPartitionFiles,
    runClaimPartitionFiles,
    runVerificationPartitionFiles,
  };
}

function buildArchiveClaimIndex(
  generatedAt: string,
  bundles: Array<{ segment: HistoryArchiveSegment; bundle: HistoryArchiveBundle }>,
): HistoryArchiveClaimIndex {
  const claims = new Map<string, HistoryArchiveClaimIndexEntry>();

  for (const { segment, bundle } of bundles) {
    for (const entry of bundle.claimHistory) {
      const existing = claims.get(entry.claimId) ?? {
        claimId: entry.claimId,
        claimHistorySegments: [],
        verificationHistorySegments: [],
        claimHistoryEntries: 0,
        verificationHistoryEntries: 0,
      };
      existing.claimHistoryEntries += 1;
      existing.claimHistorySegments.push(segment.id);
      claims.set(entry.claimId, existing);
    }

    for (const entry of bundle.verificationHistory) {
      const existing = claims.get(entry.claimId) ?? {
        claimId: entry.claimId,
        claimHistorySegments: [],
        verificationHistorySegments: [],
        claimHistoryEntries: 0,
        verificationHistoryEntries: 0,
      };
      existing.verificationHistoryEntries += 1;
      existing.verificationHistorySegments.push(segment.id);
      claims.set(entry.claimId, existing);
    }
  }

  return {
    version: 1,
    generatedAt,
    claims: [...claims.values()]
      .map((entry) => ({
        ...entry,
        claimHistorySegments: [...new Set(entry.claimHistorySegments)].sort(),
        verificationHistorySegments: [...new Set(entry.verificationHistorySegments)].sort(),
      }))
      .sort(compareArchiveClaimIndexEntry),
  };
}

function buildArchiveRunIndex(
  generatedAt: string,
  bundles: Array<{ segment: HistoryArchiveSegment; bundle: HistoryArchiveBundle }>,
): HistoryArchiveRunIndex {
  const runs = new Map<string, HistoryArchiveRunIndexEntry>();

  for (const { segment, bundle } of bundles) {
    for (const runId of bundle.runIds) {
      const claimHistoryEntries = bundle.claimHistory.filter((entry) => entry.runId === runId).length;
      const verificationHistoryEntries = bundle.verificationHistory.filter((entry) => entry.runId === runId).length;
      const createdAt = bundle.claimHistory.find((entry) => entry.runId === runId)?.createdAt
        ?? bundle.verificationHistory.find((entry) => entry.runId === runId)?.createdAt
        ?? segment.createdAt;
      const existing = runs.get(runId) ?? {
        runId,
        createdAt,
        segmentIds: [],
        claimHistoryEntries: 0,
        verificationHistoryEntries: 0,
      };
      existing.segmentIds.push(segment.id);
      existing.claimHistoryEntries += claimHistoryEntries;
      existing.verificationHistoryEntries += verificationHistoryEntries;
      if (!existing.createdAt || existing.createdAt > createdAt) {
        existing.createdAt = createdAt;
      }
      runs.set(runId, existing);
    }
  }

  return {
    version: 1,
    generatedAt,
    runs: [...runs.values()]
      .map((entry) => ({
        ...entry,
        segmentIds: [...new Set(entry.segmentIds)].sort(),
      }))
      .sort(compareArchiveRunIndexEntry),
  };
}

async function writeArchiveIndexes(
  repoRoot: string,
  generatedAt: string,
  bundles: Array<{ segment: HistoryArchiveSegment; bundle: HistoryArchiveBundle }>,
): Promise<void> {
  await writeJsonFile(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.archiveClaimIndex),
    buildArchiveClaimIndex(generatedAt, bundles),
  );
  await writeJsonFile(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.archiveRunIndex),
    buildArchiveRunIndex(generatedAt, bundles),
  );
}

async function readArchiveBundle(
  repoRoot: string,
  segment: HistoryArchiveSegment,
): Promise<HistoryArchiveBundle | null> {
  if (segment.state !== "archived" || !segment.bundlePath) {
    return null;
  }

  try {
    const compressed = await readFile(resolveCodemapPath(repoRoot, segment.bundlePath));
    const content = segment.compression === "gzip"
      ? gunzipSync(compressed).toString("utf-8")
      : compressed.toString("utf-8");
    return JSON.parse(content) as HistoryArchiveBundle;
  } catch {
    return null;
  }
}

async function readArchivedBundles(
  repoRoot: string,
  segmentIds?: Iterable<string>,
): Promise<Array<{
  segment: HistoryArchiveSegment;
  bundle: HistoryArchiveBundle;
}>> {
  const manifest = await readHistoryArchiveManifest(repoRoot, "");
  const allowedSegmentIds = segmentIds ? new Set(segmentIds) : null;
  const archivedSegments = manifest.segments
    .filter((segment) => segment.state === "archived")
    .filter((segment) => !allowedSegmentIds || allowedSegmentIds.has(segment.id));
  const bundles = await Promise.all(archivedSegments.map(async (segment) => ({
    segment,
    bundle: await readArchiveBundle(repoRoot, segment),
  })));

  return bundles
    .filter((entry): entry is { segment: HistoryArchiveSegment; bundle: HistoryArchiveBundle } => Boolean(entry.bundle))
    .sort((left, right) => compareArchiveSegment(left.segment, right.segment));
}

function dedupeClaimHistory(entries: ClaimHistoryEntry[]): ClaimHistoryEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort(compareClaimHistory);
}

function dedupeVerificationHistory(entries: VerificationHistoryEntry[]): VerificationHistoryEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort(compareVerificationHistory);
}

export async function readArchivedClaimHistoryByRunId(repoRoot: string, runId: string): Promise<ClaimHistoryEntry[]> {
  const runIndex = await readArchiveRunIndex(repoRoot);
  const indexedRun = runIndex?.runs.find((entry) => entry.runId === runId);
  const bundles = await readArchivedBundles(repoRoot, indexedRun?.segmentIds);
  return dedupeClaimHistory(
    bundles
      .filter(({ segment }) => segment.runIds.includes(runId))
      .flatMap(({ bundle }) => bundle.claimHistory.filter((entry) => entry.runId === runId)),
  );
}

export async function readArchivedVerificationHistoryByRunId(
  repoRoot: string,
  runId: string,
): Promise<VerificationHistoryEntry[]> {
  const runIndex = await readArchiveRunIndex(repoRoot);
  const indexedRun = runIndex?.runs.find((entry) => entry.runId === runId);
  const bundles = await readArchivedBundles(repoRoot, indexedRun?.segmentIds);
  return dedupeVerificationHistory(
    bundles
      .filter(({ segment }) => segment.runIds.includes(runId))
      .flatMap(({ bundle }) => bundle.verificationHistory.filter((entry) => entry.runId === runId)),
  );
}

export async function readArchivedClaimHistoryByClaimId(
  repoRoot: string,
  claimId: string,
): Promise<ClaimHistoryEntry[]> {
  const claimIndex = await readArchiveClaimIndex(repoRoot);
  const indexedClaim = claimIndex?.claims.find((entry) => entry.claimId === claimId);
  const bundles = await readArchivedBundles(repoRoot, indexedClaim?.claimHistorySegments);
  return dedupeClaimHistory(
    bundles.flatMap(({ bundle }) => bundle.claimHistory.filter((entry) => entry.claimId === claimId)),
  );
}

export async function readArchivedVerificationHistoryByClaimId(
  repoRoot: string,
  claimId: string,
): Promise<VerificationHistoryEntry[]> {
  const claimIndex = await readArchiveClaimIndex(repoRoot);
  const indexedClaim = claimIndex?.claims.find((entry) => entry.claimId === claimId);
  const bundles = await readArchivedBundles(repoRoot, indexedClaim?.verificationHistorySegments);
  return dedupeVerificationHistory(
    bundles.flatMap(({ bundle }) => bundle.verificationHistory.filter((entry) => entry.claimId === claimId)),
  );
}

export interface SyncHistoryStoragePolicyResult {
  policy: CodemapHistoryPolicy;
  manifest: HistoryArchiveManifest;
  status: HistoryStorageStatus;
}

export function createDefaultHistoryPolicy(updatedAt: string): CodemapHistoryPolicy {
  return normalizeHistoryPolicy(undefined, updatedAt);
}

export async function readHistoryPolicy(repoRoot: string, fallbackUpdatedAt: string): Promise<CodemapHistoryPolicy> {
  const existing = await readJsonFile<Partial<CodemapHistoryPolicy>>(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.historyPolicy),
  );
  return normalizeHistoryPolicy(existing, fallbackUpdatedAt);
}

export async function writeHistoryPolicy(repoRoot: string, policy: CodemapHistoryPolicy): Promise<void> {
  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.historyPolicy), policy);
}

export async function readHistoryArchiveManifest(
  repoRoot: string,
  fallbackGeneratedAt: string,
): Promise<HistoryArchiveManifest> {
  const existing = await readJsonFile<Partial<HistoryArchiveManifest>>(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.archiveManifest),
  );
  return normalizeArchiveManifest(existing, fallbackGeneratedAt);
}

export async function writeHistoryArchiveManifest(repoRoot: string, manifest: HistoryArchiveManifest): Promise<void> {
  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.archiveManifest), manifest);
}

export async function readArchiveClaimIndex(repoRoot: string): Promise<HistoryArchiveClaimIndex | null> {
  return readJsonFile<HistoryArchiveClaimIndex>(resolveCodemapPath(repoRoot, CODEMAP_FILES.archiveClaimIndex));
}

export async function readArchiveRunIndex(repoRoot: string): Promise<HistoryArchiveRunIndex | null> {
  return readJsonFile<HistoryArchiveRunIndex>(resolveCodemapPath(repoRoot, CODEMAP_FILES.archiveRunIndex));
}

export async function readSnapshotArchiveManifest(
  repoRoot: string,
  fallbackGeneratedAt: string,
): Promise<SnapshotArchiveManifest> {
  const existing = await readJsonFile<Partial<SnapshotArchiveManifest>>(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.archiveSnapshotManifest),
  );
  return normalizeSnapshotArchiveManifest(existing, fallbackGeneratedAt);
}

export async function writeSnapshotArchiveManifest(
  repoRoot: string,
  manifest: SnapshotArchiveManifest,
): Promise<void> {
  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.archiveSnapshotManifest), manifest);
}

export async function readSnapshotArchiveIndex(repoRoot: string): Promise<SnapshotArchiveIndex | null> {
  return readJsonFile<SnapshotArchiveIndex>(resolveCodemapPath(repoRoot, CODEMAP_FILES.archiveSnapshotIndex));
}

export async function readArchivedSnapshotById(
  repoRoot: string,
  snapshotId: string,
): Promise<SourceSnapshot | null> {
  const index = await readSnapshotArchiveIndex(repoRoot);
  const entry = index?.snapshots.find((item) => item.snapshotId === snapshotId);
  if (!entry) {
    return null;
  }

  if (entry.metadataPath) {
    const shard = await readJsonFile<SourceSnapshot>(resolveCodemapPath(repoRoot, entry.metadataPath));
    if (shard) {
      return shard;
    }
  }

  if (!entry.bundlePath) {
    return null;
  }
  const bundle = await readSnapshotArchiveBundle(repoRoot, entry.bundlePath);
  return bundle?.snapshot ?? null;
}

export async function readArchivedSnapshotContentById(
  repoRoot: string,
  snapshotId: string,
): Promise<string | null> {
  const index = await readSnapshotArchiveIndex(repoRoot);
  const entry = index?.snapshots.find((item) => item.snapshotId === snapshotId);
  if (!entry) {
    return null;
  }

  if (entry.contentPath) {
    try {
      const compressed = await readFile(resolveCodemapPath(repoRoot, entry.contentPath));
      return gunzipSync(compressed).toString("utf-8");
    } catch {}
  }

  if (entry.metadataPath || !entry.bundlePath) {
    return null;
  }
  const bundle = await readSnapshotArchiveBundle(repoRoot, entry.bundlePath);
  return bundle?.content ?? null;
}

export async function syncHistoryStoragePolicy(
  repoRoot: string,
  generatedAt: string,
): Promise<SyncHistoryStoragePolicyResult> {
  const policy = await readHistoryPolicy(repoRoot, generatedAt);
  await writeHistoryPolicy(repoRoot, policy);

  const existingManifest = await readHistoryArchiveManifest(repoRoot, generatedAt);
  const archivedSegments = await readExistingArchivedSegments(repoRoot, existingManifest);
  const archivedRunIds = new Set(archivedSegments.flatMap((segment) => segment.runIds));
  const runIndex = await readJsonFile<HistoryRunIndex>(resolveCodemapPath(repoRoot, CODEMAP_FILES.publishRunsIndex));
  const [claimHistory, verificationHistory, publishRuns] = await Promise.all([
    readNdjsonFile<ClaimHistoryEntry>(resolveCodemapPath(repoRoot, CODEMAP_FILES.claimHistoryNdjson)),
    readNdjsonFile<VerificationHistoryEntry>(resolveCodemapPath(repoRoot, CODEMAP_FILES.verificationHistoryNdjson)),
    readNdjsonFile<PublishRunRecord>(resolveCodemapPath(repoRoot, CODEMAP_FILES.publishRunsNdjson)),
  ]);
  const activeSnapshotManifest = await readJsonFile<SnapshotManifest>(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.snapshotManifest),
  );
  const activeSnapshotIds = selectHotSnapshotIds(activeSnapshotManifest);
  const existingSnapshotManifest = await readSnapshotArchiveManifest(repoRoot, generatedAt);
  const archivedSnapshotSegments = await readExistingArchivedSnapshotSegments(repoRoot, existingSnapshotManifest);
  const archivedSnapshotIds = new Set(archivedSnapshotSegments.map((segment) => segment.snapshotId));
  const hotSnapshotRecords = await collectHotSnapshotRecords(repoRoot, activeSnapshotIds);
  const initialSnapshotHotUsage = summarizeHotSnapshotUsage(hotSnapshotRecords);
  const snapshotCandidates = buildSnapshotArchiveCandidates(
    hotSnapshotRecords.historical.filter((record) => !archivedSnapshotIds.has(record.snapshot.id)),
  );
  const initialHotUsage = await measureHotHistoryUsage(repoRoot);
  const latestRunId = [...publishRuns]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1)?.id;

  const candidateSource = await Promise.resolve(
    buildArchiveCandidates(repoRoot, policy, runIndex, initialHotUsage.hotBytes, archivedRunIds),
  );
  const eligibleCandidateSource = policy.mode === "compact" && latestRunId
    ? candidateSource.filter((candidate) => candidate.runId !== latestRunId)
    : candidateSource;
  const candidateRuns = planArchiveCandidates(
    policy,
    eligibleCandidateSource
      .map((candidate) => ({ ...candidate }))
      .sort(compareArchiveCandidate),
    initialHotUsage.hotBytes,
  );
  const plannedSegments = buildPlannedSegments(generatedAt, policy, candidateRuns);
  const materializedSegments = policy.mode === "archive" || policy.mode === "compact"
    ? await materializeArchiveSegments(repoRoot, plannedSegments, claimHistory, verificationHistory)
    : [];
  const manifestSegments = policy.mode === "archive" || policy.mode === "compact"
    ? [...archivedSegments, ...materializedSegments]
    : [...archivedSegments, ...plannedSegments];
  const plannedSnapshotSegments = buildSnapshotArchiveSegments(policy, snapshotCandidates);
  const materializedSnapshotSegments = policy.mode === "archive" || policy.mode === "compact"
    ? await materializeSnapshotArchiveSegments(repoRoot, plannedSnapshotSegments, policy.mode)
    : [];
  const snapshotManifestSegments = policy.mode === "archive" || policy.mode === "compact"
    ? [...archivedSnapshotSegments, ...materializedSnapshotSegments]
    : [...archivedSnapshotSegments, ...plannedSnapshotSegments];

  let hotClaimHistory = [...claimHistory];
  let hotVerificationHistory = [...verificationHistory];
  const compactedRunIds = policy.mode === "compact"
    ? new Set([
      ...archivedSegments.flatMap((segment) => segment.runIds),
      ...materializedSegments.flatMap((segment) => segment.runIds),
    ])
    : new Set<string>();
  if (latestRunId) {
    compactedRunIds.delete(latestRunId);
  }
  if (policy.mode === "compact" && compactedRunIds.size > 0) {
    hotClaimHistory = hotClaimHistory.filter((entry) => !compactedRunIds.has(entry.runId));
    hotVerificationHistory = hotVerificationHistory.filter((entry) => !compactedRunIds.has(entry.runId));
    await writeCompactedHotHistory(repoRoot, publishRuns, hotClaimHistory, hotVerificationHistory);
  }

  const compactedSnapshotIds = policy.mode === "compact"
    ? new Set([
      ...archivedSnapshotSegments.map((segment) => segment.snapshotId),
      ...materializedSnapshotSegments.map((segment) => segment.snapshotId),
    ])
    : new Set<string>();
  if (policy.mode === "compact" && compactedSnapshotIds.size > 0) {
    await compactHotSnapshots(repoRoot, compactedSnapshotIds);
  }

  await cleanupArchiveSegmentFiles(repoRoot, manifestSegments);
  await cleanupSnapshotArchiveFiles(repoRoot, snapshotManifestSegments);

  const hotUsage = policy.mode === "compact"
    ? await measureHotHistoryUsage(repoRoot)
    : initialHotUsage;
  const { bytes: archiveBytes } = await measureDirectoryTree(resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.archiveSegments));
  const postSyncSnapshotHotRecords = policy.mode === "compact"
    ? await collectHotSnapshotRecords(repoRoot, activeSnapshotIds)
    : hotSnapshotRecords;
  const snapshotHotUsage = policy.mode === "compact"
    ? summarizeHotSnapshotUsage(postSyncSnapshotHotRecords)
    : initialSnapshotHotUsage;
  const { bytes: snapshotArchiveBytes } = await measureDirectoryTree(
    resolveCodemapPath(repoRoot, CODEMAP_DIRECTORIES.archiveSnapshotSegments),
  );
  const totalBytes = hotUsage.hotBytes + archiveBytes;
  const manifest = normalizeArchiveManifest({
    version: 1,
    generatedAt,
    mode: policy.mode,
    segments: manifestSegments,
  }, generatedAt);
  await writeHistoryArchiveManifest(repoRoot, manifest);
  const snapshotManifest = normalizeSnapshotArchiveManifest({
    version: 1,
    generatedAt,
    mode: policy.mode,
    segments: snapshotManifestSegments,
  }, generatedAt);
  await writeSnapshotArchiveManifest(repoRoot, snapshotManifest);
  const archivedBundles = await readArchivedBundles(
    repoRoot,
    manifest.segments.filter((segment) => segment.state === "archived").map((segment) => segment.id),
  );
  await writeArchiveIndexes(repoRoot, generatedAt, archivedBundles);
  await writeJsonFile(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.archiveSnapshotIndex),
    buildSnapshotArchiveIndex(
      generatedAt,
      snapshotManifest.segments.filter((segment) => segment.state === "archived"),
    ),
  );

  const warnAtBytes = policy.maxHotBytes === undefined ? undefined : Math.floor(policy.maxHotBytes * policy.warnAtPercent);
  const warningThresholdExceeded = warnAtBytes === undefined ? false : hotUsage.hotBytes >= warnAtBytes;
  const overBudget = policy.maxHotBytes === undefined ? false : hotUsage.hotBytes > policy.maxHotBytes;
  const remainingArchiveCandidates = policy.mode === "observe" ? candidateRuns : [];
  const reclaimedHotBytes = Math.max(initialHotUsage.hotBytes - hotUsage.hotBytes, 0);
  const notes = [
    policy.mode === "compact"
      ? "Compact mode keeps the active history lean while relying on archive bundles as the durable source for older runs."
      : policy.preserveFullLedgers
      ? "Append-only history ledgers remain local by policy, so archive planning currently targets partition files before ledger bytes."
      : "History ledgers may be eligible for future compaction once archive execution is enabled.",
  ];
  if (warningThresholdExceeded) {
    notes.push("History hot storage crossed the configured warning threshold.");
  }
  if (overBudget) {
    notes.push(`History hot storage exceeded the configured budget of ${policy.maxHotBytes} bytes.`);
  }
  if (policy.mode === "observe" && candidateRuns.length > 0) {
    notes.push("Archive candidates were identified, but policy mode is observe so no history was moved.");
  }
  if (policy.mode === "archive" && materializedSegments.length > 0) {
    notes.push("Archive mode materialized compressed segment bundles while leaving active history untouched.");
  }
  if (policy.mode === "archive" && overBudget) {
    notes.push("Archive mode currently preserves hot history in place, so archive bundles improve deep-dive durability but do not reclaim hot bytes yet.");
  }
  if (policy.mode === "compact" && compactedRunIds.size > 0) {
    notes.push(`Compact mode reclaimed ${reclaimedHotBytes} hot-history bytes by moving ${compactedRunIds.size} archived run(s) out of the active history path.`);
  }
  if (policy.mode === "compact" && latestRunId) {
    notes.push("The newest publish run remains hot by policy so recent deep dives stay fast.");
  }
  if (policy.mode === "compact" && overBudget) {
    notes.push("Compact mode removed archived run history from the hot path, but remaining hot bytes still exceed budget due to the current run and active metadata.");
  }
  if (candidateRuns.length === 0 && overBudget && policy.mode !== "archive") {
    notes.push("No reclaimable run partitions were identified even though the hot history budget was exceeded.");
  }
  if (hotUsage.byRunPartitionBytes > 0 && hotUsage.byClaimPartitionBytes > 0) {
    notes.push("History is intentionally duplicated across by-claim and by-run partitions to optimize deep dives.");
  }
  if (policy.mode === "observe" && snapshotCandidates.length > 0) {
    notes.push("Historical snapshots were identified, but policy mode is observe so hot snapshot files were retained.");
  }
  if (policy.mode === "archive" && materializedSnapshotSegments.length > 0) {
    notes.push("Archive mode materialized compressed snapshot bundles while leaving hot snapshot files untouched.");
  }
  if (policy.mode === "compact" && compactedSnapshotIds.size > 0) {
    const reclaimedSnapshotBytes = Math.max(initialSnapshotHotUsage.historicalBytes - snapshotHotUsage.historicalBytes, 0);
    notes.push(`Compact mode reclaimed ${reclaimedSnapshotBytes} hot snapshot bytes by moving ${compactedSnapshotIds.size} historical snapshot(s) out of the hot path.`);
  }

  const status: HistoryStorageStatus = {
    version: 1,
    generatedAt,
    policy,
    usage: {
      hotBytes: hotUsage.hotBytes,
      totalBytes,
      ledgerBytes: hotUsage.ledgerBytes,
      metadataBytes: hotUsage.metadataBytes,
      byClaimPartitionBytes: hotUsage.byClaimPartitionBytes,
      byRunPartitionBytes: hotUsage.byRunPartitionBytes,
      archiveBytes,
    },
    counts: {
      claimHistoryEntries: hotClaimHistory.length,
      verificationHistoryEntries: hotVerificationHistory.length,
      publishRuns: publishRuns.length,
      claimPartitions: hotUsage.claimPartitionFiles,
      verificationPartitions: hotUsage.verificationPartitionFiles,
      runClaimPartitions: hotUsage.runClaimPartitionFiles,
      runVerificationPartitions: hotUsage.runVerificationPartitionFiles,
      archivedSegments: manifest.segments.filter((segment) => segment.state === "archived").length,
      plannedSegments: manifest.segments.filter((segment) => segment.state === "planned").length,
    },
    budget: {
      maxHotBytes: policy.maxHotBytes,
      targetHotBytes: policy.targetHotBytes,
      warnAtPercent: policy.warnAtPercent,
      warnAtBytes,
      warningThresholdExceeded,
      overBudget,
    },
    archiveCandidates: remainingArchiveCandidates,
    snapshotStorage: {
      hotBytes: snapshotHotUsage.hotBytes,
      archiveBytes: snapshotArchiveBytes,
      totalBytes: snapshotHotUsage.hotBytes + snapshotArchiveBytes,
      activeSnapshots: snapshotHotUsage.activeSnapshots,
      historicalHotSnapshots: snapshotHotUsage.historicalHotSnapshots,
      archivedSnapshots: snapshotManifest.segments.filter((segment) => segment.state === "archived").length,
      plannedSnapshots: snapshotManifest.segments.filter((segment) => segment.state === "planned").length,
    },
    snapshotArchiveCandidates: policy.mode === "observe" ? snapshotCandidates : [],
    notes,
  };

  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.historyStorageStatus), status);

  return {
    policy,
    manifest,
    status,
  };
}
