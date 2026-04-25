import { stat, writeFile } from "node:fs/promises";
import type { ImportEdge, ScanResult } from "../../types.js";
import { extractComponentClaimGraph } from "../extract/code/components.js";
import { extractConfigClaimGraph } from "../extract/code/config.js";
import { extractEnvClaimGraph } from "../extract/code/env.js";
import { extractHotspotClaimGraph } from "../extract/code/hotspots.js";
import { extractLibraryClaimGraph } from "../extract/code/libs.js";
import { extractMiddlewareClaimGraph } from "../extract/code/middleware.js";
import { extractRouteClaimGraph } from "../extract/code/routes.js";
import { extractSchemaClaimGraph } from "../extract/code/schemas.js";
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
import { compareCompatibilityWiki } from "../migration/compatibility-parity.js";
import { CODEMAP_FILES, CODEMAP_ROOT_DIR } from "../model/layout.js";
import { makeHashedCodemapId } from "../model/ids.js";
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
import { renderCompatibilityWiki } from "../render/views/compatibility-wiki.js";
import { renderCodeViews } from "../render/views/code.js";
import {
  buildCodemapImpactIndex,
  buildCodemapRefreshPlan,
  collectImpactedSourcePaths,
  buildCodemapScanState,
  writeCodemapRefreshPlan,
  writeCodemapScanState,
  type CodemapImpactIndex,
  type CodemapRefreshPlan,
  type CodemapScanState,
  type CodemapTrigger,
} from "../runtime/index.js";
import { writeCodemapPublishPlan } from "./plans.js";
import {
  buildClaimHealthIncidents,
  DEFAULT_CRITICAL_CODE_CLAIM_TYPES,
} from "./claim-health-incidents.js";
import {
  ensureCodemapLayout,
  readJsonFile,
  resolveCodemapPath,
  writeNdjsonFile,
  writeJsonFile,
} from "../store/fs.js";
import { FileClaimStore } from "../store/claims-store.js";
import { FileConflictStore } from "../store/conflict-store.js";
import { FileEvidenceStore } from "../store/evidence-store.js";
import { FileSnapshotStore } from "../store/snapshots-store.js";
import { FileVerificationStore } from "../store/verification-store.js";
import { verifyComponentClaims } from "../verify/verify-component.js";
import { verifyConfigClaims } from "../verify/verify-config.js";
import { verifyEnvClaims } from "../verify/verify-env.js";
import { verifyHotspotClaims } from "../verify/verify-hotspot.js";
import { verifyLibraryClaims } from "../verify/verify-library.js";
import { verifyMiddlewareClaims } from "../verify/verify-middleware.js";
import { verifyRouteClaims } from "../verify/verify-route.js";
import { verifySchemaClaims } from "../verify/verify-schema.js";

export interface CodeCodemapPublishResult {
  outputRoot: string;
  snapshots: number;
  claims: number;
  evidence: number;
  verificationRecords: number;
  conflicts: number;
  views: RenderedView[];
  compatibilityViews: RenderedView[];
  compatibilityParity: Awaited<ReturnType<typeof compareCompatibilityWiki>>["report"];
  incidents: PublishIncident[];
  refreshPlan: CodemapRefreshPlan;
  scanState: CodemapScanState;
  historyArchiveManifest: HistoryArchiveManifest;
  historyStorage: HistoryStorageStatus;
}

export interface CodeCodemapPublishOptions {
  changedFiles?: string[];
  outputDirName?: string;
  trigger?: CodemapTrigger;
}

const CODE_CLAIM_TYPES = new Set<Claim["type"]>([
  "route",
  "model",
  "relation",
  "component",
  "library_module",
  "config_file",
  "package_dependency",
  "env_var",
  "middleware",
  "dependency_hotspot",
]);

const ALL_CODE_CLAIM_TYPES = [...CODE_CLAIM_TYPES].sort();

interface DependencyGraphCache {
  version: 1;
  generatedAt: string;
  edges: ImportEdge[];
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function compareVerificationRecords(left: VerificationRecord, right: VerificationRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compactVerificationRecords(records: VerificationRecord[], claims: Claim[]) {
  const activeClaimIds = new Set(claims.map((claim) => claim.id));
  const latestByKey = new Map<string, VerificationRecord>();

  for (const record of records) {
    if (!activeClaimIds.has(record.claimId)) {
      continue;
    }

    const key = `${record.claimId}:${record.verifier}`;
    const existing = latestByKey.get(key);
    if (!existing || compareVerificationRecords(existing, record) < 0) {
      latestByKey.set(key, record);
    }
  }

  return [...latestByKey.values()].sort(compareVerificationRecords);
}

function compactCanonicalState(
  snapshots: SourceSnapshot[],
  evidence: EvidenceSpan[],
  claims: Claim[],
  verification: VerificationRecord[],
  conflicts: ConflictEdge[],
) {
  const compactedClaims = uniqueById(claims);
  const referencedSnapshotIds = new Set(compactedClaims.flatMap((claim) => claim.sourceSnapshotIds));
  const referencedEvidenceIds = new Set(compactedClaims.flatMap((claim) => claim.evidenceSpanIds));
  const compactedSnapshots = uniqueById(
    snapshots.filter((snapshot) => referencedSnapshotIds.has(snapshot.id)),
  );
  const compactedEvidence = uniqueById(
    evidence.filter((entry) => referencedEvidenceIds.has(entry.id) && referencedSnapshotIds.has(entry.snapshotId)),
  );
  const activeClaimIds = new Set(compactedClaims.map((claim) => claim.id));
  const compactedVerification = compactVerificationRecords(verification, compactedClaims);
  const compactedConflicts = uniqueById(
    conflicts.filter((conflict) => activeClaimIds.has(conflict.claimA) && activeClaimIds.has(conflict.claimB)),
  );

  return {
    snapshots: compactedSnapshots,
    evidence: compactedEvidence,
    claims: compactedClaims,
    verification: compactedVerification,
    conflicts: compactedConflicts,
  };
}

function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeImportEdges(edges: ImportEdge[]): ImportEdge[] {
  return [...new Map(
    edges
      .map((edge) => ({
        from: normalizeSourcePath(edge.from),
        to: normalizeSourcePath(edge.to),
      }))
      .filter((edge) => edge.from.length > 0 && edge.to.length > 0)
      .map((edge) => [`${edge.from}->${edge.to}`, edge] as const)
  ).values()].sort((left, right) =>
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

function createVerificationRecord(
  claimId: string,
  verifier: "line-exists" | "hash-match" | "ast-shape",
  outcome: "pass" | "fail" | "warn",
  reason: string,
  snapshotIdsChecked: string[],
  createdAt: string
) {
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

async function readDependencyGraphCache(repoRoot: string): Promise<ImportEdge[]> {
  const cache = await readJsonFile<DependencyGraphCache>(
    resolveCodemapPath(repoRoot, CODEMAP_FILES.dependencyGraphCache),
  );
  return normalizeImportEdges(cache?.edges ?? []);
}

async function readImpactIndex(repoRoot: string): Promise<CodemapImpactIndex | null> {
  return readJsonFile<CodemapImpactIndex>(resolveCodemapPath(repoRoot, CODEMAP_FILES.impactIndex));
}

async function writeDependencyGraphCache(
  repoRoot: string,
  generatedAt: string,
  edges: ImportEdge[],
): Promise<void> {
  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.dependencyGraphCache), {
    version: 1,
    generatedAt,
    edges: normalizeImportEdges(edges),
  } satisfies DependencyGraphCache);
}

async function writeImpactIndex(repoRoot: string, impactIndex: CodemapImpactIndex): Promise<void> {
  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.impactIndex), impactIndex);
}

async function invalidateMissingClaims(
  repoRoot: string,
  existingClaims: Claim[],
  existingSnapshots: Map<string, { sourcePath: string }>,
  authoritativeClaimTypes: Set<Claim["type"]>,
  authoritativeSourcePathsByClaimType: Map<Claim["type"], Set<string> | null>,
  currentClaims: Claim[],
  createdAt: string
): Promise<{ claims: Claim[]; verification: ReturnType<typeof createVerificationRecord>[]; staleSnapshotIds: string[] }> {
  const currentClaimIds = new Set(currentClaims.map((claim) => claim.id));
  const staleClaims: Claim[] = [];
  const staleVerification: ReturnType<typeof createVerificationRecord>[] = [];
  const staleSnapshotIds = new Set<string>();

  for (const existingClaim of existingClaims) {
    if (!CODE_CLAIM_TYPES.has(existingClaim.type)) {
      continue;
    }
    if (!authoritativeClaimTypes.has(existingClaim.type)) {
      continue;
    }
    const authoritativeSourcePaths = authoritativeSourcePathsByClaimType.get(existingClaim.type) ?? null;
    if (authoritativeSourcePaths) {
      const claimSourcePaths = existingClaim.sourceSnapshotIds
        .map((snapshotId) => existingSnapshots.get(snapshotId)?.sourcePath)
        .filter((sourcePath): sourcePath is string => Boolean(sourcePath));
      const inAuthoritativeScope = claimSourcePaths.some((sourcePath) => authoritativeSourcePaths.has(sourcePath));
      if (!inAuthoritativeScope) {
        continue;
      }
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
      const exists = await pathExists(resolveCodemapPath(repoRoot, snapshot.sourcePath));
      if (!exists) {
        missingSource = true;
      }
    }

    const discoveryReason = missingSource
      ? "claim source file is missing from the current workspace"
      : "claim was not rediscovered during the current extraction pass";
    const hashReason = missingSource
      ? "claim source file is missing so the snapshot can no longer be verified"
      : "claim no longer matches the current extracted code graph";
    const shapeReason = missingSource
      ? "claim evidence cannot be checked because the source file is missing"
      : "claim no longer appears in the current extracted code graph";

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
      "ast-shape",
      "fail",
      shapeReason,
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
          ? "claim verified against current source snapshots but has conflicts to review"
          : "claim verified against current source snapshots"
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

async function writeViews(repoRoot: string, views: RenderedView[]): Promise<void> {
  for (const view of views) {
    await writeFile(resolveCodemapPath(repoRoot, view.path), view.markdown, "utf-8");
  }
}

function selectClaimTypesForRefresh(
  existingClaims: Claim[],
  existingSnapshots: SourceSnapshot[],
  options: CodeCodemapPublishOptions
) {
  const refreshPlan = buildCodemapRefreshPlan({
    generatedAt: new Date().toISOString(),
    trigger: options.trigger ?? "cli",
    changedFiles: options.changedFiles ?? [],
    claims: existingClaims,
    snapshots: existingSnapshots,
  });

  const selectedClaimTypes = refreshPlan.mode === "full" || refreshPlan.impactedClaimTypes.length === 0
    ? [...ALL_CODE_CLAIM_TYPES]
    : refreshPlan.impactedClaimTypes.filter((claimType) => CODE_CLAIM_TYPES.has(claimType));

  return {
    refreshPlan,
    selectedClaimTypes,
    selectedClaimTypeSet: new Set(selectedClaimTypes),
  };
}

export async function publishCodeCodemap(
  result: ScanResult,
  options: CodeCodemapPublishOptions = {}
): Promise<CodeCodemapPublishResult> {
  const repoRoot = result.project.root;
  await ensureCodemapLayout(repoRoot);

  const snapshotStore = new FileSnapshotStore(repoRoot);
  const claimStore = new FileClaimStore(repoRoot);
  const conflictStore = new FileConflictStore(repoRoot);
  const evidenceStore = new FileEvidenceStore(repoRoot);
  const verificationStore = new FileVerificationStore(repoRoot);
  const existingClaims = await claimStore.list();
  const existingSnapshotsList = await snapshotStore.list();
  const existingEvidence = await evidenceStore.list();
  const existingVerification = await verificationStore.list();
  const existingConflicts = await conflictStore.list();
  const existingImpactIndex = await readImpactIndex(repoRoot);
  const previousGraphEdges = existingImpactIndex?.sourceEdges ?? await readDependencyGraphCache(repoRoot);
  const existingSnapshots = new Map(existingSnapshotsList.map((snapshot) => [snapshot.id, snapshot]));
  const refreshSelection = selectClaimTypesForRefresh(existingClaims, existingSnapshotsList, options);
  const selectedClaimTypeSet = refreshSelection.selectedClaimTypeSet;

  const runRouteLane = selectedClaimTypeSet.has("route");
  const runSchemaLane = selectedClaimTypeSet.has("model") || selectedClaimTypeSet.has("relation");
  const runComponentLane = selectedClaimTypeSet.has("component");
  const runConfigLane = selectedClaimTypeSet.has("config_file") || selectedClaimTypeSet.has("package_dependency");
  const runLibraryLane = selectedClaimTypeSet.has("library_module");
  const runEnvLane = selectedClaimTypeSet.has("env_var");
  const runHotspotLane = selectedClaimTypeSet.has("dependency_hotspot");
  const runMiddlewareLane = selectedClaimTypeSet.has("middleware");
  const targetedSourcePaths = refreshSelection.refreshPlan.mode === "targeted"
    ? refreshSelection.refreshPlan.targetedSourcePaths
    : undefined;
  const impactIndex = buildCodemapImpactIndex({
    generatedAt: new Date().toISOString(),
    sourceEdges: [
      ...previousGraphEdges,
      ...(result.graph?.edges ?? []),
    ],
    workspaces: existingImpactIndex?.workspaces ?? [],
  });
  const hotspotSourcePaths = refreshSelection.refreshPlan.mode === "targeted"
    ? collectImpactedSourcePaths(
      impactIndex,
      options.changedFiles ?? [],
      { maxDepth: 1 },
    )
    : undefined;

  const routeGraph = runRouteLane
    ? await extractRouteClaimGraph(result, { sourcePaths: targetedSourcePaths })
    : { snapshots: [], evidence: [], claims: [] };
  const schemaGraph = runSchemaLane
    ? await extractSchemaClaimGraph(result, { sourcePaths: targetedSourcePaths })
    : { snapshots: [], evidence: [], claims: [] };
  const componentGraph = runComponentLane
    ? await extractComponentClaimGraph(result, { sourcePaths: targetedSourcePaths })
    : { snapshots: [], evidence: [], claims: [] };
  const configGraph = runConfigLane
    ? await extractConfigClaimGraph(result, { sourcePaths: targetedSourcePaths })
    : { snapshots: [], evidence: [], claims: [] };
  const libraryGraph = runLibraryLane
    ? await extractLibraryClaimGraph(result, { sourcePaths: targetedSourcePaths })
    : { snapshots: [], evidence: [], claims: [] };
  const envGraph = runEnvLane
    ? await extractEnvClaimGraph(result, { sourcePaths: targetedSourcePaths })
    : { snapshots: [], evidence: [], claims: [] };
  const hotspotGraph = runHotspotLane
    ? await extractHotspotClaimGraph(result, { sourcePaths: hotspotSourcePaths })
    : { snapshots: [], evidence: [], claims: [] };
  const middlewareGraph = runMiddlewareLane
    ? await extractMiddlewareClaimGraph(result, { sourcePaths: targetedSourcePaths })
    : { snapshots: [], evidence: [], claims: [] };

  const routeVerification = runRouteLane
    ? await verifyRouteClaims(repoRoot, routeGraph.claims, routeGraph.evidence, routeGraph.snapshots)
    : { claims: [], verification: [], conflicts: [] };
  const schemaVerification = runSchemaLane
    ? await verifySchemaClaims(repoRoot, schemaGraph.claims, schemaGraph.evidence, schemaGraph.snapshots)
    : { claims: [], verification: [], conflicts: [] };
  const componentVerification = runComponentLane
    ? await verifyComponentClaims(repoRoot, componentGraph.claims, componentGraph.evidence, componentGraph.snapshots)
    : { claims: [], verification: [], conflicts: [] };
  const configVerification = runConfigLane
    ? await verifyConfigClaims(repoRoot, configGraph.claims, configGraph.evidence, configGraph.snapshots)
    : { claims: [], verification: [], conflicts: [] };
  const libraryVerification = runLibraryLane
    ? await verifyLibraryClaims(repoRoot, libraryGraph.claims, libraryGraph.evidence, libraryGraph.snapshots)
    : { claims: [], verification: [], conflicts: [] };
  const envVerification = runEnvLane
    ? await verifyEnvClaims(repoRoot, envGraph.claims, envGraph.evidence, envGraph.snapshots)
    : { claims: [], verification: [], conflicts: [] };
  const hotspotVerification = runHotspotLane
    ? await verifyHotspotClaims(repoRoot, hotspotGraph.claims, hotspotGraph.evidence, hotspotGraph.snapshots)
    : { claims: [], verification: [], conflicts: [] };
  const middlewareVerification = runMiddlewareLane
    ? await verifyMiddlewareClaims(repoRoot, middlewareGraph.claims, middlewareGraph.evidence, middlewareGraph.snapshots)
    : { claims: [], verification: [], conflicts: [] };

  const authoritativeClaimTypes = new Set<Claim["type"]>(refreshSelection.selectedClaimTypes);
  const authoritativeSourcePathsByClaimType = new Map<Claim["type"], Set<string> | null>();
  for (const claimType of refreshSelection.selectedClaimTypes) {
    if (refreshSelection.refreshPlan.mode === "full") {
      authoritativeSourcePathsByClaimType.set(claimType, null);
      continue;
    }

    const scopedSourcePaths = claimType === "dependency_hotspot"
      ? hotspotSourcePaths
      : targetedSourcePaths;
    authoritativeSourcePathsByClaimType.set(claimType, new Set(scopedSourcePaths ?? []));
  }

  const invalidationResult = await invalidateMissingClaims(
    repoRoot,
    existingClaims,
    existingSnapshots,
    authoritativeClaimTypes,
    authoritativeSourcePathsByClaimType,
    [
      ...routeVerification.claims,
      ...schemaVerification.claims,
      ...componentVerification.claims,
      ...configVerification.claims,
      ...libraryVerification.claims,
      ...envVerification.claims,
      ...hotspotVerification.claims,
      ...middlewareVerification.claims,
    ],
    new Date().toISOString(),
  );
  const staleSnapshots = existingSnapshotsList.filter((snapshot) => invalidationResult.staleSnapshotIds.includes(snapshot.id));
  const currentRunClaims = uniqueById([
    ...routeVerification.claims,
    ...schemaVerification.claims,
    ...componentVerification.claims,
    ...configVerification.claims,
    ...libraryVerification.claims,
    ...envVerification.claims,
    ...hotspotVerification.claims,
    ...middlewareVerification.claims,
    ...invalidationResult.claims,
  ]);
  const currentRunVerificationRecords = uniqueById([
    ...routeVerification.verification,
    ...schemaVerification.verification,
    ...componentVerification.verification,
    ...configVerification.verification,
    ...libraryVerification.verification,
    ...envVerification.verification,
    ...hotspotVerification.verification,
    ...middlewareVerification.verification,
    ...invalidationResult.verification,
  ]);

  const rawSnapshots = uniqueById([
    ...existingSnapshotsList,
    ...routeGraph.snapshots,
    ...schemaGraph.snapshots,
    ...componentGraph.snapshots,
    ...configGraph.snapshots,
    ...libraryGraph.snapshots,
    ...envGraph.snapshots,
    ...hotspotGraph.snapshots,
    ...middlewareGraph.snapshots,
    ...staleSnapshots,
  ]);
  const rawEvidence = uniqueById([
    ...existingEvidence,
    ...routeGraph.evidence,
    ...schemaGraph.evidence,
    ...componentGraph.evidence,
    ...configGraph.evidence,
    ...libraryGraph.evidence,
    ...envGraph.evidence,
    ...hotspotGraph.evidence,
    ...middlewareGraph.evidence,
  ]);
  const rawClaims = uniqueById([
    ...existingClaims,
    ...routeVerification.claims,
    ...schemaVerification.claims,
    ...componentVerification.claims,
    ...configVerification.claims,
    ...libraryVerification.claims,
    ...envVerification.claims,
    ...hotspotVerification.claims,
    ...middlewareVerification.claims,
    ...invalidationResult.claims,
  ]);
  const rawVerification = uniqueById([
    ...existingVerification,
    ...routeVerification.verification,
    ...schemaVerification.verification,
    ...componentVerification.verification,
    ...configVerification.verification,
    ...libraryVerification.verification,
    ...envVerification.verification,
    ...hotspotVerification.verification,
    ...middlewareVerification.verification,
    ...invalidationResult.verification,
  ]);
  const claimTypeById = new Map(rawClaims.map((claim) => [claim.id, claim.type]));
  const preservedConflicts = refreshSelection.refreshPlan.mode === "full"
    ? []
    : existingConflicts.filter((conflict) => {
      const claimAType = claimTypeById.get(conflict.claimA);
      const claimBType = claimTypeById.get(conflict.claimB);
      return (!claimAType || !selectedClaimTypeSet.has(claimAType))
        && (!claimBType || !selectedClaimTypeSet.has(claimBType));
    });
  const rawConflicts = uniqueById([
    ...preservedConflicts,
    ...routeVerification.conflicts,
    ...schemaVerification.conflicts,
    ...componentVerification.conflicts,
    ...configVerification.conflicts,
    ...libraryVerification.conflicts,
    ...envVerification.conflicts,
    ...hotspotVerification.conflicts,
    ...middlewareVerification.conflicts,
  ]);
  const compactedState = compactCanonicalState(
    rawSnapshots,
    rawEvidence,
    rawClaims,
    rawVerification,
    rawConflicts,
  );
  const snapshots = compactedState.snapshots;
  const evidence = compactedState.evidence;
  const claims = compactedState.claims;
  const verification = compactedState.verification;
  const conflicts = compactedState.conflicts;
  const currentRunClaimIds = new Set(currentRunClaims.map((claim) => claim.id));
  const currentRunCompactedClaims = claims.filter((claim) => currentRunClaimIds.has(claim.id));

  await snapshotStore.replace(snapshots);
  await evidenceStore.replace(evidence);
  await claimStore.replace(claims);
  await verificationStore.replace(verification);
  await conflictStore.replace(conflicts);

  const basePublishPlan = buildPublishPlan("code", claims, conflicts);
  const generatedAt = basePublishPlan.generatedAt || new Date().toISOString();
  const publishPlan = {
    ...basePublishPlan,
    generatedAt,
  };
  await writeCodemapPublishPlan(repoRoot, publishPlan);

  const refreshPlan = buildCodemapRefreshPlan({
    domain: "code",
    generatedAt,
    trigger: options.trigger ?? "cli",
    changedFiles: options.changedFiles ?? [],
    claims,
    snapshots,
  });
  const publishRun = createPublishRunRecord({
    createdAt: generatedAt,
    trigger: options.trigger ?? "cli",
    refreshMode: refreshPlan.mode,
    changedFiles: options.changedFiles ?? [],
    impactedClaimTypes: refreshPlan.impactedClaimTypes,
    targetedSourcePaths: refreshPlan.targetedSourcePaths,
    claims: claims.length,
    verificationRecords: currentRunVerificationRecords.length,
    conflicts: conflicts.length,
  });
  const verificationHistory = [
    ...await readVerificationHistory(repoRoot),
    ...buildVerificationHistoryEntries({
      runId: publishRun.id,
      claims,
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

  const renderedViews = renderCodeViews(
    claims,
    snapshots,
    conflicts,
    generatedAt,
  );
  const compatibilityViews = renderCompatibilityWiki({
    projectName: result.project.name,
    claims,
    conflicts,
    snapshots,
    generatedAt,
  });
  const compatibilityParity = await compareCompatibilityWiki(repoRoot, compatibilityViews, generatedAt);
  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.compatibilityParity), compatibilityParity.report);
  const claimHealthIncidents = buildClaimHealthIncidents({
    claims,
    conflicts,
    verification,
    generatedAt,
    criticalClaimTypes: DEFAULT_CRITICAL_CODE_CLAIM_TYPES,
  });
  const incidents = [...compatibilityParity.incidents, ...claimHealthIncidents]
    .sort((left, right) => left.id.localeCompare(right.id));
  await writeNdjsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.incidentsNdjson), incidents);
  await writeViews(repoRoot, [...renderedViews, ...compatibilityViews]);

  await writeCodemapRefreshPlan(repoRoot, refreshPlan);
  await writeImpactIndex(repoRoot, buildCodemapImpactIndex({
    generatedAt,
    sourceEdges: result.graph?.edges ?? [],
    workspaces: existingImpactIndex?.workspaces ?? [],
  }));
  await writeDependencyGraphCache(repoRoot, generatedAt, result.graph?.edges ?? []);

  const scanState = buildCodemapScanState({
    domain: "code",
    generatedAt,
    trigger: options.trigger ?? "cli",
    outputDirName: options.outputDirName ?? ".codesight",
    changedFiles: options.changedFiles ?? [],
    claims: claims.length,
    snapshots: snapshots.length,
    evidence: evidence.length,
    verificationRecords: verification.length,
    conflicts: conflicts.length,
    incidents: incidents.length,
    views: renderedViews.map((view) => view.path),
    compatibilityViews: compatibilityViews.map((view) => view.path),
    compatibilityParity: {
      legacyWikiPresent: compatibilityParity.report.legacyWikiPresent,
      matched: compatibilityParity.report.summary.matched,
      drifted: compatibilityParity.report.summary.drifted,
      missingCompatibility: compatibilityParity.report.summary.missingCompatibility,
      extraCompatibility: compatibilityParity.report.summary.extraCompatibility,
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
    snapshots: snapshots.length,
    claims: claims.length,
    evidence: evidence.length,
    verificationRecords: verification.length,
    conflicts: conflicts.length,
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
