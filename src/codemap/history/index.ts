import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { makeHashedCodemapId } from "../model/ids.js";
import { CODEMAP_DIRECTORIES, CODEMAP_FILES } from "../model/layout.js";
import type {
  Claim,
  ClaimHistoryEntry,
  HistoryPartitionIndex,
  HistoryPartitionIndexEntry,
  HistoryRunIndex,
  HistoryRunIndexEntry,
  PublishRunRecord,
  VerificationHistoryEntry,
  VerificationRecord,
} from "../model/types.js";
import { readJsonFile, readNdjsonFile, resolveCodemapPath, writeJsonFile, writeNdjsonFile } from "../store/fs.js";
import {
  readArchivedClaimHistoryByClaimId,
  readArchivedClaimHistoryByRunId,
  readArchivedVerificationHistoryByClaimId,
  readArchivedVerificationHistoryByRunId,
} from "./policy.js";

interface CreatePublishRunRecordInput {
  createdAt: string;
  trigger: PublishRunRecord["trigger"];
  refreshMode: PublishRunRecord["refreshMode"];
  changedFiles?: string[];
  impactedClaimTypes?: Claim["type"][];
  targetedSourcePaths?: string[];
  claims: number;
  verificationRecords: number;
  conflicts: number;
}

interface BuildVerificationHistoryEntriesInput {
  runId: string;
  claims: Claim[];
  records: VerificationRecord[];
  previousRecords?: VerificationRecord[];
}

interface BuildClaimHistoryEntriesInput {
  runId: string;
  claims: Claim[];
  previousClaims?: Claim[];
  createdAt: string;
}

function normalizePaths(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.replace(/\\/g, "/")).filter(Boolean))].sort();
}

function compareVerificationHistory(left: VerificationHistoryEntry, right: VerificationHistoryEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function comparePublishRuns(left: PublishRunRecord, right: PublishRunRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareClaimHistory(left: ClaimHistoryEntry, right: ClaimHistoryEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function dedupeClaimHistoryEntries(entries: ClaimHistoryEntry[]): ClaimHistoryEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort(compareClaimHistory);
}

function dedupeVerificationHistoryEntries(entries: VerificationHistoryEntry[]): VerificationHistoryEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort(compareVerificationHistory);
}

function compareHistoryIndexEntry(left: HistoryPartitionIndexEntry, right: HistoryPartitionIndexEntry): number {
  return left.claimId.localeCompare(right.claimId);
}

function compareRunIndexEntry(left: HistoryRunIndexEntry, right: HistoryRunIndexEntry): number {
  return left.createdAt.localeCompare(right.createdAt) || left.runId.localeCompare(right.runId);
}

function sameSnapshotIds(left: string[] = [], right: string[] = []): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function sameTags(left: string[] = [], right: string[] = []): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function makeHistoryPartitionBasename(claimId: string): string {
  return `${createHash("sha256").update(claimId).digest("hex")}.ndjson`;
}

function makeRunHistoryPartitionBasename(runId: string): string {
  return `${createHash("sha256").update(runId).digest("hex")}.ndjson`;
}

export function getClaimHistoryPartitionFile(claimId: string): string {
  return `${CODEMAP_DIRECTORIES.historyClaimPartitions}/${makeHistoryPartitionBasename(claimId)}`;
}

export function getVerificationHistoryPartitionFile(claimId: string): string {
  return `${CODEMAP_DIRECTORIES.historyVerificationPartitions}/${makeHistoryPartitionBasename(claimId)}`;
}

export function getClaimRunHistoryPartitionFile(runId: string): string {
  return `${CODEMAP_DIRECTORIES.historyRunClaimPartitions}/${makeRunHistoryPartitionBasename(runId)}`;
}

export function getVerificationRunHistoryPartitionFile(runId: string): string {
  return `${CODEMAP_DIRECTORIES.historyRunVerificationPartitions}/${makeRunHistoryPartitionBasename(runId)}`;
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
      .sort(comparePublishRuns)
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
      .sort(compareRunIndexEntry),
  };
}

export function createPublishRunRecord(input: CreatePublishRunRecordInput): PublishRunRecord {
  const changedFiles = normalizePaths(input.changedFiles);
  const impactedClaimTypes = [...new Set(input.impactedClaimTypes ?? [])].sort();
  const targetedSourcePaths = normalizePaths(input.targetedSourcePaths);

  return {
    id: makeHashedCodemapId("publish", [
      input.createdAt,
      input.trigger,
      input.refreshMode,
      ...changedFiles,
      ...impactedClaimTypes,
      ...targetedSourcePaths,
    ]),
    createdAt: input.createdAt,
    trigger: input.trigger,
    refreshMode: input.refreshMode,
    changedFiles,
    impactedClaimTypes,
    targetedSourcePaths,
    claims: input.claims,
    verificationRecords: input.verificationRecords,
    conflicts: input.conflicts,
  };
}

export function buildVerificationHistoryEntries(
  input: BuildVerificationHistoryEntriesInput,
): VerificationHistoryEntry[] {
  const claimsById = new Map(input.claims.map((claim) => [claim.id, claim]));
  const previousByKey = new Map<string, VerificationRecord>();
  for (const record of input.previousRecords ?? []) {
    previousByKey.set(`${record.claimId}:${record.verifier}`, record);
  }

  return [...new Map(input.records.map((record) => [record.id, record])).values()]
    .map((record) => {
      const claim = claimsById.get(record.claimId);
      const previous = previousByKey.get(`${record.claimId}:${record.verifier}`);
      const transition = !previous
        ? "initial"
        : previous.outcome === record.outcome
          && previous.reason === record.reason
          && sameSnapshotIds(previous.snapshotIdsChecked, record.snapshotIdsChecked)
          ? "revalidated"
          : "changed";

      return {
        ...record,
        runId: input.runId,
        transition,
        claimType: claim?.type,
        claimSubject: claim?.subject,
        claimStatus: claim?.status,
        previousRecordId: previous?.id,
        previousOutcome: previous?.outcome,
        previousReason: previous?.reason,
        previousCreatedAt: previous?.createdAt,
        previousSnapshotIdsChecked: previous?.snapshotIdsChecked ? [...previous.snapshotIdsChecked].sort() : undefined,
      } satisfies VerificationHistoryEntry;
    })
    .sort(compareVerificationHistory);
}

export function buildClaimHistoryEntries(
  input: BuildClaimHistoryEntriesInput,
): ClaimHistoryEntry[] {
  const previousById = new Map((input.previousClaims ?? []).map((claim) => [claim.id, claim]));

  return [...new Map(input.claims.map((claim) => [claim.id, claim])).values()]
    .map((claim) => {
      const previous = previousById.get(claim.id);
      const transition = !previous
        ? "initial"
        : previous.status !== claim.status
          ? "status_changed"
          : previous.subject !== claim.subject
            || previous.supportScore !== claim.supportScore
            || previous.publicationConfidence !== claim.publicationConfidence
            || !sameSnapshotIds(previous.sourceSnapshotIds, claim.sourceSnapshotIds)
            || !sameSnapshotIds(previous.evidenceSpanIds, claim.evidenceSpanIds)
            || !sameTags(previous.tags, claim.tags)
            ? "revised"
            : "revalidated";

      return {
        id: makeHashedCodemapId("history", [
          "claim",
          input.runId,
          claim.id,
          input.createdAt,
          transition,
        ]),
        runId: input.runId,
        claimId: claim.id,
        claimType: claim.type,
        subject: claim.subject,
        status: claim.status,
        createdAt: input.createdAt,
        transition,
        supportScore: claim.supportScore,
        publicationConfidence: claim.publicationConfidence,
        sourceSnapshotIds: [...claim.sourceSnapshotIds].sort(),
        evidenceSpanIds: [...claim.evidenceSpanIds].sort(),
        tags: [...claim.tags].sort(),
        previousStatus: previous?.status,
        previousSubject: previous?.subject,
        previousCreatedAt: previous ? previous.lastVerifiedAt ?? previous.firstSeenAt : undefined,
        previousSupportScore: previous?.supportScore,
        previousPublicationConfidence: previous?.publicationConfidence,
        previousSourceSnapshotIds: previous?.sourceSnapshotIds ? [...previous.sourceSnapshotIds].sort() : undefined,
        previousEvidenceSpanIds: previous?.evidenceSpanIds ? [...previous.evidenceSpanIds].sort() : undefined,
        previousTags: previous?.tags ? [...previous.tags].sort() : undefined,
      } satisfies ClaimHistoryEntry;
    })
    .sort(compareClaimHistory);
}

export async function readVerificationHistory(repoRoot: string): Promise<VerificationHistoryEntry[]> {
  const rows = await readNdjsonFile<VerificationHistoryEntry>(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.verificationHistoryNdjson),
  );
  return rows.sort(compareVerificationHistory);
}

export async function readClaimHistory(repoRoot: string): Promise<ClaimHistoryEntry[]> {
  const rows = await readNdjsonFile<ClaimHistoryEntry>(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.claimHistoryNdjson),
  );
  return rows.sort(compareClaimHistory);
}

export async function readVerificationHistoryIndex(repoRoot: string): Promise<HistoryPartitionIndex | null> {
  return readJsonFile<HistoryPartitionIndex>(resolveCodemapPath(repoRoot, CODEMAP_FILES.verificationHistoryIndex));
}

export async function readClaimHistoryIndex(repoRoot: string): Promise<HistoryPartitionIndex | null> {
  return readJsonFile<HistoryPartitionIndex>(resolveCodemapPath(repoRoot, CODEMAP_FILES.claimHistoryIndex));
}

export async function readRunHistoryIndex(repoRoot: string): Promise<HistoryRunIndex | null> {
  return readJsonFile<HistoryRunIndex>(resolveCodemapPath(repoRoot, CODEMAP_FILES.publishRunsIndex));
}

export async function readVerificationHistoryByClaimId(
  repoRoot: string,
  claimId: string,
): Promise<VerificationHistoryEntry[]> {
  const partitionRows = await readNdjsonFile<VerificationHistoryEntry>(
    resolveCodemapPath(repoRoot, getVerificationHistoryPartitionFile(claimId)),
  );
  const localRows = partitionRows.length > 0
    ? partitionRows
    : (await readVerificationHistory(repoRoot)).filter((entry) => entry.claimId === claimId);
  const archivedRows = await readArchivedVerificationHistoryByClaimId(repoRoot, claimId);
  return dedupeVerificationHistoryEntries([...localRows, ...archivedRows]);
}

export async function readClaimHistoryByClaimId(
  repoRoot: string,
  claimId: string,
): Promise<ClaimHistoryEntry[]> {
  const partitionRows = await readNdjsonFile<ClaimHistoryEntry>(
    resolveCodemapPath(repoRoot, getClaimHistoryPartitionFile(claimId)),
  );
  const localRows = partitionRows.length > 0
    ? partitionRows
    : (await readClaimHistory(repoRoot)).filter((entry) => entry.claimId === claimId);
  const archivedRows = await readArchivedClaimHistoryByClaimId(repoRoot, claimId);
  return dedupeClaimHistoryEntries([...localRows, ...archivedRows]);
}

export async function readVerificationHistoryByRunId(
  repoRoot: string,
  runId: string,
): Promise<VerificationHistoryEntry[]> {
  const partitionRows = await readNdjsonFile<VerificationHistoryEntry>(
    resolveCodemapPath(repoRoot, getVerificationRunHistoryPartitionFile(runId)),
  );
  const localRows = partitionRows.length > 0
    ? partitionRows
    : (await readVerificationHistory(repoRoot)).filter((entry) => entry.runId === runId);
  const archivedRows = await readArchivedVerificationHistoryByRunId(repoRoot, runId);
  return dedupeVerificationHistoryEntries([...localRows, ...archivedRows]);
}

export async function readClaimHistoryByRunId(
  repoRoot: string,
  runId: string,
): Promise<ClaimHistoryEntry[]> {
  const partitionRows = await readNdjsonFile<ClaimHistoryEntry>(
    resolveCodemapPath(repoRoot, getClaimRunHistoryPartitionFile(runId)),
  );
  const localRows = partitionRows.length > 0
    ? partitionRows
    : (await readClaimHistory(repoRoot)).filter((entry) => entry.runId === runId);
  const archivedRows = await readArchivedClaimHistoryByRunId(repoRoot, runId);
  return dedupeClaimHistoryEntries([...localRows, ...archivedRows]);
}

export async function writeVerificationHistory(
  repoRoot: string,
  entries: VerificationHistoryEntry[],
): Promise<void> {
  const dedupedEntries = [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort(compareVerificationHistory);
  await writeNdjsonFile(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.verificationHistoryNdjson),
    dedupedEntries,
  );
  await writeHistoryPartitions(
    repoRoot,
    dedupedEntries,
    CODEMAP_DIRECTORIES.historyVerificationPartitions,
    getVerificationHistoryPartitionFile,
    CODEMAP_FILES.verificationHistoryIndex,
    compareVerificationHistory,
  );
}

export async function writeClaimHistory(repoRoot: string, entries: ClaimHistoryEntry[]): Promise<void> {
  const dedupedEntries = [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort(compareClaimHistory);
  await writeNdjsonFile(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.claimHistoryNdjson),
    dedupedEntries,
  );
  await writeHistoryPartitions(
    repoRoot,
    dedupedEntries,
    CODEMAP_DIRECTORIES.historyClaimPartitions,
    getClaimHistoryPartitionFile,
    CODEMAP_FILES.claimHistoryIndex,
    compareClaimHistory,
  );
}

export async function readPublishRuns(repoRoot: string): Promise<PublishRunRecord[]> {
  const rows = await readNdjsonFile<PublishRunRecord>(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.publishRunsNdjson),
  );
  return rows.sort(comparePublishRuns);
}

export async function writePublishRuns(repoRoot: string, runs: PublishRunRecord[]): Promise<void> {
  const dedupedRuns = [...new Map(runs.map((run) => [run.id, run])).values()].sort(comparePublishRuns);
  await writeNdjsonFile(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.publishRunsNdjson),
    dedupedRuns,
  );
}

export async function writeRunHistoryIndexAndPartitions(
  repoRoot: string,
  runs: PublishRunRecord[],
  claimHistoryEntries: ClaimHistoryEntry[],
  verificationHistoryEntries: VerificationHistoryEntry[],
): Promise<void> {
  const claimEntriesByRun = new Map<string, ClaimHistoryEntry[]>();
  const verificationEntriesByRun = new Map<string, VerificationHistoryEntry[]>();

  for (const entry of claimHistoryEntries) {
    if (!claimEntriesByRun.has(entry.runId)) {
      claimEntriesByRun.set(entry.runId, []);
    }
    claimEntriesByRun.get(entry.runId)!.push(entry);
  }
  for (const entry of verificationHistoryEntries) {
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
    buildRunHistoryIndex(runs, claimHistoryEntries, verificationHistoryEntries),
  );
}

export * from "./policy.js";
