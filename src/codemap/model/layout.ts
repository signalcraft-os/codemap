export const CODEMAP_ROOT_DIR = ".codemap" as const;

export const CODEMAP_DIRECTORIES = {
  root: CODEMAP_ROOT_DIR,
  snapshots: `${CODEMAP_ROOT_DIR}/snapshots`,
  snapshotFiles: `${CODEMAP_ROOT_DIR}/snapshots/files`,
  snapshotContents: `${CODEMAP_ROOT_DIR}/snapshots/content`,
  claims: `${CODEMAP_ROOT_DIR}/claims`,
  evidence: `${CODEMAP_ROOT_DIR}/evidence`,
  verification: `${CODEMAP_ROOT_DIR}/verification`,
  history: `${CODEMAP_ROOT_DIR}/history`,
  historyByClaim: `${CODEMAP_ROOT_DIR}/history/by-claim`,
  historyClaimPartitions: `${CODEMAP_ROOT_DIR}/history/by-claim/claims`,
  historyVerificationPartitions: `${CODEMAP_ROOT_DIR}/history/by-claim/verification`,
  historyByRun: `${CODEMAP_ROOT_DIR}/history/by-run`,
  historyRunClaimPartitions: `${CODEMAP_ROOT_DIR}/history/by-run/claims`,
  historyRunVerificationPartitions: `${CODEMAP_ROOT_DIR}/history/by-run/verification`,
  archive: `${CODEMAP_ROOT_DIR}/archive`,
  archiveSegments: `${CODEMAP_ROOT_DIR}/archive/segments`,
  archiveSnapshotSegments: `${CODEMAP_ROOT_DIR}/archive/snapshots`,
  conflicts: `${CODEMAP_ROOT_DIR}/conflicts`,
  publish: `${CODEMAP_ROOT_DIR}/publish`,
  views: `${CODEMAP_ROOT_DIR}/views`,
  codeViews: `${CODEMAP_ROOT_DIR}/views/code`,
  knowledgeViews: `${CODEMAP_ROOT_DIR}/views/knowledge`,
  compatibility: `${CODEMAP_ROOT_DIR}/compatibility`,
  compatibilityWiki: `${CODEMAP_ROOT_DIR}/compatibility/wiki`,
  cache: `${CODEMAP_ROOT_DIR}/cache`,
} as const;

export const CODEMAP_FILES = {
  snapshotManifest: `${CODEMAP_ROOT_DIR}/snapshots/manifest.json`,
  claimsNdjson: `${CODEMAP_ROOT_DIR}/claims/claims.ndjson`,
  claimIndex: `${CODEMAP_ROOT_DIR}/claims/claim-index.json`,
  evidenceNdjson: `${CODEMAP_ROOT_DIR}/evidence/evidence.ndjson`,
  verificationNdjson: `${CODEMAP_ROOT_DIR}/verification/verification.ndjson`,
  verificationHistoryNdjson: `${CODEMAP_ROOT_DIR}/history/verification.ndjson`,
  claimHistoryNdjson: `${CODEMAP_ROOT_DIR}/history/claims.ndjson`,
  verificationHistoryIndex: `${CODEMAP_ROOT_DIR}/history/verification-index.json`,
  claimHistoryIndex: `${CODEMAP_ROOT_DIR}/history/claims-index.json`,
  publishRunsNdjson: `${CODEMAP_ROOT_DIR}/history/publish-runs.ndjson`,
  publishRunsIndex: `${CODEMAP_ROOT_DIR}/history/publish-runs-index.json`,
  historyPolicy: `${CODEMAP_ROOT_DIR}/history/policy.json`,
  historyStorageStatus: `${CODEMAP_ROOT_DIR}/history/storage-status.json`,
  archiveManifest: `${CODEMAP_ROOT_DIR}/archive/manifest.json`,
  archiveClaimIndex: `${CODEMAP_ROOT_DIR}/archive/claim-index.json`,
  archiveRunIndex: `${CODEMAP_ROOT_DIR}/archive/run-index.json`,
  archiveSnapshotManifest: `${CODEMAP_ROOT_DIR}/archive/snapshot-manifest.json`,
  archiveSnapshotIndex: `${CODEMAP_ROOT_DIR}/archive/snapshot-index.json`,
  conflictsNdjson: `${CODEMAP_ROOT_DIR}/conflicts/conflicts.ndjson`,
  codePublishPlan: `${CODEMAP_ROOT_DIR}/publish/code-publish-plan.json`,
  knowledgePublishPlan: `${CODEMAP_ROOT_DIR}/publish/knowledge-publish-plan.json`,
  publishPlan: `${CODEMAP_ROOT_DIR}/publish/publish-plan.json`,
  incidentsNdjson: `${CODEMAP_ROOT_DIR}/publish/incidents.ndjson`,
  indexView: `${CODEMAP_ROOT_DIR}/views/index.md`,
  overviewView: `${CODEMAP_ROOT_DIR}/views/overview.md`,
  knowledgeIndexView: `${CODEMAP_ROOT_DIR}/views/knowledge/index.md`,
  knowledgeOverviewView: `${CODEMAP_ROOT_DIR}/views/knowledge/overview.md`,
  configView: `${CODEMAP_ROOT_DIR}/views/code/config.md`,
  databaseView: `${CODEMAP_ROOT_DIR}/views/code/database.md`,
  impactView: `${CODEMAP_ROOT_DIR}/views/code/impact.md`,
  runtimeView: `${CODEMAP_ROOT_DIR}/views/code/runtime.md`,
  uiView: `${CODEMAP_ROOT_DIR}/views/code/ui.md`,
  librariesView: `${CODEMAP_ROOT_DIR}/views/code/libraries.md`,
  compatibilityParity: `${CODEMAP_ROOT_DIR}/compatibility/parity.json`,
  compatibilityKnowledgeParity: `${CODEMAP_ROOT_DIR}/compatibility/knowledge-parity.json`,
  compatibilityWikiIndex: `${CODEMAP_ROOT_DIR}/compatibility/wiki/index.md`,
  compatibilityWikiOverview: `${CODEMAP_ROOT_DIR}/compatibility/wiki/overview.md`,
  compatibilityWikiDatabase: `${CODEMAP_ROOT_DIR}/compatibility/wiki/database.md`,
  compatibilityWikiUi: `${CODEMAP_ROOT_DIR}/compatibility/wiki/ui.md`,
  compatibilityWikiLibraries: `${CODEMAP_ROOT_DIR}/compatibility/wiki/libraries.md`,
  compatibilityKnowledge: `${CODEMAP_ROOT_DIR}/compatibility/KNOWLEDGE.md`,
  knowledgeIncidentsNdjson: `${CODEMAP_ROOT_DIR}/publish/knowledge-incidents.ndjson`,
  codeScanState: `${CODEMAP_ROOT_DIR}/cache/code-scan-state.json`,
  knowledgeScanState: `${CODEMAP_ROOT_DIR}/cache/knowledge-scan-state.json`,
  scanState: `${CODEMAP_ROOT_DIR}/cache/scan-state.json`,
  codeRefreshPlan: `${CODEMAP_ROOT_DIR}/cache/code-refresh-plan.json`,
  knowledgeRefreshPlan: `${CODEMAP_ROOT_DIR}/cache/knowledge-refresh-plan.json`,
  refreshPlan: `${CODEMAP_ROOT_DIR}/cache/refresh-plan.json`,
  dependencyGraphCache: `${CODEMAP_ROOT_DIR}/cache/dependency-graph.json`,
  impactIndex: `${CODEMAP_ROOT_DIR}/cache/impact-index.json`,
} as const;

export type CodemapDirectoryKey = keyof typeof CODEMAP_DIRECTORIES;
export type CodemapFileKey = keyof typeof CODEMAP_FILES;

export function getCodemapDirectory(key: CodemapDirectoryKey): string {
  return CODEMAP_DIRECTORIES[key];
}

export function getCodemapFile(key: CodemapFileKey): string {
  return CODEMAP_FILES[key];
}
