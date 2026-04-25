export type SourceKind = "code" | "note" | "config" | "generated" | "external";

export type CodemapDetectorMethod = "ast" | "regex" | "heuristic" | "manual" | "imported";

export type ClaimStatus =
  | "candidate"
  | "verified"
  | "inferred"
  | "stale"
  | "conflicting"
  | "superseded"
  | "quarantined";

export type ClaimType =
  | "route"
  | "model"
  | "relation"
  | "component"
  | "library_module"
  | "config_file"
  | "package_dependency"
  | "env_var"
  | "middleware"
  | "dependency_hotspot"
  | "knowledge_decision"
  | "knowledge_question"
  | "knowledge_theme"
  | "knowledge_person"
  | "knowledge_summary";

export type VerifierKind =
  | "line-exists"
  | "hash-match"
  | "ast-shape"
  | "schema-consistency"
  | "component-consistency"
  | "library-consistency"
  | "config-consistency"
  | "dependency-consistency"
  | "env-consistency"
  | "middleware-consistency"
  | "hotspot-consistency"
  | "conflict-check"
  | "knowledge-support"
  | "manual-review";

export type VerificationOutcome = "pass" | "fail" | "warn";
export type VerificationHistoryTransition = "initial" | "revalidated" | "changed";
export type ClaimHistoryTransition = "initial" | "revalidated" | "status_changed" | "revised";
export type CodemapHistoryPolicyMode = "observe" | "archive" | "compact" | "delete";
export type HistoryArchiveAction = "archive" | "compact" | "delete";
export type HistoryArchiveSegmentState = "planned" | "archived";
export type HistoryArchiveCompression = "none" | "gzip";

export type ConflictRelation = "conflicts" | "narrows" | "supersedes" | "duplicates";

export type ConflictSeverity = "low" | "medium" | "high";

export type PublishDecision = "publish" | "republish_with_warning" | "quarantine" | "deprecate" | "supersede" | "skip";

export interface SourceSnapshot {
  id: string;
  sourcePath: string;
  sourceKind: SourceKind;
  contentHash: string;
  gitCommit?: string;
  language?: string;
  createdAt: string;
  sizeBytes: number;
}

export interface SnapshotManifestEntry {
  snapshotId: string;
  sourcePath: string;
  contentHash: string;
  createdAt: string;
}

export interface SnapshotManifest {
  version: string;
  generatedAt: string;
  entries: SnapshotManifestEntry[];
}

export interface EvidenceSpan {
  id: string;
  snapshotId: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  excerptHash: string;
  detectorMethod: CodemapDetectorMethod;
  confidence: number;
  labels: string[];
}

export interface Claim {
  id: string;
  type: ClaimType;
  subject: string;
  text: string;
  sourceSnapshotIds: string[];
  evidenceSpanIds: string[];
  status: ClaimStatus;
  supportScore: number;
  publicationConfidence: number;
  firstSeenAt: string;
  lastVerifiedAt?: string;
  supersedes?: string[];
  supersededBy?: string[];
  tags: string[];
}

export interface ClaimIndexEntry {
  claimId: string;
  type: ClaimType;
  status: ClaimStatus;
  subject: string;
  tags: string[];
}

export interface ClaimIndex {
  generatedAt: string;
  claims: ClaimIndexEntry[];
}

export interface VerificationRecord {
  id: string;
  claimId: string;
  verifier: VerifierKind;
  outcome: VerificationOutcome;
  reason: string;
  createdAt: string;
  snapshotIdsChecked: string[];
}

export interface VerificationHistoryEntry extends VerificationRecord {
  runId: string;
  transition: VerificationHistoryTransition;
  claimType?: ClaimType;
  claimSubject?: string;
  claimStatus?: ClaimStatus;
  previousRecordId?: string;
  previousOutcome?: VerificationOutcome;
  previousReason?: string;
  previousCreatedAt?: string;
  previousSnapshotIdsChecked?: string[];
}

export interface ClaimHistoryEntry {
  id: string;
  runId: string;
  claimId: string;
  claimType: ClaimType;
  subject: string;
  status: ClaimStatus;
  createdAt: string;
  transition: ClaimHistoryTransition;
  supportScore: number;
  publicationConfidence: number;
  sourceSnapshotIds: string[];
  evidenceSpanIds: string[];
  tags: string[];
  previousStatus?: ClaimStatus;
  previousSubject?: string;
  previousCreatedAt?: string;
  previousSupportScore?: number;
  previousPublicationConfidence?: number;
  previousSourceSnapshotIds?: string[];
  previousEvidenceSpanIds?: string[];
  previousTags?: string[];
}

export interface HistoryPartitionIndexEntry {
  claimId: string;
  entries: number;
  latestCreatedAt?: string;
  partitionPath: string;
}

export interface HistoryPartitionIndex {
  generatedAt: string;
  claims: HistoryPartitionIndexEntry[];
}

export interface HistoryRunIndexEntry {
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
}

export interface HistoryRunIndex {
  generatedAt: string;
  runs: HistoryRunIndexEntry[];
}

export interface CodemapHistoryPolicy {
  version: 1;
  updatedAt: string;
  mode: CodemapHistoryPolicyMode;
  maxHotBytes?: number;
  targetHotBytes?: number;
  warnAtPercent: number;
  segmentTargetBytes: number;
  preserveFullLedgers: boolean;
}

export interface HistoryArchiveCandidate {
  runId: string;
  createdAt: string;
  recommendedAction: HistoryArchiveAction;
  estimatedBytes: number;
  claimHistoryEntries: number;
  verificationHistoryEntries: number;
  claimPartitionPath: string;
  verificationPartitionPath: string;
}

export interface HistoryArchiveSegment {
  id: string;
  createdAt: string;
  mode: CodemapHistoryPolicyMode;
  state: HistoryArchiveSegmentState;
  runIds: string[];
  claimHistoryEntries: number;
  verificationHistoryEntries: number;
  bytes: number;
  compression: HistoryArchiveCompression;
  bundlePath?: string;
  partitionPaths: string[];
}

export interface HistoryArchiveManifest {
  version: 1;
  generatedAt: string;
  mode: CodemapHistoryPolicyMode;
  segments: HistoryArchiveSegment[];
  totalArchiveBytes: number;
  plannedBytes: number;
}

export interface HistoryArchiveBundle {
  version: 1;
  segmentId: string;
  createdAt: string;
  mode: CodemapHistoryPolicyMode;
  runIds: string[];
  claimHistory: ClaimHistoryEntry[];
  verificationHistory: VerificationHistoryEntry[];
  partitionPaths: string[];
}

export interface HistoryArchiveClaimIndexEntry {
  claimId: string;
  claimHistorySegments: string[];
  verificationHistorySegments: string[];
  claimHistoryEntries: number;
  verificationHistoryEntries: number;
}

export interface HistoryArchiveClaimIndex {
  version: 1;
  generatedAt: string;
  claims: HistoryArchiveClaimIndexEntry[];
}

export interface HistoryArchiveRunIndexEntry {
  runId: string;
  createdAt?: string;
  segmentIds: string[];
  claimHistoryEntries: number;
  verificationHistoryEntries: number;
}

export interface HistoryArchiveRunIndex {
  version: 1;
  generatedAt: string;
  runs: HistoryArchiveRunIndexEntry[];
}

export interface SnapshotArchiveCandidate {
  snapshotId: string;
  sourcePath: string;
  createdAt: string;
  contentHash: string;
  estimatedBytes: number;
  snapshotPath: string;
  contentPath?: string;
}

export interface SnapshotArchiveSegment {
  id: string;
  snapshotId: string;
  sourcePath: string;
  createdAt: string;
  contentHash: string;
  sizeBytes: number;
  bytes: number;
  state: HistoryArchiveSegmentState;
  compression: HistoryArchiveCompression;
  bundlePath?: string;
  metadataPath?: string;
  contentPath?: string;
}

export interface SnapshotArchiveManifest {
  version: 1;
  generatedAt: string;
  mode: CodemapHistoryPolicyMode;
  segments: SnapshotArchiveSegment[];
  totalArchiveBytes: number;
  plannedBytes: number;
}

export interface SnapshotArchiveBundle {
  version: 1;
  segmentId: string;
  createdAt: string;
  mode: CodemapHistoryPolicyMode;
  snapshot: SourceSnapshot;
  content?: string;
}

export interface SnapshotArchiveIndexEntry {
  snapshotId: string;
  sourcePath: string;
  createdAt: string;
  contentHash: string;
  sizeBytes: number;
  bytes: number;
  segmentId: string;
  bundlePath?: string;
  metadataPath?: string;
  contentPath?: string;
}

export interface SnapshotArchiveIndex {
  version: 1;
  generatedAt: string;
  snapshots: SnapshotArchiveIndexEntry[];
}

export interface SnapshotStorageStatus {
  hotBytes: number;
  archiveBytes: number;
  totalBytes: number;
  activeSnapshots: number;
  historicalHotSnapshots: number;
  archivedSnapshots: number;
  plannedSnapshots: number;
}

export interface HistoryStorageStatus {
  version: 1;
  generatedAt: string;
  policy: CodemapHistoryPolicy;
  usage: {
    hotBytes: number;
    totalBytes: number;
    ledgerBytes: number;
    metadataBytes: number;
    byClaimPartitionBytes: number;
    byRunPartitionBytes: number;
    archiveBytes: number;
  };
  counts: {
    claimHistoryEntries: number;
    verificationHistoryEntries: number;
    publishRuns: number;
    claimPartitions: number;
    verificationPartitions: number;
    runClaimPartitions: number;
    runVerificationPartitions: number;
    archivedSegments: number;
    plannedSegments: number;
  };
  budget: {
    maxHotBytes?: number;
    targetHotBytes?: number;
    warnAtPercent: number;
    warnAtBytes?: number;
    warningThresholdExceeded: boolean;
    overBudget: boolean;
  };
  archiveCandidates: HistoryArchiveCandidate[];
  snapshotStorage: SnapshotStorageStatus;
  snapshotArchiveCandidates: SnapshotArchiveCandidate[];
  notes: string[];
}

export interface ConflictEdge {
  id: string;
  claimA: string;
  claimB: string;
  relation: ConflictRelation;
  severity: ConflictSeverity;
  createdAt: string;
  rationale: string;
}

export interface PublishPlanItem {
  claimId: string;
  decision: PublishDecision;
  reason: string;
  blockingConflictIds: string[];
}

export interface PublishPlan {
  domain: "code" | "knowledge";
  generatedAt: string;
  items: PublishPlanItem[];
}

export interface CombinedPublishPlan extends PublishPlan {
  currentDomain: "code" | "knowledge";
  domains: Partial<Record<"code" | "knowledge", PublishPlan>>;
}

export interface RenderedView {
  path: string;
  title: string;
  markdown: string;
  claimIds: string[];
}

export type PublishIncidentSource =
  | "conflict-high"
  | "conflict-medium"
  | "claim-stale-critical"
  | "claim-stale"
  | "claim-conflicting"
  | "claim-quarantined"
  | "compatibility-missing"
  | "compatibility-drift";

export interface PublishIncident {
  id: string;
  createdAt: string;
  severity: ConflictSeverity;
  message: string;
  claimIds: string[];
  source: PublishIncidentSource;
  sourceRecordId?: string;
}

export interface PublishRunRecord {
  id: string;
  createdAt: string;
  trigger: "cli" | "watch" | "mcp" | "hook";
  refreshMode: "full" | "targeted";
  changedFiles: string[];
  impactedClaimTypes: ClaimType[];
  targetedSourcePaths: string[];
  claims: number;
  verificationRecords: number;
  conflicts: number;
}
