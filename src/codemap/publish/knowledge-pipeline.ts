import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectKnowledge } from "../../detectors/knowledge.js";
import {
  buildClaimHistoryEntries,
  buildVerificationHistoryEntries,
  createPublishRunRecord,
  readClaimHistory,
  readPublishRuns,
  readVerificationHistory,
  syncHistoryStoragePolicy,
  writeClaimHistory,
  writePublishRuns,
  writeRunHistoryIndexAndPartitions,
  writeVerificationHistory,
} from "../history/index.js";
import { compareCompatibilityKnowledge } from "../migration/compatibility-parity.js";
import { renderCompatibilityKnowledge } from "../render/views/compatibility-knowledge.js";
import { renderKnowledgeViews } from "../render/views/knowledge.js";
import type {
  Claim,
  ConflictEdge,
  EvidenceSpan,
  HistoryArchiveManifest,
  HistoryStorageStatus,
  PublishIncident,
  PublishPlan,
  RenderedView,
  SourceSnapshot,
  VerificationRecord,
} from "../model/types.js";
import { CODEMAP_FILES, CODEMAP_ROOT_DIR } from "../model/layout.js";
import { makeHashedCodemapId } from "../model/ids.js";
import { extractKnowledgeClaimGraph } from "../extract/knowledge/index.js";
import {
  buildCodemapRefreshPlan,
  buildCodemapScanState,
  writeCodemapRefreshPlan,
  writeCodemapScanState,
  type CodemapRefreshPlan,
  type CodemapScanState,
  type CodemapTrigger,
} from "../runtime/index.js";
import { writeCodemapPublishPlan } from "./plans.js";
import {
  buildClaimHealthIncidents,
  DEFAULT_CRITICAL_KNOWLEDGE_CLAIM_TYPES,
} from "./claim-health-incidents.js";
import { ensureCodemapLayout, resolveCodemapPath, writeJsonFile, writeNdjsonFile } from "../store/fs.js";
import { FileClaimStore } from "../store/claims-store.js";
import { FileConflictStore } from "../store/conflict-store.js";
import { FileEvidenceStore } from "../store/evidence-store.js";
import { FileSnapshotStore } from "../store/snapshots-store.js";
import { FileVerificationStore } from "../store/verification-store.js";
import { verifyKnowledgeClaims } from "../verify/verify-knowledge.js";

export interface KnowledgeCodemapPublishResult {
  outputRoot: string;
  snapshots: number;
  claims: number;
  evidence: number;
  verificationRecords: number;
  conflicts: number;
  knowledgeSnapshots: number;
  knowledgeClaims: number;
  knowledgeEvidence: number;
  views: RenderedView[];
  compatibilityViews: RenderedView[];
  compatibilityParity: Awaited<ReturnType<typeof compareCompatibilityKnowledge>>["report"];
  incidents: PublishIncident[];
  refreshPlan: CodemapRefreshPlan;
  scanState: CodemapScanState;
  historyArchiveManifest: HistoryArchiveManifest;
  historyStorage: HistoryStorageStatus;
}

export interface KnowledgeCodemapPublishOptions {
  changedFiles?: string[];
  outputDirName?: string;
  trigger?: CodemapTrigger;
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function isKnowledgeClaimType(type: Claim["type"]): boolean {
  return type.startsWith("knowledge_");
}

function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function claimIntersectsSourcePaths(
  claim: Claim,
  snapshotsById: Map<string, SourceSnapshot>,
  sourcePaths: Set<string> | null,
): boolean {
  if (!sourcePaths) {
    return true;
  }

  return claim.sourceSnapshotIds.some((snapshotId) => {
    const sourcePath = snapshotsById.get(snapshotId)?.sourcePath;
    return sourcePath ? sourcePaths.has(normalizeSourcePath(sourcePath)) : false;
  });
}

function createVerificationRecord(
  claimId: string,
  verifier: VerificationRecord["verifier"],
  outcome: VerificationRecord["outcome"],
  reason: string,
  snapshotIdsChecked: string[],
  createdAt: string,
): VerificationRecord {
  return {
    id: makeHashedCodemapId("verification", [claimId, verifier, createdAt, reason, ...snapshotIdsChecked]),
    claimId,
    verifier,
    outcome,
    reason,
    createdAt,
    snapshotIdsChecked,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeViews(repoRoot: string, views: RenderedView[]): Promise<void> {
  for (const view of views) {
    await writeFile(resolveCodemapPath(repoRoot, view.path), view.markdown, "utf-8");
  }
}

async function invalidateMissingKnowledgeClaims(
  repoRoot: string,
  existingClaims: Claim[],
  existingSnapshots: Map<string, SourceSnapshot>,
  authoritativeSourcePaths: Set<string> | null,
  currentClaims: Claim[],
  createdAt: string,
): Promise<{ claims: Claim[]; verification: VerificationRecord[]; staleSnapshotIds: string[] }> {
  const currentClaimIds = new Set(currentClaims.map((claim) => claim.id));
  const staleClaims: Claim[] = [];
  const staleVerification: VerificationRecord[] = [];
  const staleSnapshotIds = new Set<string>();

  for (const existingClaim of existingClaims) {
    if (!isKnowledgeClaimType(existingClaim.type)) {
      continue;
    }
    if (!claimIntersectsSourcePaths(existingClaim, existingSnapshots, authoritativeSourcePaths)) {
      continue;
    }
    if (currentClaimIds.has(existingClaim.id)) {
      continue;
    }

    const snapshotIdsChecked = existingClaim.sourceSnapshotIds.slice().sort();
    let missingSource = snapshotIdsChecked.length === 0;

    for (const snapshotId of snapshotIdsChecked) {
      staleSnapshotIds.add(snapshotId);
      const snapshot = existingSnapshots.get(snapshotId);
      if (!snapshot) {
        missingSource = true;
        continue;
      }
      if (!await pathExists(join(repoRoot, snapshot.sourcePath))) {
        missingSource = true;
      }
    }

    const discoveryReason = missingSource
      ? "knowledge note is missing from the current workspace"
      : "knowledge claim was not rediscovered during the current note extraction pass";
    const hashReason = missingSource
      ? "knowledge note is missing so the snapshot can no longer be verified"
      : "knowledge note content drifted away from the previously extracted claim";
    const supportReason = missingSource
      ? "knowledge note is missing so the claim has no remaining supporting source"
      : "knowledge claim no longer has matching note-backed evidence";

    staleClaims.push({
      ...existingClaim,
      status: "stale",
      lastVerifiedAt: createdAt,
    });
    staleVerification.push(createVerificationRecord(
      existingClaim.id,
      "line-exists",
      "fail",
      discoveryReason,
      snapshotIdsChecked,
      createdAt,
    ));
    staleVerification.push(createVerificationRecord(
      existingClaim.id,
      "hash-match",
      "fail",
      hashReason,
      snapshotIdsChecked,
      createdAt,
    ));
    staleVerification.push(createVerificationRecord(
      existingClaim.id,
      "knowledge-support",
      "fail",
      supportReason,
      snapshotIdsChecked,
      createdAt,
    ));
    staleVerification.push(createVerificationRecord(
      existingClaim.id,
      "conflict-check",
      "pass",
      "no knowledge conflicts detected for this stale claim",
      snapshotIdsChecked,
      createdAt,
    ));
  }

  return {
    claims: staleClaims.sort((left, right) => left.id.localeCompare(right.id)),
    verification: staleVerification.sort((left, right) => left.id.localeCompare(right.id)),
    staleSnapshotIds: [...staleSnapshotIds].sort(),
  };
}

function compactCanonicalState(
  snapshots: SourceSnapshot[],
  evidence: EvidenceSpan[],
  claims: Claim[],
  verification: VerificationRecord[],
  conflicts: ConflictEdge[],
) {
  const compactedClaims = uniqueById(claims);
  const activeClaimIds = new Set(compactedClaims.map((claim) => claim.id));
  const referencedSnapshotIds = new Set(compactedClaims.flatMap((claim) => claim.sourceSnapshotIds));
  const referencedEvidenceIds = new Set(compactedClaims.flatMap((claim) => claim.evidenceSpanIds));

  return {
    snapshots: uniqueById(
      snapshots.filter((snapshot) => referencedSnapshotIds.has(snapshot.id)),
    ),
    evidence: uniqueById(
      evidence.filter((entry) => referencedEvidenceIds.has(entry.id) && referencedSnapshotIds.has(entry.snapshotId)),
    ),
    claims: compactedClaims,
    verification: uniqueById(
      verification.filter((record) => activeClaimIds.has(record.claimId)),
    ),
    conflicts: uniqueById(
      conflicts.filter((conflict) => activeClaimIds.has(conflict.claimA) && activeClaimIds.has(conflict.claimB)),
    ),
  };
}

function buildPublishPlan(domain: "code" | "knowledge", claims: Claim[], conflicts: ConflictEdge[]): PublishPlan {
  const conflictIdsByClaimId = new Map<string, string[]>();

  for (const conflict of conflicts) {
    if (!conflictIdsByClaimId.has(conflict.claimA)) {
      conflictIdsByClaimId.set(conflict.claimA, []);
    }
    if (!conflictIdsByClaimId.has(conflict.claimB)) {
      conflictIdsByClaimId.set(conflict.claimB, []);
    }
    conflictIdsByClaimId.get(conflict.claimA)!.push(conflict.id);
    conflictIdsByClaimId.get(conflict.claimB)!.push(conflict.id);
  }

  const generatedAt = claims.map((claim) => claim.lastVerifiedAt ?? claim.firstSeenAt).sort().at(-1) ?? "";
  return {
    domain,
    generatedAt,
    items: claims.map((claim) => {
      const blockingConflictIds = [...new Set(conflictIdsByClaimId.get(claim.id) ?? [])].sort();
      const decision = claim.status === "verified"
        ? blockingConflictIds.length > 0
          ? "republish_with_warning"
          : "publish"
        : claim.status === "inferred"
          ? "republish_with_warning"
          : claim.status === "stale" || claim.status === "quarantined"
            ? "quarantine"
            : "skip";

      const reason = claim.status === "verified"
        ? blockingConflictIds.length > 0
          ? "claim verified against current knowledge snapshots but has conflicts to review"
          : "claim verified against current knowledge snapshots"
        : claim.status === "inferred"
          ? "claim is publishable with an inferred label"
          : "claim is not safe to publish as verified";

      return {
        claimId: claim.id,
        decision,
        reason,
        blockingConflictIds,
      };
    }),
  };
}

function normalizeRepoRelativePaths(repoRoot: string, paths: string[]): string[] {
  const normalizedRoot = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return [...new Set(paths.map((path) => {
    const normalized = path.replace(/\\/g, "/");
    return normalized.startsWith(`${normalizedRoot}/`)
      ? normalized.slice(normalizedRoot.length + 1)
      : normalized;
  }).filter(Boolean))].sort();
}

export async function publishKnowledgeCodemap(
  repoRoot: string,
  files: string[],
  options: KnowledgeCodemapPublishOptions = {},
): Promise<KnowledgeCodemapPublishResult> {
  await ensureCodemapLayout(repoRoot);

  const snapshotStore = new FileSnapshotStore(repoRoot);
  const claimStore = new FileClaimStore(repoRoot);
  const conflictStore = new FileConflictStore(repoRoot);
  const evidenceStore = new FileEvidenceStore(repoRoot);
  const verificationStore = new FileVerificationStore(repoRoot);

  const [existingSnapshots, existingClaims, existingEvidence, existingVerification, existingConflicts] = await Promise.all([
    snapshotStore.list(),
    claimStore.list(),
    evidenceStore.list(),
    verificationStore.list(),
    conflictStore.list(),
  ]);

  const existingKnowledgeClaims = existingClaims.filter((claim) => isKnowledgeClaimType(claim.type));
  const existingKnowledgeSnapshots = existingSnapshots.filter((snapshot) => snapshot.sourceKind === "note");
  const existingSnapshotsById = new Map(existingSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const initialRefreshPlan = buildCodemapRefreshPlan({
    domain: "knowledge",
    generatedAt: new Date().toISOString(),
    trigger: options.trigger ?? "cli",
    changedFiles: options.changedFiles ?? [],
    claims: existingKnowledgeClaims,
    snapshots: existingKnowledgeSnapshots,
  });
  const authoritativeSourcePaths = initialRefreshPlan.mode === "targeted"
    ? new Set(initialRefreshPlan.targetedSourcePaths.map(normalizeSourcePath))
    : null;
  const currentKnowledgeFiles = normalizeRepoRelativePaths(repoRoot, files);
  const currentKnowledgeFileSet = new Set(currentKnowledgeFiles.map(normalizeSourcePath));
  const extractionSourcePaths = authoritativeSourcePaths
    ? [...authoritativeSourcePaths].filter((sourcePath) => currentKnowledgeFileSet.has(sourcePath))
    : [];
  const preservedKnowledgeClaims = authoritativeSourcePaths
    ? existingKnowledgeClaims.filter((claim) => !claimIntersectsSourcePaths(claim, existingSnapshotsById, authoritativeSourcePaths))
    : [];
  const knowledgeMap = await detectKnowledge(files, repoRoot);
  const extracted = authoritativeSourcePaths && extractionSourcePaths.length === 0
    ? { snapshots: [], evidence: [], claims: [] }
    : await extractKnowledgeClaimGraph(
      repoRoot,
      knowledgeMap,
      existingKnowledgeClaims,
      authoritativeSourcePaths ? { sourcePaths: extractionSourcePaths } : {},
    );
  const knowledgeVerification = await verifyKnowledgeClaims(
    repoRoot,
    extracted.claims,
    extracted.evidence,
    extracted.snapshots,
  );
  const invalidationResult = await invalidateMissingKnowledgeClaims(
    repoRoot,
    existingKnowledgeClaims,
    existingSnapshotsById,
    authoritativeSourcePaths,
    knowledgeVerification.claims,
    new Date().toISOString(),
  );
  const preservedClaims = [
    ...existingClaims.filter((claim) => !isKnowledgeClaimType(claim.type)),
    ...preservedKnowledgeClaims,
  ];
  const authoritativeKnowledgeClaimIds = new Set(
    authoritativeSourcePaths
      ? existingKnowledgeClaims
        .filter((claim) => claimIntersectsSourcePaths(claim, existingSnapshotsById, authoritativeSourcePaths))
        .map((claim) => claim.id)
      : existingKnowledgeClaims.map((claim) => claim.id),
  );
  const preservedConflicts = existingConflicts.filter((conflict) =>
    !authoritativeKnowledgeClaimIds.has(conflict.claimA) && !authoritativeKnowledgeClaimIds.has(conflict.claimB)
  );
  const rawState = compactCanonicalState(
    [
      ...existingSnapshots,
      ...extracted.snapshots,
      ...existingSnapshots.filter((snapshot) => invalidationResult.staleSnapshotIds.includes(snapshot.id)),
    ],
    [...existingEvidence, ...extracted.evidence],
    [...preservedClaims, ...knowledgeVerification.claims, ...invalidationResult.claims],
    [...existingVerification, ...knowledgeVerification.verification, ...invalidationResult.verification],
    [...preservedConflicts, ...knowledgeVerification.conflicts],
  );

  const generatedAt = rawState.claims
    .map((claim) => claim.lastVerifiedAt ?? claim.firstSeenAt)
    .sort()
    .at(-1) ?? new Date().toISOString();
  const publishPlan = {
    ...buildPublishPlan("knowledge", rawState.claims, rawState.conflicts),
    generatedAt,
  };
  const renderedViews = renderKnowledgeViews(rawState.claims, rawState.snapshots, rawState.conflicts, generatedAt);
  const compatibilityViews = renderCompatibilityKnowledge({
    projectName: knowledgeMap.projects[0] ?? "Knowledge Map",
    claims: rawState.claims,
    conflicts: rawState.conflicts,
    snapshots: rawState.snapshots,
    generatedAt,
  });

  await snapshotStore.replace(rawState.snapshots);
  await evidenceStore.replace(rawState.evidence);
  await claimStore.replace(rawState.claims);
  await verificationStore.replace(rawState.verification);
  await conflictStore.replace(rawState.conflicts);
  await writeCodemapPublishPlan(repoRoot, publishPlan);

  const currentRunClaims = uniqueById([
    ...knowledgeVerification.claims,
    ...invalidationResult.claims,
  ]);
  const currentRunVerificationRecords = uniqueById([
    ...knowledgeVerification.verification,
    ...invalidationResult.verification,
  ]);
  const currentRunClaimIds = new Set(currentRunClaims.map((claim) => claim.id));
  const currentRunCompactedClaims = rawState.claims.filter((claim) => currentRunClaimIds.has(claim.id));
  const finalKnowledgeClaims = rawState.claims.filter((claim) => isKnowledgeClaimType(claim.type));
  const finalKnowledgeSnapshots = rawState.snapshots.filter((snapshot) => snapshot.sourceKind === "note");
  const refreshPlan = buildCodemapRefreshPlan({
    domain: "knowledge",
    generatedAt,
    trigger: options.trigger ?? "cli",
    changedFiles: options.changedFiles ?? [],
    claims: finalKnowledgeClaims,
    snapshots: finalKnowledgeSnapshots,
  });
  const publishRun = createPublishRunRecord({
    createdAt: generatedAt,
    trigger: options.trigger ?? "cli",
    refreshMode: refreshPlan.mode,
    changedFiles: normalizeRepoRelativePaths(repoRoot, options.changedFiles ?? []),
    impactedClaimTypes: refreshPlan.impactedClaimTypes,
    targetedSourcePaths: refreshPlan.targetedSourcePaths,
    claims: rawState.claims.length,
    verificationRecords: currentRunVerificationRecords.length,
    conflicts: rawState.conflicts.length,
  });
  const verificationHistory = [
    ...await readVerificationHistory(repoRoot),
    ...buildVerificationHistoryEntries({
      runId: publishRun.id,
      claims: rawState.claims,
      records: currentRunVerificationRecords,
      previousRecords: existingVerification,
    }),
  ];
  const claimHistory = [
    ...await readClaimHistory(repoRoot),
    ...buildClaimHistoryEntries({
      runId: publishRun.id,
      claims: currentRunCompactedClaims,
      previousClaims: existingClaims,
      createdAt: generatedAt,
    }),
  ];
  const publishRuns = [
    ...await readPublishRuns(repoRoot),
    publishRun,
  ];
  await writeVerificationHistory(repoRoot, verificationHistory);
  await writeClaimHistory(repoRoot, claimHistory);
  await writePublishRuns(repoRoot, publishRuns);
  await writeRunHistoryIndexAndPartitions(repoRoot, publishRuns, claimHistory, verificationHistory);
  const historyStorage = await syncHistoryStoragePolicy(repoRoot, generatedAt);
  const compatibilityParity = await compareCompatibilityKnowledge(repoRoot, compatibilityViews, generatedAt);
  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.compatibilityKnowledgeParity), compatibilityParity.report);
  const claimHealthIncidents = buildClaimHealthIncidents({
    // Scope to knowledge claims so code-domain conflicts preserved through the
    // shared canonical store don't leak into knowledge-incidents.ndjson.
    claims: finalKnowledgeClaims,
    conflicts: rawState.conflicts,
    verification: rawState.verification,
    generatedAt,
    criticalClaimTypes: DEFAULT_CRITICAL_KNOWLEDGE_CLAIM_TYPES,
  });
  const incidents = [...compatibilityParity.incidents, ...claimHealthIncidents]
    .sort((left, right) => left.id.localeCompare(right.id));
  await writeNdjsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.knowledgeIncidentsNdjson), incidents);
  await writeViews(repoRoot, [...renderedViews, ...compatibilityViews]);
  await writeCodemapRefreshPlan(repoRoot, refreshPlan);
  const scanState = buildCodemapScanState({
    domain: "knowledge",
    generatedAt,
    trigger: options.trigger ?? "cli",
    outputDirName: options.outputDirName ?? ".codesight",
    changedFiles: options.changedFiles ?? [],
    claims: rawState.claims.length,
    snapshots: rawState.snapshots.length,
    evidence: rawState.evidence.length,
    verificationRecords: rawState.verification.length,
    conflicts: rawState.conflicts.length,
    incidents: incidents.length,
    views: renderedViews.map((view) => view.path),
    compatibilityViews: compatibilityViews.map((view) => view.path),
    compatibilityParity: {
      legacyWikiPresent: compatibilityParity.report.legacyKnowledgePresent,
      matched: compatibilityParity.report.article.status === "match" ? 1 : 0,
      drifted: compatibilityParity.report.article.status === "drift" ? 1 : 0,
      missingCompatibility: compatibilityParity.report.article.status === "missing_compatibility" ? 1 : 0,
      extraCompatibility: compatibilityParity.report.article.status === "extra_compatibility" ? 1 : 0,
    },
    refresh: {
      mode: refreshPlan.mode,
      impactedClaimTypes: refreshPlan.impactedClaimTypes,
      targetedClaimCount: refreshPlan.targetedClaimCount,
      targetedSourceCount: refreshPlan.targetedSourceCount,
    },
  });
  await writeCodemapScanState(repoRoot, scanState);

  return {
    outputRoot: resolveCodemapPath(repoRoot, CODEMAP_ROOT_DIR),
    snapshots: rawState.snapshots.length,
    claims: rawState.claims.length,
    evidence: rawState.evidence.length,
    verificationRecords: rawState.verification.length,
    conflicts: rawState.conflicts.length,
    knowledgeSnapshots: rawState.snapshots.filter((snapshot) => snapshot.sourceKind === "note").length,
    knowledgeClaims: rawState.claims.filter((claim) => isKnowledgeClaimType(claim.type)).length,
    knowledgeEvidence: rawState.evidence.filter((entry) => entry.labels.includes("knowledge")).length,
    views: renderedViews,
    compatibilityViews,
    compatibilityParity: compatibilityParity.report,
    incidents,
    refreshPlan,
    scanState,
    historyArchiveManifest: historyStorage.manifest,
    historyStorage: historyStorage.status,
  };
}
