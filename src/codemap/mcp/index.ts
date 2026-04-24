import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Claim,
  ClaimHistoryEntry,
  ClaimStatus,
  ClaimType,
  ConflictEdge,
  ConflictSeverity,
  EvidenceSpan,
  HistoryStorageStatus,
  PublishDecision,
  PublishIncident,
  CombinedPublishPlan,
  PublishPlan,
  PublishRunRecord,
  SourceSnapshot,
  VerificationHistoryEntry,
  VerificationRecord,
} from "../model/types.js";
import { CODEMAP_FILES } from "../model/layout.js";
import {
  getClaimRunHistoryPartitionFile,
  getVerificationRunHistoryPartitionFile,
  readClaimHistoryByRunId,
  readClaimHistoryByClaimId,
  readPublishRuns,
  readRunHistoryIndex,
  readVerificationHistoryByRunId,
  readVerificationHistoryByClaimId,
} from "../history/index.js";
import {
  collectImpactedSourcePaths,
  type CodemapCombinedRefreshPlan,
  type CodemapCombinedScanState,
  type CodemapStatusDomain,
  type CodemapRefreshPlan,
  type CodemapImpactIndex,
  type CodemapScanState,
} from "../runtime/index.js";
import type {
  CompatibilityKnowledgeParityReport,
  CompatibilityParityReport,
  CompatibilityParityStatus,
} from "../migration/compatibility-parity.js";
import { createSnapshotId, hashSnapshotContent } from "../snapshot/snapshotter.js";
import { buildCombinedPublishPlan, normalizeCombinedPublishPlan } from "../publish/plans.js";
import { FileClaimStore } from "../store/claims-store.js";
import { FileConflictStore } from "../store/conflict-store.js";
import { FileEvidenceStore } from "../store/evidence-store.js";
import { readJsonFile, readNdjsonFile, resolveCodemapPath } from "../store/fs.js";
import { FileSnapshotStore } from "../store/snapshots-store.js";
import { FileVerificationStore } from "../store/verification-store.js";

const STATUS_ORDER: Record<ClaimStatus, number> = {
  verified: 0,
  inferred: 1,
  candidate: 2,
  conflicting: 3,
  stale: 4,
  quarantined: 5,
  superseded: 6,
};

const TYPE_ORDER: ClaimType[] = [
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
  "knowledge_decision",
  "knowledge_question",
  "knowledge_theme",
  "knowledge_person",
  "knowledge_summary",
];

const KNOWLEDGE_CLAIM_TYPES = new Set<ClaimType>([
  "knowledge_decision",
  "knowledge_question",
  "knowledge_theme",
  "knowledge_person",
  "knowledge_summary",
]);

export interface CodemapToolClaimSummary {
  claimId: string;
  type: ClaimType;
  subject: string;
  status: ClaimStatus;
  confidence: number;
  lastVerifiedAt?: string;
  tags: string[];
}

export interface CodemapToolEvidenceResponse {
  claimId: string;
  evidence: EvidenceSpan[];
}

export interface CodemapToolConflictResponse {
  claimId: string;
  conflicts: ConflictEdge[];
}

export interface CodemapOverviewResponse {
  generatedAt?: string;
  totalClaims: number;
  totalConflicts: number;
  statusCounts: Array<{ status: ClaimStatus; count: number }>;
  typeCounts: Array<{
    type: ClaimType;
    count: number;
    verified: number;
    inferred: number;
    stale: number;
    quarantined: number;
  }>;
  recentClaims: CodemapToolClaimSummary[];
}

export interface CodemapKnowledgeOverviewResponse {
  generatedAt?: string;
  totalClaims: number;
  totalConflicts: number;
  typeCounts: Array<{
    type: ClaimType;
    count: number;
    verified: number;
    inferred: number;
    stale: number;
    quarantined: number;
  }>;
  decisions: CodemapToolClaimSummary[];
  openQuestions: CodemapToolClaimSummary[];
  themes: CodemapToolClaimSummary[];
  people: CodemapToolClaimSummary[];
  summaries: CodemapToolClaimSummary[];
}

export interface CodemapQueryScope {
  changed_files?: string[];
  impact_depth?: number;
  source_path?: string;
}

export interface CodemapOverviewArgs extends CodemapQueryScope {}

export interface CodemapKnowledgeOverviewArgs extends CodemapQueryScope {
  include_summaries?: boolean;
}

export interface CodemapSearchClaimsArgs extends CodemapQueryScope {
  query?: string;
  type?: ClaimType;
  status?: ClaimStatus;
  tag?: string;
  limit?: number;
}

export interface CodemapSearchKnowledgeArgs extends CodemapQueryScope {
  query?: string;
  kind?: ClaimType;
  status?: ClaimStatus;
  tag?: string;
  limit?: number;
}

export interface CodemapSearchClaimsResponse {
  totalMatches: number;
  claims: CodemapToolClaimSummary[];
}

export interface CodemapClaimLookupArgs extends CodemapQueryScope {
  claim_id?: string;
  subject?: string;
}

export interface CodemapClaimDetailResponse {
  claim: Claim;
  evidence: EvidenceSpan[];
  verification: VerificationRecord[];
  conflicts: ConflictEdge[];
  snapshots: SourceSnapshot[];
}

export interface CodemapClaimHistoryArgs extends CodemapClaimLookupArgs {
  limit?: number;
}

export interface CodemapClaimHistoryResponse {
  claim: CodemapToolClaimSummary;
  totalEntries: number;
  history: Array<VerificationHistoryEntry & { run?: PublishRunRecord }>;
}

export interface CodemapClaimStateHistoryArgs extends CodemapClaimLookupArgs {
  limit?: number;
}

export interface CodemapClaimStateHistoryResponse {
  claim: CodemapToolClaimSummary;
  totalEntries: number;
  history: Array<ClaimHistoryEntry & { run?: PublishRunRecord }>;
}

export interface CodemapPublishRunArgs {
  run_id?: string;
  latest?: boolean;
  claim_limit?: number;
  verification_limit?: number;
}

export interface CodemapPublishRunResponse {
  run: {
    runId: string;
    createdAt: string;
    trigger: PublishRunRecord["trigger"];
    refreshMode: PublishRunRecord["refreshMode"];
    changedFiles: string[];
    impactedClaimTypes: ClaimType[];
    targetedSourcePaths: string[];
    claimHistoryEntries: number;
    verificationHistoryEntries: number;
    claimPartitionPath: string;
    verificationPartitionPath: string;
  };
  claimHistory: ClaimHistoryEntry[];
  verificationHistory: VerificationHistoryEntry[];
}

export interface CodemapConflictSearchArgs extends CodemapQueryScope {
  claim_id?: string;
  severity?: ConflictSeverity;
  limit?: number;
}

export interface CodemapConflictListResponse {
  totalConflicts: number;
  conflicts: Array<ConflictEdge & { claimASubject: string; claimBSubject: string }>;
}

export type CodemapVerifyVerdict =
  | "verified"
  | "warning"
  | "failed"
  | "conflicting"
  | "stale"
  | "quarantined";

export type CodemapSnapshotWorkspaceState = "unchanged" | "changed" | "missing";

export interface CodemapWorkspaceSnapshotState {
  snapshotId: string;
  sourcePath: string;
  snapshotContentHash: string;
  currentContentHash?: string;
  currentSnapshotId?: string;
  state: CodemapSnapshotWorkspaceState;
}

export interface CodemapVerifyClaimResponse {
  claim: Claim;
  verdict: CodemapVerifyVerdict;
  evidenceIds: string[];
  verification: VerificationRecord[];
  snapshots: CodemapWorkspaceSnapshotState[];
  conflicts: Array<ConflictEdge & { otherClaimId: string; otherClaimSubject: string }>;
  failureCount: number;
  warningCount: number;
  workspaceDriftCount: number;
}

export interface CodemapSnapshotDiffArgs {
  snapshot_id?: string;
  source_path?: string;
  claim_limit?: number;
}

export interface CodemapSnapshotExcerpt {
  startLine: number;
  endLine: number;
  excerpt: string[];
}

export interface CodemapSnapshotContentDiff {
  kind: "changed" | "missing" | "unchanged" | "unavailable";
  stored?: CodemapSnapshotExcerpt;
  current?: CodemapSnapshotExcerpt;
}

export interface CodemapSnapshotDiffResponse {
  snapshot: SourceSnapshot;
  current: CodemapWorkspaceSnapshotState;
  contentDiff: CodemapSnapshotContentDiff | null;
  totalActiveClaims: number;
  activeClaims: CodemapToolClaimSummary[];
}

export interface CodemapPublishPlanSummary {
  generatedAt: string;
  totalItems: number;
  decisionCounts: Array<{ decision: PublishDecision; count: number }>;
  blockingClaims: number;
}

export interface CodemapIncidentSummary {
  code: number;
  knowledge: number;
  total: number;
  severityCounts: Array<{ severity: ConflictSeverity; count: number }>;
}

export interface CodemapCompatibilityStatusSummary {
  code?: {
    legacyBaselinePresent: boolean;
    matched: number;
    drifted: number;
    missingCompatibility: number;
    extraCompatibility: number;
    noLegacyBaseline: number;
  };
  knowledge?: {
    legacyBaselinePresent: boolean;
    status: CompatibilityParityStatus;
    similarity: number | null;
  };
}

export interface CodemapHistoryStorageSummary {
  mode: HistoryStorageStatus["policy"]["mode"];
  hotBytes: number;
  totalBytes: number;
  archiveBytes: number;
  archivedSegments: number;
  plannedSegments: number;
  warningThresholdExceeded: boolean;
  overBudget: boolean;
  snapshotHotBytes: number;
  snapshotArchiveBytes: number;
  activeSnapshots: number;
  historicalHotSnapshots: number;
  archivedSnapshots: number;
  plannedSnapshots: number;
}

export interface CodemapPublishStatusResponse {
  generatedAt?: string;
  currentDomain?: CodemapStatusDomain;
  latestRun?: PublishRunRecord;
  scanState: CodemapCombinedScanState | null;
  refreshPlan: CodemapCombinedRefreshPlan | null;
  domainScanStates: Partial<Record<CodemapStatusDomain, CodemapScanState>>;
  domainRefreshPlans: Partial<Record<CodemapStatusDomain, CodemapRefreshPlan>>;
  publishPlan: CodemapPublishPlanSummary | null;
  domainPublishPlans: Partial<Record<CodemapStatusDomain, CodemapPublishPlanSummary>>;
  incidents: CodemapIncidentSummary;
  compatibility: CodemapCompatibilityStatusSummary;
  historyStorage: CodemapHistoryStorageSummary | null;
}

interface CodemapQueryContext {
  claims: Claim[];
  claimsById: Map<string, Claim>;
  evidenceById: Map<string, EvidenceSpan>;
  snapshotsById: Map<string, SourceSnapshot>;
  verificationByClaimId: Map<string, VerificationRecord[]>;
  conflictsByClaimId: Map<string, ConflictEdge[]>;
  conflicts: ConflictEdge[];
}

interface CodemapScopeContext {
  claims: Claim[];
  claimIds: Set<string>;
  conflicts: ConflictEdge[];
}

function summarizeClaim(claim: Claim): CodemapToolClaimSummary {
  return {
    claimId: claim.id,
    type: claim.type,
    subject: claim.subject,
    status: claim.status,
    confidence: claim.publicationConfidence,
    lastVerifiedAt: claim.lastVerifiedAt,
    tags: [...claim.tags].sort(),
  };
}

function isKnowledgeClaimType(type: ClaimType): boolean {
  return KNOWLEDGE_CLAIM_TYPES.has(type);
}

function compareClaims(left: Claim, right: Claim): number {
  return (
    STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
    || right.publicationConfidence - left.publicationConfidence
    || left.subject.localeCompare(right.subject)
    || left.id.localeCompare(right.id)
  );
}

function compareKnowledgeNarrativeClaims(left: Claim, right: Claim): number {
  return (
    (right.lastVerifiedAt ?? right.firstSeenAt).localeCompare(left.lastVerifiedAt ?? left.firstSeenAt)
    || compareClaims(left, right)
  );
}

function compareClaimType(left: ClaimType, right: ClaimType): number {
  const leftIndex = TYPE_ORDER.indexOf(left);
  const rightIndex = TYPE_ORDER.indexOf(right);
  if (leftIndex === -1 || rightIndex === -1) {
    return left.localeCompare(right);
  }
  return leftIndex - rightIndex;
}

function claimMatchesQuery(claim: Claim, query?: string): boolean {
  if (!query || query.trim().length === 0) return true;

  const needle = query.trim().toLowerCase();
  return [
    claim.id,
    claim.type,
    claim.subject,
    claim.text,
    ...claim.tags,
  ].some((value) => value.toLowerCase().includes(needle));
}

function findClaimByReference(
  claims: Claim[],
  claimsById: Map<string, Claim>,
  args: CodemapClaimLookupArgs
): Claim | null {
  if (args.claim_id) {
    return claimsById.get(args.claim_id) ?? null;
  }

  if (!args.subject || args.subject.trim().length === 0) {
    return null;
  }

  const subject = args.subject.trim().toLowerCase();
  const exactMatches = claims.filter((claim) => claim.subject.toLowerCase() === subject);
  if (exactMatches.length > 0) {
    return exactMatches.sort(compareClaims)[0];
  }

  const partialMatches = claims.filter((claim) => claim.subject.toLowerCase().includes(subject));
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  return partialMatches.sort(compareClaims)[0] ?? null;
}

function getClaimEvidence(context: CodemapQueryContext, claim: Claim): EvidenceSpan[] {
  return claim.evidenceSpanIds
    .map((evidenceId) => context.evidenceById.get(evidenceId))
    .filter((entry): entry is EvidenceSpan => Boolean(entry))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function getClaimSnapshots(context: CodemapQueryContext, claim: Claim): SourceSnapshot[] {
  return claim.sourceSnapshotIds
    .map((snapshotId) => context.snapshotsById.get(snapshotId))
    .filter((entry): entry is SourceSnapshot => Boolean(entry))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function compareVerificationRecords(left: VerificationRecord, right: VerificationRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareSnapshots(left: SourceSnapshot, right: SourceSnapshot): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

async function readWorkspaceSnapshotContent(
  repoRoot: string,
  snapshot: SourceSnapshot,
): Promise<string | null> {
  try {
    return await readFile(join(repoRoot, snapshot.sourcePath), "utf-8");
  } catch {
    return null;
  }
}

async function getWorkspaceSnapshotState(
  repoRoot: string,
  snapshot: SourceSnapshot,
): Promise<CodemapWorkspaceSnapshotState> {
  const content = await readWorkspaceSnapshotContent(repoRoot, snapshot);
  if (content === null) {
    return {
      snapshotId: snapshot.id,
      sourcePath: snapshot.sourcePath,
      snapshotContentHash: snapshot.contentHash,
      state: "missing",
    };
  }

  const currentContentHash = hashSnapshotContent(content);
  return {
    snapshotId: snapshot.id,
    sourcePath: snapshot.sourcePath,
    snapshotContentHash: snapshot.contentHash,
    currentContentHash,
    currentSnapshotId: createSnapshotId(snapshot.sourcePath, currentContentHash),
    state: currentContentHash === snapshot.contentHash ? "unchanged" : "changed",
  };
}

function splitSnapshotLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function trimExcerpt(lines: string[], startLine: number, maxLines = 12): CodemapSnapshotExcerpt {
  const excerpt = lines.length > maxLines
    ? [...lines.slice(0, maxLines), "..."]
    : [...lines];
  const visibleLineCount = Math.min(lines.length, maxLines);
  return {
    startLine,
    endLine: startLine + Math.max(visibleLineCount - 1, 0),
    excerpt,
  };
}

function buildSnapshotExcerpt(
  lines: string[],
  startIndex: number,
  endIndex: number,
  contextLines = 2,
  maxLines = 12,
): CodemapSnapshotExcerpt {
  const boundedStart = Math.max(0, startIndex - contextLines);
  const boundedEnd = Math.min(lines.length - 1, endIndex + contextLines);
  const excerptLines = boundedEnd >= boundedStart
    ? lines.slice(boundedStart, boundedEnd + 1)
    : [];
  return trimExcerpt(excerptLines, boundedStart + 1, maxLines);
}

function buildSnapshotContentDiff(
  storedContent: string | null,
  currentContent: string | null,
): CodemapSnapshotContentDiff | null {
  if (storedContent === null) {
    return {
      kind: "unavailable",
    };
  }

  const storedLines = splitSnapshotLines(storedContent);
  if (currentContent === null) {
    return {
      kind: "missing",
      stored: trimExcerpt(storedLines, 1),
    };
  }

  if (storedContent === currentContent) {
    return {
      kind: "unchanged",
    };
  }

  const currentLines = splitSnapshotLines(currentContent);
  const minLength = Math.min(storedLines.length, currentLines.length);
  let startIndex = 0;
  while (startIndex < minLength && storedLines[startIndex] === currentLines[startIndex]) {
    startIndex += 1;
  }

  let storedEndIndex = storedLines.length - 1;
  let currentEndIndex = currentLines.length - 1;
  while (
    storedEndIndex >= startIndex
    && currentEndIndex >= startIndex
    && storedLines[storedEndIndex] === currentLines[currentEndIndex]
  ) {
    storedEndIndex -= 1;
    currentEndIndex -= 1;
  }

  return {
    kind: "changed",
    stored: buildSnapshotExcerpt(storedLines, startIndex, storedEndIndex),
    current: buildSnapshotExcerpt(currentLines, startIndex, currentEndIndex),
  };
}

function summarizePublishPlan(plan: PublishPlan): CodemapPublishPlanSummary {
  const decisionCounts = new Map<PublishDecision, number>();
  for (const item of plan.items) {
    decisionCounts.set(item.decision, (decisionCounts.get(item.decision) ?? 0) + 1);
  }

  return {
    generatedAt: plan.generatedAt,
    totalItems: plan.items.length,
    decisionCounts: [...decisionCounts.entries()]
      .map(([decision, count]) => ({ decision, count }))
      .sort((left, right) => left.decision.localeCompare(right.decision)),
    blockingClaims: plan.items.filter((item) => item.blockingConflictIds.length > 0).length,
  };
}

function summarizeIncidents(
  codeIncidents: PublishIncident[],
  knowledgeIncidents: PublishIncident[],
): CodemapIncidentSummary {
  const severityCounts = new Map<ConflictSeverity, number>();
  for (const incident of [...codeIncidents, ...knowledgeIncidents]) {
    severityCounts.set(incident.severity, (severityCounts.get(incident.severity) ?? 0) + 1);
  }

  return {
    code: codeIncidents.length,
    knowledge: knowledgeIncidents.length,
    total: codeIncidents.length + knowledgeIncidents.length,
    severityCounts: [...severityCounts.entries()]
      .map(([severity, count]) => ({ severity, count }))
      .sort((left, right) => left.severity.localeCompare(right.severity)),
  };
}

function summarizeHistoryStorage(status: HistoryStorageStatus): CodemapHistoryStorageSummary {
  return {
    mode: status.policy.mode,
    hotBytes: status.usage.hotBytes,
    totalBytes: status.usage.totalBytes,
    archiveBytes: status.usage.archiveBytes,
    archivedSegments: status.counts.archivedSegments,
    plannedSegments: status.counts.plannedSegments,
    warningThresholdExceeded: status.budget.warningThresholdExceeded,
    overBudget: status.budget.overBudget,
    snapshotHotBytes: status.snapshotStorage.hotBytes,
    snapshotArchiveBytes: status.snapshotStorage.archiveBytes,
    activeSnapshots: status.snapshotStorage.activeSnapshots,
    historicalHotSnapshots: status.snapshotStorage.historicalHotSnapshots,
    archivedSnapshots: status.snapshotStorage.archivedSnapshots,
    plannedSnapshots: status.snapshotStorage.plannedSnapshots,
  };
}

function normalizeCombinedScanState(
  state: CodemapCombinedScanState | CodemapScanState | null,
): CodemapCombinedScanState | null {
  if (!state) {
    return null;
  }
  if ("domains" in state && state.domains) {
    return state;
  }
  const domain = state.domain ?? "code";
  return {
    ...state,
    domain,
    currentDomain: domain,
    domains: {
      [domain]: {
        ...state,
        domain,
      },
    },
  };
}

function normalizeCombinedRefreshPlan(
  plan: CodemapCombinedRefreshPlan | CodemapRefreshPlan | null,
): CodemapCombinedRefreshPlan | null {
  if (!plan) {
    return null;
  }
  if ("domains" in plan && plan.domains) {
    return plan;
  }
  const domain = plan.domain ?? "code";
  return {
    ...plan,
    domain,
    currentDomain: domain,
    domains: {
      [domain]: {
        ...plan,
        domain,
      },
    },
  };
}

async function loadImpactIndex(repoRoot: string): Promise<CodemapImpactIndex | null> {
  return readJsonFile<CodemapImpactIndex>(resolveCodemapPath(repoRoot, CODEMAP_FILES.impactIndex));
}

function getClaimSourcePaths(context: CodemapQueryContext, claim: Claim): string[] {
  return [...new Set(
    claim.sourceSnapshotIds
      .map((snapshotId) => context.snapshotsById.get(snapshotId)?.sourcePath)
      .filter((sourcePath): sourcePath is string => Boolean(sourcePath))
      .map(normalizeSourcePath),
  )].sort();
}

async function applyQueryScope(
  repoRoot: string,
  context: CodemapQueryContext,
  scope: CodemapQueryScope = {},
): Promise<CodemapScopeContext> {
  let claims = [...context.claims];

  if (scope.source_path && scope.source_path.trim().length > 0) {
    const normalizedSourcePath = normalizeSourcePath(scope.source_path.trim());
    claims = claims.filter((claim) =>
      getClaimSourcePaths(context, claim).some((sourcePath) =>
        sourcePath === normalizedSourcePath || sourcePath.startsWith(`${normalizedSourcePath}/`),
      ),
    );
  }

  if (scope.changed_files && scope.changed_files.length > 0) {
    const normalizedChangedFiles = [...new Set(
      scope.changed_files.map(normalizeSourcePath).filter(Boolean),
    )].sort();
    const impactIndex = await loadImpactIndex(repoRoot);
    const impactedSourcePaths = new Set(
      impactIndex
        ? collectImpactedSourcePaths(impactIndex, normalizedChangedFiles, {
          maxDepth: Math.max(scope.impact_depth ?? 1, 0),
        })
        : normalizedChangedFiles,
    );

    claims = claims.filter((claim) =>
      getClaimSourcePaths(context, claim).some((sourcePath) => impactedSourcePaths.has(sourcePath)),
    );
  }

  claims.sort(compareClaims);
  const claimIds = new Set(claims.map((claim) => claim.id));
  const conflicts = context.conflicts
    .filter((conflict) => claimIds.has(conflict.claimA) || claimIds.has(conflict.claimB))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    claims,
    claimIds,
    conflicts,
  };
}

function determineVerifyVerdict(
  claim: Claim,
  verification: VerificationRecord[],
  conflicts: ConflictEdge[],
  snapshotStates: CodemapWorkspaceSnapshotState[],
): CodemapVerifyVerdict {
  if (claim.status === "quarantined") return "quarantined";
  if (claim.status === "stale") return "stale";
  if (claim.status === "conflicting" || conflicts.length > 0) return "conflicting";
  if (verification.some((record) => record.outcome === "fail")) return "failed";
  if (
    verification.some((record) => record.outcome === "warn")
    || snapshotStates.some((state) => state.state !== "unchanged")
    || claim.status === "candidate"
    || claim.status === "inferred"
    || claim.status === "superseded"
  ) {
    return "warning";
  }
  return "verified";
}

function selectSnapshotForDiff(
  snapshots: SourceSnapshot[],
  snapshotId?: string,
  sourcePath?: string,
): SourceSnapshot | null {
  if (snapshotId) {
    return snapshots.find((snapshot) => snapshot.id === snapshotId) ?? null;
  }

  if (!sourcePath || sourcePath.trim().length === 0) {
    return null;
  }

  const normalizedSourcePath = normalizeSourcePath(sourcePath.trim());
  const exactMatches = snapshots
    .filter((snapshot) => normalizeSourcePath(snapshot.sourcePath) === normalizedSourcePath)
    .sort(compareSnapshots);
  if (exactMatches.length > 0) {
    return exactMatches.at(-1) ?? null;
  }

  const prefixMatches = snapshots
    .filter((snapshot) => normalizeSourcePath(snapshot.sourcePath).startsWith(`${normalizedSourcePath}/`))
    .sort(compareSnapshots);
  return prefixMatches.at(-1) ?? null;
}

export async function loadCodemapQueryContext(repoRoot: string): Promise<CodemapQueryContext> {
  const snapshotStore = new FileSnapshotStore(repoRoot);
  const claimStore = new FileClaimStore(repoRoot);
  const evidenceStore = new FileEvidenceStore(repoRoot);
  const verificationStore = new FileVerificationStore(repoRoot);
  const conflictStore = new FileConflictStore(repoRoot);

  const [snapshots, claims, evidence, verification, conflicts] = await Promise.all([
    snapshotStore.list(),
    claimStore.list(),
    evidenceStore.list(),
    verificationStore.list(),
    conflictStore.list(),
  ]);

  const verificationByClaimId = new Map<string, VerificationRecord[]>();
  for (const record of verification) {
    if (!verificationByClaimId.has(record.claimId)) {
      verificationByClaimId.set(record.claimId, []);
    }
    verificationByClaimId.get(record.claimId)!.push(record);
  }

  const conflictsByClaimId = new Map<string, ConflictEdge[]>();
  for (const conflict of conflicts) {
    if (!conflictsByClaimId.has(conflict.claimA)) {
      conflictsByClaimId.set(conflict.claimA, []);
    }
    if (!conflictsByClaimId.has(conflict.claimB)) {
      conflictsByClaimId.set(conflict.claimB, []);
    }
    conflictsByClaimId.get(conflict.claimA)!.push(conflict);
    conflictsByClaimId.get(conflict.claimB)!.push(conflict);
  }

  for (const records of verificationByClaimId.values()) {
    records.sort((left, right) => left.id.localeCompare(right.id));
  }

  for (const entries of conflictsByClaimId.values()) {
    entries.sort((left, right) => left.id.localeCompare(right.id));
  }

  return {
    claims,
    claimsById: new Map(claims.map((claim) => [claim.id, claim])),
    evidenceById: new Map(evidence.map((entry) => [entry.id, entry])),
    snapshotsById: new Map(snapshots.map((snapshot) => [snapshot.id, snapshot])),
    verificationByClaimId,
    conflictsByClaimId,
    conflicts,
  };
}

export async function getCodemapOverview(
  repoRoot: string,
  args: CodemapOverviewArgs = {},
): Promise<CodemapOverviewResponse> {
  const context = await loadCodemapQueryContext(repoRoot);
  const scope = await applyQueryScope(repoRoot, context, args);
  const claims = scope.claims;
  const generatedAt = claims
    .map((claim) => claim.lastVerifiedAt ?? claim.firstSeenAt)
    .sort()
    .at(-1);

  const statusEntries = new Map<ClaimStatus, number>();
  const typeEntries = new Map<ClaimType, Claim[]>();

  for (const claim of claims) {
    statusEntries.set(claim.status, (statusEntries.get(claim.status) ?? 0) + 1);
    if (!typeEntries.has(claim.type)) {
      typeEntries.set(claim.type, []);
    }
    typeEntries.get(claim.type)!.push(claim);
  }

  return {
    generatedAt,
    totalClaims: claims.length,
    totalConflicts: scope.conflicts.length,
    statusCounts: [...statusEntries.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status]),
    typeCounts: [...typeEntries.entries()]
      .map(([type, typedClaims]) => ({
        type,
        count: typedClaims.length,
        verified: typedClaims.filter((claim) => claim.status === "verified").length,
        inferred: typedClaims.filter((claim) => claim.status === "inferred").length,
        stale: typedClaims.filter((claim) => claim.status === "stale").length,
        quarantined: typedClaims.filter((claim) => claim.status === "quarantined").length,
      }))
      .sort((left, right) => compareClaimType(left.type, right.type)),
    recentClaims: claims.slice(0, 10).map(summarizeClaim),
  };
}

export async function getCodemapKnowledgeOverview(
  repoRoot: string,
  args: CodemapKnowledgeOverviewArgs = {},
): Promise<CodemapKnowledgeOverviewResponse> {
  const context = await loadCodemapQueryContext(repoRoot);
  const scope = await applyQueryScope(repoRoot, context, args);
  const claims = scope.claims
    .filter((claim) => isKnowledgeClaimType(claim.type))
    .sort(compareClaims);
  const knowledgeClaimIds = new Set(claims.map((claim) => claim.id));
  const conflicts = scope.conflicts.filter((conflict) =>
    knowledgeClaimIds.has(conflict.claimA) || knowledgeClaimIds.has(conflict.claimB),
  );
  const generatedAt = claims
    .map((claim) => claim.lastVerifiedAt ?? claim.firstSeenAt)
    .sort()
    .at(-1);
  const typeEntries = new Map<ClaimType, Claim[]>();

  for (const claim of claims) {
    if (!typeEntries.has(claim.type)) {
      typeEntries.set(claim.type, []);
    }
    typeEntries.get(claim.type)!.push(claim);
  }

  const includeSummaries = args.include_summaries !== false;
  const sortedNarrativeClaims = [...claims].sort(compareKnowledgeNarrativeClaims);

  return {
    generatedAt,
    totalClaims: claims.length,
    totalConflicts: conflicts.length,
    typeCounts: [...typeEntries.entries()]
      .map(([type, typedClaims]) => ({
        type,
        count: typedClaims.length,
        verified: typedClaims.filter((claim) => claim.status === "verified").length,
        inferred: typedClaims.filter((claim) => claim.status === "inferred").length,
        stale: typedClaims.filter((claim) => claim.status === "stale").length,
        quarantined: typedClaims.filter((claim) => claim.status === "quarantined").length,
      }))
      .sort((left, right) => compareClaimType(left.type, right.type)),
    decisions: sortedNarrativeClaims
      .filter((claim) => claim.type === "knowledge_decision")
      .slice(0, 10)
      .map(summarizeClaim),
    openQuestions: sortedNarrativeClaims
      .filter((claim) => claim.type === "knowledge_question")
      .slice(0, 10)
      .map(summarizeClaim),
    themes: sortedNarrativeClaims
      .filter((claim) => claim.type === "knowledge_theme")
      .slice(0, 10)
      .map(summarizeClaim),
    people: sortedNarrativeClaims
      .filter((claim) => claim.type === "knowledge_person")
      .slice(0, 10)
      .map(summarizeClaim),
    summaries: includeSummaries
      ? sortedNarrativeClaims
          .filter((claim) => claim.type === "knowledge_summary")
          .slice(0, 10)
          .map(summarizeClaim)
      : [],
  };
}

export async function searchCodemapClaims(
  repoRoot: string,
  args: CodemapSearchClaimsArgs = {}
): Promise<CodemapSearchClaimsResponse> {
  const context = await loadCodemapQueryContext(repoRoot);
  const scope = await applyQueryScope(repoRoot, context, args);
  const filtered = scope.claims
    .filter((claim) => !args.type || claim.type === args.type)
    .filter((claim) => !args.status || claim.status === args.status)
    .filter((claim) => !args.tag || claim.tags.includes(args.tag))
    .filter((claim) => claimMatchesQuery(claim, args.query))
    .sort(compareClaims);

  const limit = Math.max(1, Math.min(args.limit ?? 10, 50));
  return {
    totalMatches: filtered.length,
    claims: filtered.slice(0, limit).map(summarizeClaim),
  };
}

export async function searchCodemapKnowledge(
  repoRoot: string,
  args: CodemapSearchKnowledgeArgs = {},
): Promise<CodemapSearchClaimsResponse> {
  const context = await loadCodemapQueryContext(repoRoot);
  const scope = await applyQueryScope(repoRoot, context, args);
  const filtered = scope.claims
    .filter((claim) => isKnowledgeClaimType(claim.type))
    .filter((claim) => !args.kind || claim.type === args.kind)
    .filter((claim) => !args.status || claim.status === args.status)
    .filter((claim) => !args.tag || claim.tags.includes(args.tag))
    .filter((claim) => claimMatchesQuery(claim, args.query))
    .sort(compareClaims);

  const limit = Math.max(1, Math.min(args.limit ?? 10, 50));
  return {
    totalMatches: filtered.length,
    claims: filtered.slice(0, limit).map(summarizeClaim),
  };
}

export async function getCodemapClaim(
  repoRoot: string,
  args: CodemapClaimLookupArgs
): Promise<CodemapClaimDetailResponse | null> {
  const context = await loadCodemapQueryContext(repoRoot);
  const scope = await applyQueryScope(repoRoot, context, args);
  const claimsById = new Map(scope.claims.map((claim) => [claim.id, claim]));
  const claim = findClaimByReference(scope.claims, claimsById, args);
  if (!claim) {
    return null;
  }

  return {
    claim,
    evidence: getClaimEvidence(context, claim),
    verification: context.verificationByClaimId.get(claim.id) ?? [],
    conflicts: context.conflictsByClaimId.get(claim.id) ?? [],
    snapshots: getClaimSnapshots(context, claim),
  };
}

export async function getCodemapClaimEvidence(
  repoRoot: string,
  args: CodemapClaimLookupArgs
): Promise<CodemapToolEvidenceResponse | null> {
  const detail = await getCodemapClaim(repoRoot, args);
  if (!detail) {
    return null;
  }

  return {
    claimId: detail.claim.id,
    evidence: detail.evidence,
  };
}

export async function getCodemapClaimHistory(
  repoRoot: string,
  args: CodemapClaimHistoryArgs,
): Promise<CodemapClaimHistoryResponse | null> {
  const context = await loadCodemapQueryContext(repoRoot);
  const scope = await applyQueryScope(repoRoot, context, args);
  const claimsById = new Map(scope.claims.map((claim) => [claim.id, claim]));
  const claim = findClaimByReference(scope.claims, claimsById, args);
  if (!claim) {
    return null;
  }

  const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
  const [historyEntries, publishRuns] = await Promise.all([
    readVerificationHistoryByClaimId(repoRoot, claim.id),
    readNdjsonFile<PublishRunRecord>(resolveCodemapPath(repoRoot, CODEMAP_FILES.publishRunsNdjson)),
  ]);
  const runById = new Map(publishRuns.map((run) => [run.id, run]));
  const history = historyEntries
    .filter((entry) => entry.claimId === claim.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));

  return {
    claim: summarizeClaim(claim),
    totalEntries: history.length,
    history: history.slice(0, limit).map((entry) => ({
      ...entry,
      run: runById.get(entry.runId),
    })),
  };
}

export async function getCodemapClaimStateHistory(
  repoRoot: string,
  args: CodemapClaimStateHistoryArgs,
): Promise<CodemapClaimStateHistoryResponse | null> {
  const context = await loadCodemapQueryContext(repoRoot);
  const scope = await applyQueryScope(repoRoot, context, args);
  const claimsById = new Map(scope.claims.map((claim) => [claim.id, claim]));
  const claim = findClaimByReference(scope.claims, claimsById, args);
  if (!claim) {
    return null;
  }

  const limit = Math.max(1, Math.min(args.limit ?? 20, 100));
  const [historyEntries, publishRuns] = await Promise.all([
    readClaimHistoryByClaimId(repoRoot, claim.id),
    readNdjsonFile<PublishRunRecord>(resolveCodemapPath(repoRoot, CODEMAP_FILES.publishRunsNdjson)),
  ]);
  const runById = new Map(publishRuns.map((run) => [run.id, run]));
  const history = historyEntries
    .filter((entry) => entry.claimId === claim.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));

  return {
    claim: summarizeClaim(claim),
    totalEntries: history.length,
    history: history.slice(0, limit).map((entry) => ({
      ...entry,
      run: runById.get(entry.runId),
    })),
  };
}

export async function getCodemapPublishRun(
  repoRoot: string,
  args: CodemapPublishRunArgs = {},
): Promise<CodemapPublishRunResponse | null> {
  const runIndex = await readRunHistoryIndex(repoRoot);
  const indexedRuns = [...(runIndex?.runs ?? [])].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId),
  );

  let selectedRun = args.run_id
    ? indexedRuns.find((run) => run.runId === args.run_id) ?? null
    : indexedRuns[0] ?? null;

  if (!selectedRun) {
    const publishRuns = (await readPublishRuns(repoRoot))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const fallbackRun = args.run_id
      ? publishRuns.find((run) => run.id === args.run_id) ?? null
      : publishRuns[0] ?? null;
    if (!fallbackRun) {
      return null;
    }
    selectedRun = {
      runId: fallbackRun.id,
      createdAt: fallbackRun.createdAt,
      trigger: fallbackRun.trigger,
      refreshMode: fallbackRun.refreshMode,
      changedFiles: [...fallbackRun.changedFiles].sort(),
      impactedClaimTypes: [...fallbackRun.impactedClaimTypes].sort(),
      targetedSourcePaths: [...fallbackRun.targetedSourcePaths].sort(),
      claimHistoryEntries: 0,
      verificationHistoryEntries: 0,
      claimPartitionPath: getClaimRunHistoryPartitionFile(fallbackRun.id),
      verificationPartitionPath: getVerificationRunHistoryPartitionFile(fallbackRun.id),
    };
  }

  const claimLimit = Math.max(1, Math.min(args.claim_limit ?? 20, 100));
  const verificationLimit = Math.max(1, Math.min(args.verification_limit ?? 20, 100));
  const [claimHistory, verificationHistory] = await Promise.all([
    readClaimHistoryByRunId(repoRoot, selectedRun.runId),
    readVerificationHistoryByRunId(repoRoot, selectedRun.runId),
  ]);
  const run = {
    ...selectedRun,
    claimHistoryEntries: Math.max(selectedRun.claimHistoryEntries, claimHistory.length),
    verificationHistoryEntries: Math.max(selectedRun.verificationHistoryEntries, verificationHistory.length),
  };

  return {
    run,
    claimHistory: claimHistory
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, claimLimit),
    verificationHistory: verificationHistory
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .slice(0, verificationLimit),
  };
}

export async function getCodemapConflicts(
  repoRoot: string,
  args: CodemapConflictSearchArgs = {}
): Promise<CodemapConflictListResponse> {
  const context = await loadCodemapQueryContext(repoRoot);
  const scope = await applyQueryScope(repoRoot, context, args);
  const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
  const claimId = args.claim_id;

  let conflicts = claimId
    ? scope.claimIds.has(claimId)
      ? context.conflictsByClaimId.get(claimId) ?? []
      : []
    : scope.conflicts;

  if (args.severity) {
    conflicts = conflicts.filter((conflict) => conflict.severity === args.severity);
  }

  if (!claimId) {
    conflicts = conflicts.filter((conflict) =>
      scope.claimIds.has(conflict.claimA) || scope.claimIds.has(conflict.claimB),
    );
  }

  const uniqueConflicts = [...new Map(conflicts.map((conflict) => [conflict.id, conflict])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    totalConflicts: uniqueConflicts.length,
    conflicts: uniqueConflicts.slice(0, limit).map((conflict) => ({
      ...conflict,
      claimASubject: context.claimsById.get(conflict.claimA)?.subject ?? conflict.claimA,
      claimBSubject: context.claimsById.get(conflict.claimB)?.subject ?? conflict.claimB,
    })),
  };
}

export async function getCodemapVerifyClaim(
  repoRoot: string,
  args: CodemapClaimLookupArgs,
): Promise<CodemapVerifyClaimResponse | null> {
  const detail = await getCodemapClaim(repoRoot, args);
  if (!detail) {
    return null;
  }

  const snapshots = await Promise.all(detail.snapshots.map((snapshot) => getWorkspaceSnapshotState(repoRoot, snapshot)));
  const verification = [...detail.verification].sort(compareVerificationRecords);
  const conflicts = detail.conflicts.map((conflict) => ({
    ...conflict,
    otherClaimId: conflict.claimA === detail.claim.id ? conflict.claimB : conflict.claimA,
    otherClaimSubject: conflict.claimA === detail.claim.id ? conflict.claimB : conflict.claimA,
  }));
  const context = await loadCodemapQueryContext(repoRoot);
  const enrichedConflicts = conflicts.map((conflict) => ({
    ...conflict,
    otherClaimSubject: context.claimsById.get(conflict.otherClaimId)?.subject ?? conflict.otherClaimId,
  }));

  return {
    claim: detail.claim,
    verdict: determineVerifyVerdict(detail.claim, verification, detail.conflicts, snapshots),
    evidenceIds: [...detail.claim.evidenceSpanIds].sort(),
    verification,
    snapshots,
    conflicts: enrichedConflicts,
    failureCount: verification.filter((record) => record.outcome === "fail").length,
    warningCount: verification.filter((record) => record.outcome === "warn").length,
    workspaceDriftCount: snapshots.filter((snapshot) => snapshot.state !== "unchanged").length,
  };
}

export async function getCodemapDiffSinceSnapshot(
  repoRoot: string,
  args: CodemapSnapshotDiffArgs,
): Promise<CodemapSnapshotDiffResponse | null> {
  const context = await loadCodemapQueryContext(repoRoot);
  const snapshotStore = new FileSnapshotStore(repoRoot);
  const snapshots = [...context.snapshotsById.values()];
  const snapshot = selectSnapshotForDiff(snapshots, args.snapshot_id, args.source_path)
    ?? (args.snapshot_id ? await snapshotStore.getById(args.snapshot_id) : null);
  if (!snapshot) {
    return null;
  }

  const [current, storedContent, currentContent] = await Promise.all([
    getWorkspaceSnapshotState(repoRoot, snapshot),
    snapshotStore.getContent(snapshot.id),
    readWorkspaceSnapshotContent(repoRoot, snapshot),
  ]);
  const normalizedSourcePath = normalizeSourcePath(snapshot.sourcePath);
  const activeClaims = context.claims
    .filter((claim) => getClaimSourcePaths(context, claim).includes(normalizedSourcePath))
    .sort(compareClaims);
  const claimLimit = Math.max(1, Math.min(args.claim_limit ?? 10, 50));

  return {
    snapshot,
    current,
    contentDiff: buildSnapshotContentDiff(storedContent, currentContent),
    totalActiveClaims: activeClaims.length,
    activeClaims: activeClaims.slice(0, claimLimit).map(summarizeClaim),
  };
}

export async function getCodemapPublishStatus(
  repoRoot: string,
): Promise<CodemapPublishStatusResponse> {
  const [
    rawScanState,
    rawRefreshPlan,
    rawPublishPlan,
    codePublishPlan,
    knowledgePublishPlan,
    codeIncidents,
    knowledgeIncidents,
    compatibility,
    compatibilityKnowledge,
    historyStorage,
    runIndex,
    publishRuns,
  ] = await Promise.all([
    readJsonFile<CodemapCombinedScanState | CodemapScanState>(resolveCodemapPath(repoRoot, CODEMAP_FILES.scanState)),
    readJsonFile<CodemapCombinedRefreshPlan | CodemapRefreshPlan>(resolveCodemapPath(repoRoot, CODEMAP_FILES.refreshPlan)),
    readJsonFile<CombinedPublishPlan | PublishPlan>(resolveCodemapPath(repoRoot, CODEMAP_FILES.publishPlan)),
    readJsonFile<PublishPlan>(resolveCodemapPath(repoRoot, CODEMAP_FILES.codePublishPlan)),
    readJsonFile<PublishPlan>(resolveCodemapPath(repoRoot, CODEMAP_FILES.knowledgePublishPlan)),
    readNdjsonFile<PublishIncident>(resolveCodemapPath(repoRoot, CODEMAP_FILES.incidentsNdjson)),
    readNdjsonFile<PublishIncident>(resolveCodemapPath(repoRoot, CODEMAP_FILES.knowledgeIncidentsNdjson)),
    readJsonFile<CompatibilityParityReport>(resolveCodemapPath(repoRoot, CODEMAP_FILES.compatibilityParity)),
    readJsonFile<CompatibilityKnowledgeParityReport>(resolveCodemapPath(repoRoot, CODEMAP_FILES.compatibilityKnowledgeParity)),
    readJsonFile<HistoryStorageStatus>(resolveCodemapPath(repoRoot, CODEMAP_FILES.historyStorageStatus)),
    readRunHistoryIndex(repoRoot),
    readPublishRuns(repoRoot),
  ]);
  const scanState = normalizeCombinedScanState(rawScanState);
  const refreshPlan = normalizeCombinedRefreshPlan(rawRefreshPlan);
  const publishPlan = normalizeCombinedPublishPlan(rawPublishPlan) ?? buildCombinedPublishPlan({
    code: codePublishPlan ?? undefined,
    knowledge: knowledgePublishPlan ?? undefined,
  });

  const latestIndexedRun = [...(runIndex?.runs ?? [])]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.runId.localeCompare(left.runId))
    .at(0);
  const latestRun = latestIndexedRun
    ? publishRuns.find((run) => run.id === latestIndexedRun.runId) ?? {
        id: latestIndexedRun.runId,
        createdAt: latestIndexedRun.createdAt,
        trigger: latestIndexedRun.trigger,
        refreshMode: latestIndexedRun.refreshMode,
        changedFiles: latestIndexedRun.changedFiles,
        impactedClaimTypes: latestIndexedRun.impactedClaimTypes,
        targetedSourcePaths: latestIndexedRun.targetedSourcePaths,
        claims: 0,
        verificationRecords: 0,
        conflicts: 0,
      }
    : [...publishRuns]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
        .at(0);

  const timestamps = [
    latestRun?.createdAt,
    scanState?.generatedAt,
    refreshPlan?.generatedAt,
    publishPlan?.generatedAt,
    compatibility?.generatedAt,
    compatibilityKnowledge?.generatedAt,
    historyStorage?.generatedAt,
  ].filter((value): value is string => Boolean(value)).sort();

  return {
    generatedAt: timestamps.at(-1),
    currentDomain: scanState?.currentDomain ?? refreshPlan?.currentDomain ?? publishPlan?.currentDomain,
    latestRun,
    scanState,
    refreshPlan,
    domainScanStates: scanState?.domains ?? {},
    domainRefreshPlans: refreshPlan?.domains ?? {},
    publishPlan: publishPlan ? summarizePublishPlan(publishPlan) : null,
    domainPublishPlans: Object.fromEntries(
      Object.entries(publishPlan?.domains ?? {})
        .filter((entry): entry is [string, PublishPlan] => Boolean(entry[1]))
        .map(([domain, plan]) => [domain, summarizePublishPlan(plan)]),
    ) as Partial<Record<CodemapStatusDomain, CodemapPublishPlanSummary>>,
    incidents: summarizeIncidents(codeIncidents, knowledgeIncidents),
    compatibility: {
      code: compatibility
        ? {
            legacyBaselinePresent: compatibility.legacyWikiPresent,
            matched: compatibility.summary.matched,
            drifted: compatibility.summary.drifted,
            missingCompatibility: compatibility.summary.missingCompatibility,
            extraCompatibility: compatibility.summary.extraCompatibility,
            noLegacyBaseline: compatibility.summary.noLegacyBaseline,
          }
        : undefined,
      knowledge: compatibilityKnowledge
        ? {
            legacyBaselinePresent: compatibilityKnowledge.legacyKnowledgePresent,
            status: compatibilityKnowledge.article.status,
            similarity: compatibilityKnowledge.article.similarity,
          }
        : undefined,
    },
    historyStorage: historyStorage ? summarizeHistoryStorage(historyStorage) : null,
  };
}

export function formatCodemapOverview(overview: CodemapOverviewResponse): string {
  if (overview.totalClaims === 0) {
    return "No CodeMap claims found. Run a scan with canonical CodeMap output to populate .codemap/.";
  }

  const lines = [
    "# CodeMap Overview",
    "",
    `Claims: ${overview.totalClaims} | Conflicts: ${overview.totalConflicts}${overview.generatedAt ? ` | Generated: ${overview.generatedAt}` : ""}`,
    "",
    "Status Counts",
    ...overview.statusCounts.map((entry) => `- ${entry.status}: ${entry.count}`),
    "",
    "Claim Types",
    ...overview.typeCounts.map((entry) => {
      const statusParts = [
        entry.verified > 0 ? `verified ${entry.verified}` : "",
        entry.inferred > 0 ? `inferred ${entry.inferred}` : "",
        entry.stale > 0 ? `stale ${entry.stale}` : "",
        entry.quarantined > 0 ? `quarantined ${entry.quarantined}` : "",
      ].filter(Boolean);
      return `- ${entry.type}: ${entry.count}${statusParts.length > 0 ? ` (${statusParts.join(", ")})` : ""}`;
    }),
    "",
    "Recent Claims",
    ...overview.recentClaims.map((claim) =>
      `- ${claim.claimId} | ${claim.type} | [${claim.status}] ${claim.subject} | confidence ${claim.confidence.toFixed(2)}`,
    ),
  ];

  return lines.join("\n");
}

export function formatCodemapKnowledgeOverview(overview: CodemapKnowledgeOverviewResponse): string {
  if (overview.totalClaims === 0) {
    return "No canonical knowledge claims found. Materialize knowledge notes into CodeMap to query decisions, questions, people, and themes.";
  }

  const lines = [
    "# CodeMap Knowledge Overview",
    "",
    `Claims: ${overview.totalClaims} | Conflicts: ${overview.totalConflicts}${overview.generatedAt ? ` | Generated: ${overview.generatedAt}` : ""}`,
    "",
    "Knowledge Types",
    ...overview.typeCounts.map((entry) => {
      const statusParts = [
        entry.verified > 0 ? `verified ${entry.verified}` : "",
        entry.inferred > 0 ? `inferred ${entry.inferred}` : "",
        entry.stale > 0 ? `stale ${entry.stale}` : "",
        entry.quarantined > 0 ? `quarantined ${entry.quarantined}` : "",
      ].filter(Boolean);
      return `- ${entry.type}: ${entry.count}${statusParts.length > 0 ? ` (${statusParts.join(", ")})` : ""}`;
    }),
    "",
  ];

  if (overview.decisions.length > 0) {
    lines.push("Key Decisions");
    lines.push(...overview.decisions.map((claim) => `- [${claim.status}] ${claim.subject}`));
    lines.push("");
  }

  if (overview.openQuestions.length > 0) {
    lines.push("Open Questions");
    lines.push(...overview.openQuestions.map((claim) => `- [${claim.status}] ${claim.subject}`));
    lines.push("");
  }

  if (overview.themes.length > 0) {
    lines.push("Recurring Themes");
    lines.push(...overview.themes.map((claim) => `- [${claim.status}] ${claim.subject}`));
    lines.push("");
  }

  if (overview.people.length > 0) {
    lines.push("People");
    lines.push(...overview.people.map((claim) => `- [${claim.status}] ${claim.subject}`));
    lines.push("");
  }

  if (overview.summaries.length > 0) {
    lines.push("Recent Note Summaries");
    lines.push(...overview.summaries.map((claim) => `- [${claim.status}] ${claim.subject}`));
  }

  return lines.join("\n");
}

export function formatCodemapSearchClaims(result: CodemapSearchClaimsResponse): string {
  if (result.totalMatches === 0) {
    return "No CodeMap claims matched the supplied filters.";
  }

  const lines = [
    `${result.totalMatches} matching CodeMap claim${result.totalMatches === 1 ? "" : "s"}`,
    "",
    ...result.claims.map((claim) =>
      `- ${claim.claimId} | ${claim.type} | [${claim.status}] ${claim.subject}${claim.tags.length > 0 ? ` | tags: ${claim.tags.join(", ")}` : ""}`,
    ),
  ];

  return lines.join("\n");
}

export function formatCodemapClaim(detail: CodemapClaimDetailResponse): string {
  const lines = [
    detail.claim.id,
    `Type: ${detail.claim.type}`,
    `Status: ${detail.claim.status}`,
    `Subject: ${detail.claim.subject}`,
    `Text: ${detail.claim.text}`,
    `Support: ${detail.claim.supportScore.toFixed(2)} | Publication: ${detail.claim.publicationConfidence.toFixed(2)}`,
    `Tags: ${detail.claim.tags.join(", ") || "none"}`,
    `First seen: ${detail.claim.firstSeenAt}`,
    `Last verified: ${detail.claim.lastVerifiedAt ?? "not yet verified"}`,
    "",
    "Snapshots",
    ...(detail.snapshots.length > 0
      ? detail.snapshots.map((snapshot) =>
        `- ${snapshot.id} | ${snapshot.sourcePath} | ${snapshot.language ?? "unknown"} | hash ${snapshot.contentHash.slice(0, 12)}`,
      )
      : ["- none"]),
    "",
    "Evidence",
    ...(detail.evidence.length > 0
      ? detail.evidence.map((entry) =>
        `- ${entry.id} | ${entry.sourcePath}:${entry.startLine}-${entry.endLine} | ${entry.detectorMethod} | confidence ${entry.confidence.toFixed(2)}`,
      )
      : ["- none"]),
    "",
    "Verification",
    ...(detail.verification.length > 0
      ? detail.verification.map((record) => `- ${record.verifier} ${record.outcome} — ${record.reason}`)
      : ["- none"]),
    "",
    "Conflicts",
    ...(detail.conflicts.length > 0
      ? detail.conflicts.map((conflict) =>
        `- ${conflict.id} [${conflict.severity}] ${conflict.relation} — ${conflict.rationale}`,
      )
      : ["- none"]),
  ];

  return lines.join("\n");
}

export function formatCodemapEvidence(
  response: CodemapToolEvidenceResponse,
  snapshots: SourceSnapshot[]
): string {
  if (response.evidence.length === 0) {
    return `No evidence spans found for ${response.claimId}.`;
  }

  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const lines = [
    `Evidence for ${response.claimId}`,
    "",
    ...response.evidence.map((entry) => {
      const snapshot = snapshotById.get(entry.snapshotId);
      return `- ${entry.id} | ${entry.sourcePath}:${entry.startLine}-${entry.endLine} | ${entry.detectorMethod} | confidence ${entry.confidence.toFixed(2)} | snapshot ${snapshot?.contentHash.slice(0, 12) ?? entry.snapshotId}`;
    }),
  ];

  return lines.join("\n");
}

export function formatCodemapClaimHistory(response: CodemapClaimHistoryResponse): string {
  if (response.totalEntries === 0) {
    return `No verification history found for ${response.claim.claimId}.`;
  }

  const lines = [
    `Verification history for ${response.claim.claimId}`,
    `Subject: ${response.claim.subject}`,
    `Type: ${response.claim.type} | Status: ${response.claim.status}`,
    `Entries: ${response.totalEntries}`,
    "",
    ...response.history.map((entry) => {
      const runSummary = entry.run
        ? ` | run ${entry.run.id} (${entry.run.trigger}, ${entry.run.refreshMode})`
        : "";
      const previousSummary = entry.previousOutcome
        ? ` | prev ${entry.previousOutcome}${entry.previousCreatedAt ? ` @ ${entry.previousCreatedAt}` : ""}`
        : "";
      return `- ${entry.createdAt} | ${entry.verifier} ${entry.outcome} | ${entry.transition}${runSummary}${previousSummary} — ${entry.reason}`;
    }),
  ];

  return lines.join("\n");
}

export function formatCodemapClaimStateHistory(response: CodemapClaimStateHistoryResponse): string {
  if (response.totalEntries === 0) {
    return `No claim-state history found for ${response.claim.claimId}.`;
  }

  const lines = [
    `Claim-state history for ${response.claim.claimId}`,
    `Subject: ${response.claim.subject}`,
    `Type: ${response.claim.type} | Status: ${response.claim.status}`,
    `Entries: ${response.totalEntries}`,
    "",
    ...response.history.map((entry) => {
      const runSummary = entry.run
        ? ` | run ${entry.run.id} (${entry.run.trigger}, ${entry.run.refreshMode})`
        : "";
      const previousSummary = entry.previousStatus
        ? ` | prev ${entry.previousStatus}${entry.previousCreatedAt ? ` @ ${entry.previousCreatedAt}` : ""}`
        : "";
      return `- ${entry.createdAt} | ${entry.transition} | ${entry.status}${runSummary}${previousSummary} — ${entry.subject}`;
    }),
  ];

  return lines.join("\n");
}

export function formatCodemapPublishRun(response: CodemapPublishRunResponse): string {
  const lines = [
    `Publish run ${response.run.runId}`,
    `Created: ${response.run.createdAt}`,
    `Trigger: ${response.run.trigger} | Refresh: ${response.run.refreshMode}`,
    `Changed files: ${response.run.changedFiles.length > 0 ? response.run.changedFiles.join(", ") : "none"}`,
    `Impacted claim types: ${response.run.impactedClaimTypes.length > 0 ? response.run.impactedClaimTypes.join(", ") : "none"}`,
    `Targeted sources: ${response.run.targetedSourcePaths.length > 0 ? response.run.targetedSourcePaths.join(", ") : "none"}`,
    `Claim history entries: ${response.run.claimHistoryEntries}`,
    `Verification history entries: ${response.run.verificationHistoryEntries}`,
    "",
    "Claim-state changes",
    ...(response.claimHistory.length > 0
      ? response.claimHistory.map((entry) =>
        `- ${entry.createdAt} | ${entry.transition} | [${entry.status}] ${entry.subject}${entry.previousStatus ? ` | prev ${entry.previousStatus}` : ""}`,
      )
      : ["- none"]),
    "",
    "Verification changes",
    ...(response.verificationHistory.length > 0
      ? response.verificationHistory.map((entry) =>
        `- ${entry.createdAt} | ${entry.verifier} ${entry.outcome} | ${entry.transition} — ${entry.claimSubject ?? entry.claimId}`,
      )
      : ["- none"]),
  ];

  return lines.join("\n");
}

export function formatCodemapConflicts(result: CodemapConflictListResponse): string {
  if (result.totalConflicts === 0) {
    return "No conflicts found for the current CodeMap query.";
  }

  const lines = [
    `${result.totalConflicts} CodeMap conflict${result.totalConflicts === 1 ? "" : "s"}`,
    "",
    ...result.conflicts.map((conflict) =>
      `- ${conflict.id} [${conflict.severity}] ${conflict.relation} — ${conflict.claimASubject} <> ${conflict.claimBSubject} | ${conflict.rationale}`,
    ),
  ];

  return lines.join("\n");
}

export function formatCodemapVerifyClaim(response: CodemapVerifyClaimResponse): string {
  const lines = [
    `Verify claim ${response.claim.id}`,
    `Type: ${response.claim.type}`,
    `Status: ${response.claim.status} | Verdict: ${response.verdict}`,
    `Subject: ${response.claim.subject}`,
    `Evidence refs: ${response.evidenceIds.length > 0 ? response.evidenceIds.join(", ") : "none"}`,
    `Verification records: ${response.verification.length} | warnings ${response.warningCount} | failures ${response.failureCount}`,
    `Workspace drift: ${response.workspaceDriftCount}`,
    "",
    "Source snapshots",
    ...(response.snapshots.length > 0
      ? response.snapshots.map((snapshot) => {
          const currentSummary = snapshot.state === "unchanged"
            ? "unchanged"
            : snapshot.state === "missing"
              ? "missing from workspace"
              : `changed to ${snapshot.currentContentHash?.slice(0, 12) ?? "unknown"}`;
          return `- ${snapshot.snapshotId} | ${snapshot.sourcePath} | ${snapshot.snapshotContentHash.slice(0, 12)} | ${currentSummary}`;
        })
      : ["- none"]),
    "",
    "Verification",
    ...(response.verification.length > 0
      ? response.verification.map((record) =>
          `- ${record.verifier} ${record.outcome} @ ${record.createdAt} — ${record.reason}`,
        )
      : ["- none"]),
    "",
    "Conflicts",
    ...(response.conflicts.length > 0
      ? response.conflicts.map((conflict) =>
          `- ${conflict.id} [${conflict.severity}] ${conflict.relation} — ${conflict.otherClaimSubject} | ${conflict.rationale}`,
        )
      : ["- none"]),
  ];

  return lines.join("\n");
}

export function formatCodemapSnapshotDiff(response: CodemapSnapshotDiffResponse): string {
  const stateSummary = response.current.state === "unchanged"
    ? "unchanged"
    : response.current.state === "missing"
      ? "missing from workspace"
      : `changed to ${response.current.currentContentHash?.slice(0, 12) ?? "unknown"}`;
  const lines = [
    `Snapshot diff for ${response.snapshot.id}`,
    `Source: ${response.snapshot.sourcePath}`,
    `Stored hash: ${response.snapshot.contentHash}`,
    `Current state: ${stateSummary}`,
    `Current snapshot id: ${response.current.currentSnapshotId ?? "not available"}`,
    `Active claims: ${response.totalActiveClaims}`,
    "",
    "Affected claims",
    ...(response.activeClaims.length > 0
      ? response.activeClaims.map((claim) =>
          `- ${claim.claimId} | ${claim.type} | [${claim.status}] ${claim.subject}`,
        )
      : ["- none"]),
  ];

  if (response.contentDiff?.kind === "changed") {
    lines.push(
      "",
      `Stored excerpt (${response.contentDiff.stored?.startLine ?? 0}-${response.contentDiff.stored?.endLine ?? 0})`,
      ...((response.contentDiff.stored?.excerpt ?? []).map((line) => `- ${line}`)),
      "",
      `Current excerpt (${response.contentDiff.current?.startLine ?? 0}-${response.contentDiff.current?.endLine ?? 0})`,
      ...((response.contentDiff.current?.excerpt ?? []).map((line) => `+ ${line}`)),
    );
  } else if (response.contentDiff?.kind === "missing") {
    lines.push(
      "",
      "Stored excerpt",
      ...((response.contentDiff.stored?.excerpt ?? []).map((line) => `- ${line}`)),
    );
  } else if (response.contentDiff?.kind === "unavailable") {
    lines.push("", "Stored content: unavailable");
  }

  return lines.join("\n");
}

export function formatCodemapPublishStatus(response: CodemapPublishStatusResponse): string {
  const lines = [
    "CodeMap publish status",
    `Generated: ${response.generatedAt ?? "unknown"}`,
    `Current domain: ${response.currentDomain ?? "unknown"}`,
  ];

  if (response.latestRun) {
    lines.push(
      `Latest run: ${response.latestRun.id} @ ${response.latestRun.createdAt}`,
      `Trigger: ${response.latestRun.trigger} | Refresh: ${response.latestRun.refreshMode}`,
      `Changed files: ${response.latestRun.changedFiles.length > 0 ? response.latestRun.changedFiles.join(", ") : "none"}`,
      `Impacted claim types: ${response.latestRun.impactedClaimTypes.length > 0 ? response.latestRun.impactedClaimTypes.join(", ") : "none"}`,
    );
  } else {
    lines.push("Latest run: none");
  }

  if (response.scanState) {
    lines.push(
      "",
      "Scan state",
      `- trigger ${response.scanState.trigger} | claims ${response.scanState.claims} | snapshots ${response.scanState.snapshots} | evidence ${response.scanState.evidence} | verification ${response.scanState.verificationRecords} | conflicts ${response.scanState.conflicts}`,
      `- incidents ${response.scanState.incidents} | views ${response.scanState.views.length} | compatibility views ${response.scanState.compatibilityViews.length}`,
    );
  }

  if (response.refreshPlan) {
    lines.push(
      "",
      "Refresh plan",
      `- ${response.refreshPlan.mode} | changed files ${response.refreshPlan.changedFiles.length} | targeted claims ${response.refreshPlan.targetedClaimCount} | targeted sources ${response.refreshPlan.targetedSourceCount}`,
      `- impacted claim types: ${response.refreshPlan.impactedClaimTypes.length > 0 ? response.refreshPlan.impactedClaimTypes.join(", ") : "none"}`,
    );
  }

  const domainEntries = (["code", "knowledge"] as CodemapStatusDomain[])
    .map((domain) => ({
      domain,
      scanState: response.domainScanStates[domain],
      refreshPlan: response.domainRefreshPlans[domain],
    }))
    .filter((entry) => entry.scanState || entry.refreshPlan);

  if (domainEntries.length > 0) {
    lines.push("", "Domain status");
    for (const entry of domainEntries) {
      if (entry.scanState) {
        lines.push(
          `- ${entry.domain}${response.currentDomain === entry.domain ? " (current)" : ""} | scan ${entry.scanState.generatedAt} | trigger ${entry.scanState.trigger} | claims ${entry.scanState.claims} | incidents ${entry.scanState.incidents}`,
        );
      }
      if (entry.refreshPlan) {
        lines.push(
          `- ${entry.domain}${response.currentDomain === entry.domain ? " (current)" : ""} | refresh ${entry.refreshPlan.generatedAt} | ${entry.refreshPlan.mode} | changed files ${entry.refreshPlan.changedFiles.length} | targeted claims ${entry.refreshPlan.targetedClaimCount}`,
        );
      }
    }
  }

  if (response.publishPlan) {
    lines.push(
      "",
      "Publish plan",
      `- generated ${response.publishPlan.generatedAt} | items ${response.publishPlan.totalItems} | blocking claims ${response.publishPlan.blockingClaims}`,
      ...response.publishPlan.decisionCounts.map((entry) => `- ${entry.decision}: ${entry.count}`),
    );
  }

  const domainPublishEntries = (["code", "knowledge"] as CodemapStatusDomain[])
    .map((domain) => ({
      domain,
      publishPlan: response.domainPublishPlans[domain],
    }))
    .filter((entry) => entry.publishPlan);

  if (domainPublishEntries.length > 0) {
    lines.push("", "Domain publish plans");
    for (const entry of domainPublishEntries) {
      lines.push(
        `- ${entry.domain}${response.currentDomain === entry.domain ? " (current)" : ""} | generated ${entry.publishPlan!.generatedAt} | items ${entry.publishPlan!.totalItems} | blocking claims ${entry.publishPlan!.blockingClaims}`,
      );
      lines.push(...entry.publishPlan!.decisionCounts.map((count) => `- ${entry.domain} ${count.decision}: ${count.count}`));
    }
  }

  lines.push(
    "",
    "Incidents",
    `- total ${response.incidents.total} | code ${response.incidents.code} | knowledge ${response.incidents.knowledge}`,
  );
  if (response.incidents.severityCounts.length > 0) {
    lines.push(...response.incidents.severityCounts.map((entry) => `- ${entry.severity}: ${entry.count}`));
  }

  if (response.compatibility.code || response.compatibility.knowledge) {
    lines.push("", "Compatibility");
    if (response.compatibility.code) {
      lines.push(
        `- code baseline ${response.compatibility.code.legacyBaselinePresent ? "present" : "missing"} | matched ${response.compatibility.code.matched} | drifted ${response.compatibility.code.drifted} | missing ${response.compatibility.code.missingCompatibility} | extra ${response.compatibility.code.extraCompatibility} | no-baseline ${response.compatibility.code.noLegacyBaseline}`,
      );
    }
    if (response.compatibility.knowledge) {
      lines.push(
        `- knowledge baseline ${response.compatibility.knowledge.legacyBaselinePresent ? "present" : "missing"} | status ${response.compatibility.knowledge.status}${response.compatibility.knowledge.similarity === null ? "" : ` | similarity ${response.compatibility.knowledge.similarity.toFixed(2)}`}`,
      );
    }
  }

  if (response.historyStorage) {
    lines.push(
      "",
      "History storage",
      `- mode ${response.historyStorage.mode} | hot ${formatBytes(response.historyStorage.hotBytes)} | archive ${formatBytes(response.historyStorage.archiveBytes)} | total ${formatBytes(response.historyStorage.totalBytes)}`,
      `- archived segments ${response.historyStorage.archivedSegments} | planned segments ${response.historyStorage.plannedSegments} | warning ${response.historyStorage.warningThresholdExceeded ? "yes" : "no"} | over budget ${response.historyStorage.overBudget ? "yes" : "no"}`,
      `- snapshots hot ${formatBytes(response.historyStorage.snapshotHotBytes)} | snapshots archive ${formatBytes(response.historyStorage.snapshotArchiveBytes)} | active ${response.historyStorage.activeSnapshots} | historical hot ${response.historyStorage.historicalHotSnapshots} | archived ${response.historyStorage.archivedSnapshots} | planned ${response.historyStorage.plannedSnapshots}`,
    );
  }

  return lines.join("\n");
}
