import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  AI_RECORDED_TAG,
  buildClaimHealthIncidents,
  buildCodemapImpactIndex,
  buildGitHookScript,
  CODEMAP_DIRECTORIES,
  CODEMAP_FILES,
  collectImpactedSourcePaths,
  collectImpactedWorkspaces,
  DEFAULT_CRITICAL_CODE_CLAIM_TYPES,
  FileClaimStore,
  FileConflictStore,
  FileEvidenceStore,
  FileSnapshotStore,
  FileVerificationStore,
  getClaimHistoryPartitionFile,
  getClaimRunHistoryPartitionFile,
  getWatchIgnoreDirs,
  getVerificationHistoryPartitionFile,
  getVerificationRunHistoryPartitionFile,
  buildSnapshotManifest,
  createSourceSnapshot,
  getCodemapDirectory,
  getCodemapFile,
  formatCodemapSearchClaims,
  getCodemapClaimHistory,
  getCodemapClaimStateHistory,
  getCodemapConflicts,
  getCodemapDiffSinceSnapshot,
  getCodemapPublishRun,
  getCodemapPublishStatus,
  getCodemapVerifyClaim,
  searchCodemapClaims,
  isCodemapId,
  makeCodemapId,
  makeHashedCodemapId,
  publishCodeCodemap,
  publishKnowledgeCodemap,
  publishRouteCodemap,
  RECORDED_DECISIONS_DIR,
  recordDecision,
  renderCompatibilityWiki,
  renderKnowledgeViews,
  summarizeChangedFiles,
} from "../dist/codemap/index.js";
import { scan } from "../dist/core.js";
import { detectKnowledge } from "../dist/detectors/knowledge.js";
import { writeKnowledgeOutput } from "../dist/formatter.js";
import { generateWiki } from "../dist/generators/wiki.js";

function parseNdjson<T>(content: string): T[] {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

test("makeCodemapId namespaces canonical ids", () => {
  const claimId = makeCodemapId("claim", "route-users-list");
  assert.equal(claimId, "claim:route-users-list");
  assert.equal(isCodemapId(claimId), true);
  assert.equal(isCodemapId(claimId, "claim"), true);
  assert.equal(isCodemapId(claimId, "snapshot"), false);
});

test("makeCodemapId rejects empty raw ids", () => {
  assert.throws(() => makeCodemapId("snapshot", "   "), /rawId must not be empty/);
});

test("makeHashedCodemapId is stable for the same payload", () => {
  const first = makeHashedCodemapId("snapshot", ["src/routes.ts", "abc123"]);
  const second = makeHashedCodemapId("snapshot", ["src/routes.ts", "abc123"]);
  const third = makeHashedCodemapId("snapshot", ["src/routes.ts", "def456"]);

  assert.equal(first, second);
  assert.notEqual(first, third);
});

test("codemap layout points at the new .codemap namespace", () => {
  assert.equal(getCodemapDirectory("root"), ".codemap");
  assert.equal(CODEMAP_DIRECTORIES.history, ".codemap/history");
  assert.equal(CODEMAP_DIRECTORIES.archive, ".codemap/archive");
  assert.equal(CODEMAP_DIRECTORIES.archiveSegments, ".codemap/archive/segments");
  assert.equal(CODEMAP_DIRECTORIES.archiveSnapshotSegments, ".codemap/archive/snapshots");
  assert.equal(CODEMAP_DIRECTORIES.archiveSnapshotFiles, ".codemap/archive/snapshots/files");
  assert.equal(CODEMAP_DIRECTORIES.archiveSnapshotContents, ".codemap/archive/snapshots/content");
  assert.equal(CODEMAP_DIRECTORIES.snapshotContents, ".codemap/snapshots/content");
  assert.equal(CODEMAP_DIRECTORIES.compatibilityWiki, ".codemap/compatibility/wiki");
  assert.equal(getCodemapFile("snapshotManifest"), ".codemap/snapshots/manifest.json");
  assert.equal(CODEMAP_FILES.overviewView, ".codemap/views/overview.md");
  assert.equal(getCodemapFile("knowledgeIndexView"), ".codemap/views/knowledge/index.md");
  assert.equal(getCodemapFile("knowledgeOverviewView"), ".codemap/views/knowledge/overview.md");
  assert.equal(getCodemapFile("configView"), ".codemap/views/code/config.md");
  assert.equal(getCodemapFile("databaseView"), ".codemap/views/code/database.md");
  assert.equal(getCodemapFile("impactView"), ".codemap/views/code/impact.md");
  assert.equal(getCodemapFile("runtimeView"), ".codemap/views/code/runtime.md");
  assert.equal(getCodemapFile("uiView"), ".codemap/views/code/ui.md");
  assert.equal(getCodemapFile("librariesView"), ".codemap/views/code/libraries.md");
  assert.equal(getCodemapFile("compatibilityParity"), ".codemap/compatibility/parity.json");
  assert.equal(getCodemapFile("compatibilityKnowledgeParity"), ".codemap/compatibility/knowledge-parity.json");
  assert.equal(getCodemapFile("compatibilityWikiIndex"), ".codemap/compatibility/wiki/index.md");
  assert.equal(getCodemapFile("compatibilityWikiUi"), ".codemap/compatibility/wiki/ui.md");
  assert.equal(getCodemapFile("compatibilityWikiLibraries"), ".codemap/compatibility/wiki/libraries.md");
  assert.equal(getCodemapFile("verificationHistoryNdjson"), ".codemap/history/verification.ndjson");
  assert.equal(getCodemapFile("claimHistoryNdjson"), ".codemap/history/claims.ndjson");
  assert.equal(getCodemapFile("verificationHistoryIndex"), ".codemap/history/verification-index.json");
  assert.equal(getCodemapFile("claimHistoryIndex"), ".codemap/history/claims-index.json");
  assert.equal(getCodemapFile("publishRunsNdjson"), ".codemap/history/publish-runs.ndjson");
  assert.equal(getCodemapFile("publishRunsIndex"), ".codemap/history/publish-runs-index.json");
  assert.equal(getCodemapFile("historyPolicy"), ".codemap/history/policy.json");
  assert.equal(getCodemapFile("historyStorageStatus"), ".codemap/history/storage-status.json");
  assert.equal(getCodemapFile("archiveManifest"), ".codemap/archive/manifest.json");
  assert.equal(getCodemapFile("archiveClaimIndex"), ".codemap/archive/claim-index.json");
  assert.equal(getCodemapFile("archiveRunIndex"), ".codemap/archive/run-index.json");
  assert.equal(getCodemapFile("archiveSnapshotManifest"), ".codemap/archive/snapshot-manifest.json");
  assert.equal(getCodemapFile("archiveSnapshotIndex"), ".codemap/archive/snapshot-index.json");
  assert.equal(getCodemapFile("codePublishPlan"), ".codemap/publish/code-publish-plan.json");
  assert.equal(getCodemapFile("knowledgePublishPlan"), ".codemap/publish/knowledge-publish-plan.json");
  assert.equal(getCodemapFile("knowledgeIncidentsNdjson"), ".codemap/publish/knowledge-incidents.ndjson");
  assert.equal(getCodemapFile("codeScanState"), ".codemap/cache/code-scan-state.json");
  assert.equal(getCodemapFile("knowledgeScanState"), ".codemap/cache/knowledge-scan-state.json");
  assert.equal(getCodemapFile("refreshPlan"), ".codemap/cache/refresh-plan.json");
  assert.equal(getCodemapFile("codeRefreshPlan"), ".codemap/cache/code-refresh-plan.json");
  assert.equal(getCodemapFile("knowledgeRefreshPlan"), ".codemap/cache/knowledge-refresh-plan.json");
  assert.equal(getCodemapFile("dependencyGraphCache"), ".codemap/cache/dependency-graph.json");
  assert.equal(getCodemapFile("impactIndex"), ".codemap/cache/impact-index.json");
});

test("CodeMap impact index derives affected source files and workspaces from shared dependency structure", () => {
  const impactIndex = buildCodemapImpactIndex({
    generatedAt: "2026-04-22T12:00:00.000Z",
    sourceEdges: [
      { from: "packages/pkg-b/src/index.ts", to: "packages/pkg-b/src/internal.ts" },
      { from: "packages/pkg-a/src/index.ts", to: "packages/pkg-a/src/local.ts" },
      { from: "packages/pkg-a/src/index.ts", to: "packages/pkg-b/src/index.ts" },
    ],
    workspaces: [
      { name: "@test/pkg-a", dir: "packages/pkg-a", dependsOn: ["@test/pkg-b"] },
      { name: "@test/pkg-b", dir: "packages/pkg-b", dependsOn: [] },
      { name: "@test/pkg-c", dir: "packages/pkg-c", dependsOn: [] },
    ],
  });

  assert.deepEqual(
    collectImpactedSourcePaths(impactIndex, ["packages/pkg-b/src/index.ts"], { maxDepth: 1 }),
    ["packages/pkg-a/src/index.ts", "packages/pkg-b/src/index.ts", "packages/pkg-b/src/internal.ts"],
  );
  assert.deepEqual(
    collectImpactedWorkspaces(impactIndex, ["packages/pkg-b/src/index.ts"]),
    ["@test/pkg-a", "@test/pkg-b"],
  );
});

test("CodeMap runtime helpers build dual-write hook scripts and ignore generated directories in watch mode", () => {
  const hookScript = buildGitHookScript({
    outputDirName: ".codesight",
    includeWiki: true,
    includeCodemap: true,
    defaultPolicy: "warn",
  });

  assert.match(hookScript, /--wiki --codemap --hook-run -o \.codesight/);
  assert.match(hookScript, /git add \.codesight\/ \.codemap\//);
  assert.match(hookScript, /CODESIGHT_CODEMAP_POLICY/);
  assert.match(hookScript, /\.codemap\/publish\/incidents\.ndjson/);
  assert.match(hookScript, /\.codemap\/publish\/knowledge-incidents\.ndjson/);
  assert.match(hookScript, /for CODEMAP_FILE in/);
  assert.match(hookScript, /grep -c '"severity":"high"' "\$CODEMAP_FILE"/);
  assert.match(hookScript, /grep -c '"severity":"medium"' "\$CODEMAP_FILE"/);
  assert.match(hookScript, /grep -c '"severity":"low"' "\$CODEMAP_FILE"/);
  assert.match(hookScript, /CODEMAP_HIGH=\$\(\(CODEMAP_HIGH \+ CODEMAP_FILE_HIGH\)\)/);
  assert.match(hookScript, /CODEMAP_MEDIUM=\$\(\(CODEMAP_MEDIUM \+ CODEMAP_FILE_MEDIUM\)\)/);
  assert.match(hookScript, /CODEMAP_LOW=\$\(\(CODEMAP_LOW \+ CODEMAP_FILE_LOW\)\)/);
  assert.match(hookScript, /\[ "\$CODEMAP_POLICY" = "block" \] && \[ "\$CODEMAP_HIGH" -gt 0 \]/);
  assert.match(hookScript, /\[ "\$CODEMAP_POLICY" = "warn" \] && \[ "\$CODEMAP_HIGH" -gt 0 \]/);
  assert.match(hookScript, /\[ "\$CODEMAP_POLICY" = "warn" \] && \[ "\$CODEMAP_MEDIUM" -gt 0 \]/);
  assert.match(hookScript, /high-severity CodeMap incident/);
  assert.match(hookScript, /medium-severity CodeMap incident/);
  assert.match(hookScript, /shadow mode observed CodeMap incidents \(high=\$CODEMAP_HIGH medium=\$CODEMAP_MEDIUM low=\$CODEMAP_LOW\)/);
  assert.doesNotMatch(hookScript, /\|\| echo 0/);
  assert.ok(getWatchIgnoreDirs(".codesight").includes(".codemap"));
  assert.equal(summarizeChangedFiles(["src/a.ts", "src/b.ts"]), "src/a.ts, src/b.ts");
  assert.equal(summarizeChangedFiles(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]), "6 files");
});

test("buildGitHookScript bakes the requested defaultPolicy into the env-var fallback", () => {
  const shadowScript = buildGitHookScript({
    outputDirName: ".codesight",
    includeCodemap: true,
    defaultPolicy: "shadow",
  });
  const warnScript = buildGitHookScript({
    outputDirName: ".codesight",
    includeCodemap: true,
    defaultPolicy: "warn",
  });
  const blockScript = buildGitHookScript({
    outputDirName: ".codesight",
    includeCodemap: true,
    defaultPolicy: "block",
  });

  assert.match(shadowScript, /CODEMAP_POLICY="\$\{CODESIGHT_CODEMAP_POLICY:-shadow\}"/);
  assert.match(warnScript, /CODEMAP_POLICY="\$\{CODESIGHT_CODEMAP_POLICY:-warn\}"/);
  assert.match(blockScript, /CODEMAP_POLICY="\$\{CODESIGHT_CODEMAP_POLICY:-block\}"/);

  assert.doesNotMatch(shadowScript, /CODESIGHT_CODEMAP_POLICY:-warn/);
  assert.doesNotMatch(blockScript, /CODESIGHT_CODEMAP_POLICY:-warn/);
});

test("buildClaimHealthIncidents transcribes verifier judgments with stable ids and traceability", () => {
  const claims = [
    {
      id: "claim:route-users",
      type: "route" as const,
      subject: "GET /users",
      text: "GET /users handler",
      sourceSnapshotIds: ["snapshot:abc"],
      evidenceSpanIds: ["evidence:abc"],
      status: "stale" as const,
      supportScore: 0.5,
      publicationConfidence: 0.5,
      firstSeenAt: "2026-04-23T00:00:00.000Z",
      tags: [],
    },
    {
      id: "claim:component-card",
      type: "component" as const,
      subject: "Card",
      text: "Card component",
      sourceSnapshotIds: ["snapshot:def"],
      evidenceSpanIds: ["evidence:def"],
      status: "stale" as const,
      supportScore: 0.5,
      publicationConfidence: 0.5,
      firstSeenAt: "2026-04-23T00:00:00.000Z",
      tags: [],
    },
    {
      id: "claim:relation-orphan",
      type: "relation" as const,
      subject: "posts.userId",
      text: "posts.userId references users.id",
      sourceSnapshotIds: ["snapshot:ghi"],
      evidenceSpanIds: ["evidence:ghi"],
      status: "quarantined" as const,
      supportScore: 0.0,
      publicationConfidence: 0.0,
      firstSeenAt: "2026-04-23T00:00:00.000Z",
      tags: [],
    },
    {
      id: "claim:route-orders",
      type: "route" as const,
      subject: "GET /orders",
      text: "GET /orders handler",
      sourceSnapshotIds: ["snapshot:jkl"],
      evidenceSpanIds: ["evidence:jkl"],
      status: "verified" as const,
      supportScore: 1.0,
      publicationConfidence: 1.0,
      firstSeenAt: "2026-04-23T00:00:00.000Z",
      tags: [],
    },
  ];
  const conflicts = [
    {
      id: "conflict:routes-collide",
      claimA: "claim:route-users",
      claimB: "claim:route-orders",
      relation: "conflicts" as const,
      severity: "high" as const,
      createdAt: "2026-04-23T00:00:00.000Z",
      rationale: "two handlers register GET /users",
    },
  ];
  const verification = [
    {
      id: "verification:route-users-fail",
      claimId: "claim:route-users",
      verifier: "hash-match" as const,
      outcome: "fail" as const,
      reason: "snapshot hash drifted",
      createdAt: "2026-04-23T00:00:00.000Z",
      snapshotIdsChecked: ["snapshot:abc"],
    },
    {
      id: "verification:component-card-fail",
      claimId: "claim:component-card",
      verifier: "component-consistency" as const,
      outcome: "fail" as const,
      reason: "component file removed",
      createdAt: "2026-04-23T00:00:00.000Z",
      snapshotIdsChecked: ["snapshot:def"],
    },
    {
      id: "verification:relation-orphan-fail",
      claimId: "claim:relation-orphan",
      verifier: "schema-consistency" as const,
      outcome: "fail" as const,
      reason: "target model missing",
      createdAt: "2026-04-23T00:00:00.000Z",
      snapshotIdsChecked: ["snapshot:ghi"],
    },
  ];
  const generatedAt = "2026-04-23T00:00:00.000Z";

  const incidents = buildClaimHealthIncidents({
    claims,
    conflicts,
    verification,
    generatedAt,
    criticalClaimTypes: DEFAULT_CRITICAL_CODE_CLAIM_TYPES,
  });

  const bySource = new Map(incidents.map((incident) => [incident.source, incident]));

  const conflictIncident = bySource.get("conflict-high");
  assert.ok(conflictIncident);
  assert.equal(conflictIncident?.severity, "high");
  assert.deepEqual(conflictIncident?.claimIds, ["claim:route-orders", "claim:route-users"]);
  assert.equal(conflictIncident?.sourceRecordId, "conflict:routes-collide");

  const criticalStale = incidents.find((incident) =>
    incident.source === "claim-stale-critical" && incident.claimIds[0] === "claim:route-users");
  assert.ok(criticalStale);
  assert.equal(criticalStale?.severity, "high");
  assert.equal(criticalStale?.sourceRecordId, "verification:route-users-fail");

  const nonCriticalStale = incidents.find((incident) =>
    incident.source === "claim-stale" && incident.claimIds[0] === "claim:component-card");
  assert.ok(nonCriticalStale);
  assert.equal(nonCriticalStale?.severity, "medium");
  assert.equal(nonCriticalStale?.sourceRecordId, "verification:component-card-fail");

  const quarantinedIncident = incidents.find((incident) =>
    incident.source === "claim-quarantined" && incident.claimIds[0] === "claim:relation-orphan");
  assert.ok(quarantinedIncident);
  assert.equal(quarantinedIncident?.severity, "medium");
  assert.equal(quarantinedIncident?.sourceRecordId, "verification:relation-orphan-fail");

  assert.equal(incidents.filter((incident) => incident.claimIds.includes("claim:route-orders")
    && incident.source.startsWith("claim-")).length, 0);

  const second = buildClaimHealthIncidents({
    claims,
    conflicts,
    verification,
    generatedAt: "2099-01-01T00:00:00.000Z",
    criticalClaimTypes: DEFAULT_CRITICAL_CODE_CLAIM_TYPES,
  });
  assert.deepEqual(
    incidents.map((incident) => incident.id).sort(),
    second.map((incident) => incident.id).sort(),
  );
});

test("CodeMap refresh planning narrows impacted claims for targeted watch refreshes", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-refresh-plan-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-refresh-plan",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    await writeFile(
      join(srcDir, "routes.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const codemapResult = await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true), {
      changedFiles: ["src/routes.ts", "package.json"],
      trigger: "watch",
      outputDirName: ".codesight",
    });

    const refreshPlan = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "refresh-plan.json"), "utf-8"),
    ) as {
      mode: string;
      changedFiles: string[];
      impactedClaimTypes: string[];
      targetedClaimCount: number;
      targetedSourcePaths: string[];
    };

    assert.equal(codemapResult.refreshPlan.mode, "targeted");
    assert.equal(refreshPlan.mode, "targeted");
    assert.deepEqual(refreshPlan.changedFiles, ["package.json", "src/routes.ts"]);
    assert.ok(refreshPlan.impactedClaimTypes.includes("env_var"));
    assert.ok(refreshPlan.impactedClaimTypes.includes("route"));
    assert.ok(refreshPlan.impactedClaimTypes.includes("package_dependency"));
    assert.ok(refreshPlan.targetedClaimCount >= 2);
    assert.ok(refreshPlan.targetedSourcePaths.includes("src/routes.ts"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap compacts superseded snapshots, evidence, and verification records across republishes", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-compaction-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-compaction",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    const routePath = join(srcDir, "routes.ts");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const snapshotStore = new FileSnapshotStore(repoRoot);
    const claimStore = new FileClaimStore(repoRoot);
    const evidenceStore = new FileEvidenceStore(repoRoot);
    const verificationStore = new FileVerificationStore(repoRoot);

    const firstSnapshots = await snapshotStore.list();
    const firstEvidence = await evidenceStore.list();
    const firstVerification = await verificationStore.list();
    const firstVerificationHistory = parseNdjson<{ runId: string; transition: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "verification.ndjson"), "utf-8"),
    );
    const firstPublishRuns = parseNdjson<{ id: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "publish-runs.ndjson"), "utf-8"),
    );

    assert.ok(firstSnapshots.length > 0);
    assert.ok(firstEvidence.length > 0);
    assert.ok(firstVerification.length > 0);
    assert.equal(firstVerificationHistory.length, firstVerification.length);
    assert.equal(firstPublishRuns.length, 1);

    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "// whitespace-only republish change",
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const secondSnapshots = await snapshotStore.list();
    const secondEvidence = await evidenceStore.list();
    const secondVerification = await verificationStore.list();
    const claims = await claimStore.list();
    const secondVerificationHistory = parseNdjson<{ runId: string; transition: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "verification.ndjson"), "utf-8"),
    );
    const verificationHistoryIndex = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "history", "verification-index.json"), "utf-8"),
    ) as { claims: Array<{ claimId: string; entries: number; partitionPath: string }> };
    const claimHistoryIndex = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "history", "claims-index.json"), "utf-8"),
    ) as { claims: Array<{ claimId: string; entries: number; partitionPath: string }> };
    const secondPublishRuns = parseNdjson<{ id: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "publish-runs.ndjson"), "utf-8"),
    );
    const publishRunsIndex = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "history", "publish-runs-index.json"), "utf-8"),
    ) as { runs: Array<{ runId: string; claimHistoryEntries: number; verificationHistoryEntries: number }> };
    const claimRunPartitions = await Promise.all(secondPublishRuns.map(async (run) => ({
      runId: run.id,
      entries: parseNdjson<{ runId: string }>(
        await readFile(join(repoRoot, getClaimRunHistoryPartitionFile(run.id)), "utf-8"),
      ),
    })));
    const verificationRunPartitions = await Promise.all(secondPublishRuns.map(async (run) => ({
      runId: run.id,
      entries: parseNdjson<{ runId: string }>(
        await readFile(join(repoRoot, getVerificationRunHistoryPartitionFile(run.id)), "utf-8"),
      ),
    })));
    const routeClaim = claims.find((claim) => claim.subject === "GET /users");

    assert.equal(secondSnapshots.length, firstSnapshots.length);
    assert.equal(secondEvidence.length, firstEvidence.length);
    assert.equal(secondVerification.length, firstVerification.length);
    assert.equal(secondVerificationHistory.length, firstVerificationHistory.length + secondVerification.length);
    assert.equal(new Set(secondVerificationHistory.map((entry) => entry.runId)).size, 2);
    assert.equal(secondPublishRuns.length, 2);
    assert.ok(secondVerificationHistory.some((entry) => entry.transition === "changed" || entry.transition === "revalidated"));
    assert.equal(publishRunsIndex.runs.length, 2);
    assert.ok(routeClaim);
    assert.ok(secondPublishRuns.every((run) =>
      publishRunsIndex.runs.some((entry) =>
        entry.runId === run.id
        && entry.claimHistoryEntries > 0
        && entry.verificationHistoryEntries > 0,
      ),
    ));
    assert.ok(claimRunPartitions.every((run) => run.entries.every((entry) => entry.runId === run.runId)));
    assert.ok(verificationRunPartitions.every((run) => run.entries.every((entry) => entry.runId === run.runId)));
    assert.ok(verificationHistoryIndex.claims.some((entry) => entry.claimId === routeClaim!.id && entry.entries > 0));
    assert.ok(claimHistoryIndex.claims.some((entry) => entry.claimId === routeClaim!.id && entry.entries > 0));
    assert.ok(
      parseNdjson<{ claimId: string }>(
        await readFile(join(repoRoot, getVerificationHistoryPartitionFile(routeClaim!.id)), "utf-8"),
      ).every((entry) => entry.claimId === routeClaim!.id),
    );
    assert.ok(
      parseNdjson<{ claimId: string }>(
        await readFile(join(repoRoot, getClaimHistoryPartitionFile(routeClaim!.id)), "utf-8"),
      ).every((entry) => entry.claimId === routeClaim!.id),
    );
    assert.ok(claims.every((claim) =>
      claim.sourceSnapshotIds.every((snapshotId) => secondSnapshots.some((snapshot) => snapshot.id === snapshotId)),
    ));
    assert.ok(claims.every((claim) =>
      claim.evidenceSpanIds.every((evidenceId) => secondEvidence.some((entry) => entry.id === evidenceId)),
    ));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap writes history storage policy and archive scaffolding in observe mode", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-history-policy-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-history-policy",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    await writeFile(
      join(srcDir, "routes.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const codemapResult = await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const historyPolicy = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "history", "policy.json"), "utf-8"),
    ) as {
      mode: string;
      preserveFullLedgers: boolean;
      maxHotBytes: number;
      targetHotBytes: number;
    };
    const historyStorage = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "history", "storage-status.json"), "utf-8"),
    ) as {
      policy: { mode: string; };
      usage: { hotBytes: number; totalBytes: number; };
      counts: { publishRuns: number; plannedSegments: number; };
      notes: string[];
    };
    const archiveManifest = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "archive", "manifest.json"), "utf-8"),
    ) as {
      mode: string;
      totalArchiveBytes: number;
      plannedBytes: number;
      segments: Array<{ state: string; }>;
    };

    assert.equal(codemapResult.historyStorage.policy.mode, "observe");
    assert.equal(codemapResult.historyArchiveManifest.mode, "observe");
    assert.equal(historyPolicy.mode, "observe");
    assert.equal(historyPolicy.preserveFullLedgers, true);
    assert.ok(historyPolicy.maxHotBytes > historyPolicy.targetHotBytes);
    assert.equal(historyStorage.policy.mode, "observe");
    assert.ok(historyStorage.usage.hotBytes > 0);
    assert.ok(historyStorage.usage.totalBytes >= historyStorage.usage.hotBytes);
    assert.equal(historyStorage.counts.publishRuns, 1);
    assert.equal(archiveManifest.mode, "observe");
    assert.equal(archiveManifest.totalArchiveBytes, 0);
    assert.ok(archiveManifest.plannedBytes >= 0);
    assert.ok(archiveManifest.segments.every((segment) => segment.state === "planned" || segment.state === "archived"));
    assert.ok(historyStorage.notes.some((note) => note.includes("Append-only history ledgers")));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap plans archive segments from a hot-byte budget without deleting history", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-history-archive-plan-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-history-archive-plan",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    const routePath = join(srcDir, "routes.ts");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    await writeFile(join(repoRoot, ".codemap", "history", "policy.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-04-22T12:00:00.000Z",
      mode: "observe",
      maxHotBytes: 1,
      targetHotBytes: 0,
      warnAtPercent: 0.5,
      segmentTargetBytes: 512,
      preserveFullLedgers: true,
    }, null, 2), "utf-8");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "// trigger a second publish under the tiny hot-byte budget",
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const historyStorage = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "history", "storage-status.json"), "utf-8"),
    ) as {
      budget: { overBudget: boolean; };
      archiveCandidates: Array<{ runId: string; estimatedBytes: number; recommendedAction: string; }>;
      counts: { publishRuns: number; plannedSegments: number; };
      notes: string[];
    };
    const archiveManifest = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "archive", "manifest.json"), "utf-8"),
    ) as {
      plannedBytes: number;
      segments: Array<{ state: string; runIds: string[]; bytes: number; }>;
    };
    const claimHistory = parseNdjson<{ runId: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "claims.ndjson"), "utf-8"),
    );
    const verificationHistory = parseNdjson<{ runId: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "verification.ndjson"), "utf-8"),
    );

    assert.equal(historyStorage.budget.overBudget, true);
    assert.ok(historyStorage.archiveCandidates.length > 0);
    assert.ok(historyStorage.archiveCandidates.every((candidate) => candidate.estimatedBytes > 0));
    assert.ok(historyStorage.archiveCandidates.every((candidate) => candidate.recommendedAction === "archive"));
    assert.ok(historyStorage.counts.publishRuns >= 2);
    assert.ok(historyStorage.counts.plannedSegments >= 1);
    assert.ok(historyStorage.notes.some((note) => note.includes("observe")));
    assert.ok(archiveManifest.plannedBytes > 0);
    assert.ok(archiveManifest.segments.some((segment) => segment.state === "planned" && segment.runIds.length > 0 && segment.bytes > 0));
    assert.ok(claimHistory.length > 0);
    assert.ok(verificationHistory.length > 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap materializes compressed archive bundles in archive mode without changing the hot history path", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-history-archive-exec-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-history-archive-exec",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    const routePath = join(srcDir, "routes.ts");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    await writeFile(join(repoRoot, ".codemap", "history", "policy.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-04-22T12:00:00.000Z",
      mode: "archive",
      maxHotBytes: 1,
      targetHotBytes: 0,
      warnAtPercent: 0.5,
      segmentTargetBytes: 512,
      preserveFullLedgers: true,
    }, null, 2), "utf-8");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "// trigger archive mode materialization",
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const historyStorage = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "history", "storage-status.json"), "utf-8"),
    ) as {
      policy: { mode: string; };
      usage: { archiveBytes: number; hotBytes: number; totalBytes: number; };
      counts: { archivedSegments: number; plannedSegments: number; };
      archiveCandidates: Array<unknown>;
      notes: string[];
    };
    const archiveManifest = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "archive", "manifest.json"), "utf-8"),
    ) as {
      mode: string;
      totalArchiveBytes: number;
      plannedBytes: number;
      segments: Array<{
        id: string;
        state: string;
        compression: string;
        bundlePath?: string;
        runIds: string[];
        bytes: number;
      }>;
    };
    const archiveClaimIndex = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "archive", "claim-index.json"), "utf-8"),
    ) as {
      claims: Array<{
        claimId: string;
        claimHistorySegments: string[];
        verificationHistorySegments: string[];
      }>;
    };
    const archiveRunIndex = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "archive", "run-index.json"), "utf-8"),
    ) as {
      runs: Array<{
        runId: string;
        segmentIds: string[];
      }>;
    };
    const claims = parseNdjson<{ id: string; subject: string }>(
      await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"),
    );
    const archivedSegment = archiveManifest.segments.find((segment) => segment.state === "archived");
    const routeClaim = claims.find((claim) => claim.subject === "GET /users");

    assert.equal(historyStorage.policy.mode, "archive");
    assert.equal(historyStorage.counts.archivedSegments >= 1, true);
    assert.equal(historyStorage.counts.plannedSegments, 0);
    assert.equal(historyStorage.archiveCandidates.length, 0);
    assert.ok(historyStorage.usage.archiveBytes > 0);
    assert.ok(historyStorage.usage.totalBytes >= historyStorage.usage.hotBytes);
    assert.ok(historyStorage.notes.some((note) => note.includes("compressed segment bundles")));
    assert.equal(archiveManifest.mode, "archive");
    assert.equal(archiveManifest.plannedBytes, 0);
    assert.ok(archiveManifest.totalArchiveBytes > 0);
    assert.ok(archivedSegment);
    assert.equal(archivedSegment!.compression, "gzip");
    assert.ok(archivedSegment!.bundlePath);
    assert.ok(archivedSegment!.runIds.length > 0);
    assert.ok(archivedSegment!.bytes > 0);
    assert.ok(routeClaim);
    assert.ok(archiveClaimIndex.claims.some((entry) =>
      entry.claimId === routeClaim!.id
      && entry.claimHistorySegments.length > 0
      && entry.verificationHistorySegments.length > 0,
    ));
    assert.ok(archivedSegment!.runIds.every((runId) =>
      archiveRunIndex.runs.some((entry) =>
        entry.runId === runId
        && entry.segmentIds.includes(archivedSegment!.id),
      ),
    ));

    const compressedBundle = await readFile(join(repoRoot, archivedSegment!.bundlePath!));
    const archiveBundle = JSON.parse(gunzipSync(compressedBundle).toString("utf-8")) as {
      segmentId: string;
      runIds: string[];
      claimHistory: Array<{ runId: string; subject: string; }>;
      verificationHistory: Array<{ runId: string; verifier: string; }>;
    };
    const claimHistory = parseNdjson<{ runId: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "claims.ndjson"), "utf-8"),
    );
    const verificationHistory = parseNdjson<{ runId: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "verification.ndjson"), "utf-8"),
    );

    assert.equal(archiveBundle.segmentId, archivedSegment!.id);
    assert.deepEqual(archiveBundle.runIds, archivedSegment!.runIds);
    assert.ok(archiveBundle.claimHistory.length > 0);
    assert.ok(archiveBundle.verificationHistory.length > 0);
    assert.ok(archiveBundle.claimHistory.every((entry) => archivedSegment!.runIds.includes(entry.runId)));
    assert.ok(archiveBundle.verificationHistory.every((entry) => archivedSegment!.runIds.includes(entry.runId)));
    assert.ok(claimHistory.length > 0);
    assert.ok(verificationHistory.length > 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("archive-aware history queries fall back to archived bundles when hot history files are missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-history-archive-read-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-history-archive-read",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    const routePath = join(srcDir, "routes.ts");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    await writeFile(join(repoRoot, ".codemap", "history", "policy.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-04-22T12:00:00.000Z",
      mode: "archive",
      maxHotBytes: 1,
      targetHotBytes: 0,
      warnAtPercent: 0.5,
      segmentTargetBytes: 512,
      preserveFullLedgers: true,
    }, null, 2), "utf-8");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "// trigger archive bundle materialization",
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    await rm(join(repoRoot, ".codemap", "history", "claims.ndjson"), { force: true });
    await rm(join(repoRoot, ".codemap", "history", "verification.ndjson"), { force: true });
    await rm(join(repoRoot, ".codemap", "history", "by-claim"), { recursive: true, force: true });
    await rm(join(repoRoot, ".codemap", "history", "by-run"), { recursive: true, force: true });

    const publishRun = await getCodemapPublishRun(repoRoot, { latest: true });
    const verificationHistory = await getCodemapClaimHistory(repoRoot, { subject: "GET /users" });
    const claimStateHistory = await getCodemapClaimStateHistory(repoRoot, { subject: "GET /users" });

    assert.ok(publishRun);
    assert.ok(publishRun!.claimHistory.length > 0);
    assert.ok(publishRun!.verificationHistory.length > 0);
    assert.ok(verificationHistory);
    assert.ok(verificationHistory!.history.length > 0);
    assert.ok(verificationHistory!.history.every((entry) => entry.claimId === verificationHistory!.claim.claimId));
    assert.ok(claimStateHistory);
    assert.ok(claimStateHistory!.history.length > 0);
    assert.ok(claimStateHistory!.history.every((entry) => entry.claimId === claimStateHistory!.claim.claimId));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap compacts archived runs out of the hot history path while preserving deep-dive history reads", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-history-compact-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-history-compact",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    const routePath = join(srcDir, "routes.ts");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    await writeFile(join(repoRoot, ".codemap", "history", "policy.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-04-22T12:00:00.000Z",
      mode: "compact",
      maxHotBytes: 1,
      targetHotBytes: 0,
      warnAtPercent: 0.5,
      segmentTargetBytes: 512,
      preserveFullLedgers: true,
    }, null, 2), "utf-8");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "// trigger compact mode archive + reclamation",
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const publishRuns = parseNdjson<{ id: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "publish-runs.ndjson"), "utf-8"),
    );
    const [firstRun, secondRun] = publishRuns;
    const hotClaimHistory = parseNdjson<{ runId: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "claims.ndjson"), "utf-8"),
    );
    const hotVerificationHistory = parseNdjson<{ runId: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "verification.ndjson"), "utf-8"),
    );
    const historyStorage = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "history", "storage-status.json"), "utf-8"),
    ) as {
      policy: { mode: string; };
      usage: { hotBytes: number; archiveBytes: number; totalBytes: number; };
      counts: { archivedSegments: number; claimHistoryEntries: number; verificationHistoryEntries: number; };
      notes: string[];
    };

    assert.equal(publishRuns.length, 2);
    assert.ok(firstRun);
    assert.ok(secondRun);
    assert.equal(historyStorage.policy.mode, "compact");
    assert.ok(historyStorage.counts.archivedSegments >= 1);
    assert.ok(historyStorage.usage.archiveBytes > 0);
    assert.ok(historyStorage.usage.totalBytes >= historyStorage.usage.hotBytes);
    assert.ok(historyStorage.notes.some((note) => note.includes("Compact mode reclaimed")));
    assert.ok(hotClaimHistory.length > 0);
    assert.ok(hotVerificationHistory.length > 0);
    assert.ok(hotClaimHistory.every((entry) => entry.runId === secondRun!.id));
    assert.ok(hotVerificationHistory.every((entry) => entry.runId === secondRun!.id));
    assert.equal(historyStorage.counts.claimHistoryEntries, hotClaimHistory.length);
    assert.equal(historyStorage.counts.verificationHistoryEntries, hotVerificationHistory.length);

    await assert.rejects(readFile(join(repoRoot, getClaimRunHistoryPartitionFile(firstRun!.id)), "utf-8"));
    await assert.rejects(readFile(join(repoRoot, getVerificationRunHistoryPartitionFile(firstRun!.id)), "utf-8"));

    const claimStateHistory = await getCodemapClaimStateHistory(repoRoot, { subject: "GET /users" });
    const verificationHistory = await getCodemapClaimHistory(repoRoot, { subject: "GET /users" });
    const firstRunDeepDive = await getCodemapPublishRun(repoRoot, { run_id: firstRun!.id });

    assert.ok(claimStateHistory);
    assert.ok(claimStateHistory!.history.some((entry) => entry.runId === firstRun!.id));
    assert.ok(claimStateHistory!.history.some((entry) => entry.runId === secondRun!.id));
    assert.ok(verificationHistory);
    assert.ok(verificationHistory!.history.some((entry) => entry.runId === firstRun!.id));
    assert.ok(verificationHistory!.history.some((entry) => entry.runId === secondRun!.id));
    assert.ok(firstRunDeepDive);
    assert.ok(firstRunDeepDive!.run.claimHistoryEntries > 0);
    assert.ok(firstRunDeepDive!.run.verificationHistoryEntries > 0);
    assert.ok(firstRunDeepDive!.claimHistory.every((entry) => entry.runId === firstRun!.id));
    assert.ok(firstRunDeepDive!.verificationHistory.every((entry) => entry.runId === firstRun!.id));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishKnowledgeCodemap writes canonical knowledge claims without replacing existing code claims", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-knowledge-"));
  try {
    const srcDir = join(repoRoot, "src");
    const notesDir = join(repoRoot, "notes");
    await mkdir(srcDir, { recursive: true });
    await mkdir(notesDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-knowledge",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    await writeFile(
      join(srcDir, "routes.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    const adrPath = join(notesDir, "adr-001-payments.md");
    const meetingPath = join(notesDir, "2026-04-22-sync.md");
    await writeFile(
      adrPath,
      [
        "---",
        "title: Payments ADR",
        "tags: [payments, architecture]",
        "project: Codemap",
        "---",
        "",
        "# Payments ADR",
        "",
        "## Decision",
        "",
        "We decided to use Polar for the initial marketplace launch.",
        "",
        "## Context",
        "",
        "Payments needs to stay simple during rollout.",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      meetingPath,
      [
        "---",
        "title: Product Sync",
        "tags: [payments, open-question]",
        "---",
        "",
        "# Product Sync",
        "",
        "Attendees: Alex Rivera, Sam Lee",
        "",
        "## Payments",
        "",
        "How should we handle refunds across Stripe and Polar?",
        "",
        "Alex Rivera will draft an experiment plan.",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const knowledgeMap = await detectKnowledge([adrPath, meetingPath], repoRoot);
    await writeKnowledgeOutput(knowledgeMap, join(repoRoot, ".codesight"), "codemap-knowledge", "test");
    const knowledgeResult = await publishKnowledgeCodemap(repoRoot, [adrPath, meetingPath], {
      changedFiles: ["notes/2026-04-22-sync.md", "notes/adr-001-payments.md"],
      outputDirName: ".codesight",
      trigger: "watch",
    });

    const knowledgeOutput = await readFile(join(repoRoot, ".codesight", "KNOWLEDGE.md"), "utf-8");
    const claims = parseNdjson<{ type: string; subject: string; status: string }>(
      await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"),
    );
    const evidence = parseNdjson<{ sourcePath: string; labels: string[] }>(
      await readFile(join(repoRoot, ".codemap", "evidence", "evidence.ndjson"), "utf-8"),
    );
    const verification = parseNdjson<{ verifier: string; outcome: string; reason: string }>(
      await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8"),
    );
    const snapshotManifest = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "snapshots", "manifest.json"), "utf-8"),
    ) as { entries: Array<{ sourcePath: string }> };
    const knowledgeIndexView = await readFile(join(repoRoot, ".codemap", "views", "knowledge", "index.md"), "utf-8");
    const knowledgeOverviewView = await readFile(join(repoRoot, ".codemap", "views", "knowledge", "overview.md"), "utf-8");
    const compatibilityKnowledge = await readFile(join(repoRoot, ".codemap", "compatibility", "KNOWLEDGE.md"), "utf-8");
    const compatibilityParity = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "compatibility", "knowledge-parity.json"), "utf-8"),
    ) as { legacyKnowledgePresent: boolean; article: { status: string; } };
    const publishPlan = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "publish", "publish-plan.json"), "utf-8"),
    ) as {
      currentDomain: string;
      domain: string;
      domains: {
        code?: { domain: string; items: Array<{ claimId: string }> };
        knowledge?: { domain: string; items: Array<{ claimId: string }> };
      };
    };
    const knowledgePublishPlan = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "publish", "knowledge-publish-plan.json"), "utf-8"),
    ) as {
      domain: string;
      items: Array<{ claimId: string }>;
    };
    const codePublishPlan = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "publish", "code-publish-plan.json"), "utf-8"),
    ) as {
      domain: string;
      items: Array<{ claimId: string }>;
    };
    const refreshPlan = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "refresh-plan.json"), "utf-8"),
    ) as {
      currentDomain: string;
      mode: string;
      changedFiles: string[];
      domains: {
        code?: { domain: string; };
        knowledge?: { domain: string; };
      };
      impactedClaimTypes: string[];
      targetedSourcePaths: string[];
    };
    const knowledgeRefreshPlan = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "knowledge-refresh-plan.json"), "utf-8"),
    ) as {
      domain: string;
      mode: string;
    };
    const codeRefreshPlan = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "code-refresh-plan.json"), "utf-8"),
    ) as {
      domain: string;
    };
    const scanState = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "scan-state.json"), "utf-8"),
    ) as {
      currentDomain: string;
      domain: string;
      trigger: string;
      changedFiles: string[];
      domains: {
        code?: { domain: string; };
        knowledge?: { domain: string; trigger: string; };
      };
      refresh: {
        mode: string;
        impactedClaimTypes: string[];
      };
    };
    const knowledgeScanState = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "knowledge-scan-state.json"), "utf-8"),
    ) as {
      domain: string;
      trigger: string;
    };
    const codeScanState = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "code-scan-state.json"), "utf-8"),
    ) as {
      domain: string;
    };
    const publishRuns = parseNdjson<{ id: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "publish-runs.ndjson"), "utf-8"),
    );

    assert.match(knowledgeOutput, /Key Decisions/);
    assert.match(knowledgeOutput, /Polar/);
    assert.ok(knowledgeResult.knowledgeClaims >= 4);
    assert.ok(knowledgeResult.views.some((view) => view.path === ".codemap/views/knowledge/overview.md"));
    assert.ok(knowledgeResult.compatibilityViews.some((view) => view.path === ".codemap/compatibility/KNOWLEDGE.md"));
    assert.equal(knowledgeResult.compatibilityParity.legacyKnowledgePresent, true);
    assert.equal(compatibilityParity.legacyKnowledgePresent, true);
    assert.equal(compatibilityParity.article.status, "match");
    assert.equal(publishPlan.currentDomain, "knowledge");
    assert.equal(publishPlan.domain, "knowledge");
    assert.equal(publishPlan.domains.code?.domain, "code");
    assert.equal(publishPlan.domains.knowledge?.domain, "knowledge");
    assert.equal(knowledgePublishPlan.domain, "knowledge");
    assert.equal(codePublishPlan.domain, "code");
    assert.ok(knowledgePublishPlan.items.length > 0);
    assert.ok(codePublishPlan.items.length > 0);
    assert.equal(knowledgeResult.refreshPlan.mode, "targeted");
    assert.equal(knowledgeRefreshPlan.domain, "knowledge");
    assert.equal(codeRefreshPlan.domain, "code");
    assert.equal(refreshPlan.mode, "targeted");
    assert.equal(refreshPlan.currentDomain, "knowledge");
    assert.equal(refreshPlan.domains.code?.domain, "code");
    assert.equal(refreshPlan.domains.knowledge?.domain, "knowledge");
    assert.deepEqual(refreshPlan.changedFiles, ["notes/2026-04-22-sync.md", "notes/adr-001-payments.md"]);
    assert.ok(refreshPlan.impactedClaimTypes.includes("knowledge_decision"));
    assert.ok(refreshPlan.impactedClaimTypes.includes("knowledge_question"));
    assert.ok(refreshPlan.targetedSourcePaths.includes("notes/adr-001-payments.md"));
    assert.equal(knowledgeResult.scanState.trigger, "watch");
    assert.equal(knowledgeScanState.domain, "knowledge");
    assert.equal(knowledgeScanState.trigger, "watch");
    assert.equal(codeScanState.domain, "code");
    assert.equal(scanState.trigger, "watch");
    assert.equal(scanState.domain, "knowledge");
    assert.equal(scanState.currentDomain, "knowledge");
    assert.equal(scanState.domains.code?.domain, "code");
    assert.equal(scanState.domains.knowledge?.trigger, "watch");
    assert.deepEqual(scanState.changedFiles, ["notes/2026-04-22-sync.md", "notes/adr-001-payments.md"]);
    assert.equal(scanState.refresh.mode, "targeted");
    assert.ok(scanState.refresh.impactedClaimTypes.includes("knowledge_decision"));
    assert.equal(publishRuns.length, 2);
    assert.ok(knowledgeResult.historyStorage.counts.publishRuns >= 2);
    assert.ok(claims.some((claim) => claim.type === "route" && claim.subject === "GET /users"));
    assert.ok(claims.some((claim) => claim.type === "knowledge_decision" && claim.subject.includes("Polar") && claim.status === "verified"));
    assert.ok(claims.some((claim) => claim.type === "knowledge_question" && claim.subject.includes("refunds") && claim.status === "verified"));
    assert.ok(claims.some((claim) => claim.type === "knowledge_person" && claim.subject === "Alex Rivera" && claim.status === "verified"));
    assert.ok(claims.some((claim) => claim.type === "knowledge_theme" && claim.subject === "payments" && claim.status === "inferred"));
    assert.ok(claims.some((claim) => claim.type === "knowledge_summary" && claim.status === "inferred"));
    assert.ok(snapshotManifest.entries.some((entry) => entry.sourcePath === "notes/adr-001-payments.md"));
    assert.ok(snapshotManifest.entries.some((entry) => entry.sourcePath === "notes/2026-04-22-sync.md"));
    assert.ok(evidence.some((entry) => entry.sourcePath === "notes/adr-001-payments.md"));
    assert.ok(evidence.some((entry) => entry.sourcePath === "notes/2026-04-22-sync.md"));
    assert.ok(evidence.some((entry) => entry.labels.includes("knowledge")));
    assert.ok(verification.some((entry) => entry.verifier === "knowledge-support" && (entry.outcome === "pass" || entry.outcome === "warn")));
    assert.ok(verification.some((entry) => entry.verifier === "line-exists" && entry.outcome === "pass"));
    assert.ok(verification.some((entry) => entry.verifier === "hash-match" && entry.outcome === "pass"));
    assert.match(knowledgeIndexView, /Knowledge/);
    assert.match(knowledgeOverviewView, /## Decisions/);
    assert.match(knowledgeOverviewView, /## Open Questions/);
    assert.match(knowledgeOverviewView, /## People/);
    assert.match(knowledgeOverviewView, /## Themes/);
    assert.match(knowledgeOverviewView, /Polar/);
    assert.match(knowledgeOverviewView, /refunds/);
    assert.match(knowledgeOverviewView, /Alex Rivera/);
    assert.match(compatibilityKnowledge, /# Knowledge Map/);
    assert.match(compatibilityKnowledge, /## Key Decisions/);
    assert.match(compatibilityKnowledge, /## Open Questions/);
    assert.match(compatibilityKnowledge, /## Recurring Themes/);
    assert.match(compatibilityKnowledge, /## People/);
    assert.match(compatibilityKnowledge, /## Note Index/);
    assert.match(compatibilityKnowledge, /Polar/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishKnowledgeCodemap marks missing note-backed claims as stale and keeps them visible in derived views", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-knowledge-stale-"));
  try {
    const notesDir = join(repoRoot, "notes");
    await mkdir(notesDir, { recursive: true });
    const notePath = join(notesDir, "adr-001-payments.md");
    await writeFile(
      notePath,
      [
        "---",
        "title: Payments ADR",
        "tags: [payments, architecture]",
        "---",
        "",
        "# Payments ADR",
        "",
        "## Decision",
        "",
        "We decided to use Polar for the initial marketplace launch.",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishKnowledgeCodemap(repoRoot, [notePath]);
    await rm(notePath, { force: true });
    await publishKnowledgeCodemap(repoRoot, []);

    const claims = parseNdjson<{ type: string; subject: string; status: string }>(
      await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"),
    );
    const verification = parseNdjson<{ verifier: string; outcome: string; reason: string }>(
      await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8"),
    );
    const knowledgeOverviewView = await readFile(join(repoRoot, ".codemap", "views", "knowledge", "overview.md"), "utf-8");
    const compatibilityKnowledge = await readFile(join(repoRoot, ".codemap", "compatibility", "KNOWLEDGE.md"), "utf-8");
    const publishRuns = parseNdjson<{ id: string }>(
      await readFile(join(repoRoot, ".codemap", "history", "publish-runs.ndjson"), "utf-8"),
    );
    const knowledgeIncidents = parseNdjson<{
      severity: string;
      message: string;
      claimIds: string[];
      source: string;
      sourceRecordId?: string;
    }>(await readFile(join(repoRoot, ".codemap", "publish", "knowledge-incidents.ndjson"), "utf-8"));
    const claimStateHistory = await getCodemapClaimStateHistory(repoRoot, {
      subject: "We decided to use Polar for the initial marketplace launch.",
    });
    const verificationHistory = await getCodemapClaimHistory(repoRoot, {
      subject: "We decided to use Polar for the initial marketplace launch.",
    });
    const latestRun = await getCodemapPublishRun(repoRoot, { latest: true });

    assert.ok(claims.some((claim) =>
      claim.type === "knowledge_decision"
      && claim.subject.includes("Polar")
      && claim.status === "stale",
    ));
    assert.ok(verification.some((entry) =>
      entry.verifier === "knowledge-support"
      && entry.outcome === "fail"
      && entry.reason.includes("missing"),
    ));
    assert.match(knowledgeOverviewView, /## Stale Claims/);
    assert.match(knowledgeOverviewView, /Polar/);
    assert.match(compatibilityKnowledge, /## Stale Claims/);
    assert.match(compatibilityKnowledge, /Polar/);
    assert.equal(publishRuns.length, 2);
    const polarStaleIncident = knowledgeIncidents.find((incident) =>
      incident.source === "claim-stale-critical" && incident.message.includes("Polar"));
    assert.ok(polarStaleIncident);
    assert.equal(polarStaleIncident?.severity, "high");
    assert.ok(polarStaleIncident?.sourceRecordId?.startsWith("verification:"));
    assert.ok(claimStateHistory);
    assert.ok(claimStateHistory!.history.length >= 2);
    assert.ok(claimStateHistory!.history.some((entry) => entry.status === "verified"));
    assert.ok(claimStateHistory!.history.some((entry) => entry.status === "stale"));
    assert.ok(verificationHistory);
    assert.ok(verificationHistory!.history.length >= 2);
    assert.ok(latestRun);
    assert.ok(latestRun!.claimHistory.some((entry) => entry.claimType === "knowledge_decision"));
    assert.ok(latestRun!.verificationHistory.some((entry) => entry.claimType === "knowledge_decision"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishKnowledgeCodemap preserves unrelated note claims during a targeted single-note refresh", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-knowledge-targeted-"));
  try {
    const notesDir = join(repoRoot, "notes");
    await mkdir(notesDir, { recursive: true });
    const paymentsPath = join(notesDir, "adr-001-payments.md");
    const searchPath = join(notesDir, "adr-002-search.md");
    await writeFile(
      paymentsPath,
      [
        "# Payments ADR",
        "",
        "## Decision",
        "",
        "We decided to use Polar for the initial marketplace launch.",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      searchPath,
      [
        "# Search ADR",
        "",
        "## Decision",
        "",
        "We decided to keep search backed by Typesense.",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishKnowledgeCodemap(repoRoot, [paymentsPath, searchPath]);
    await writeFile(
      paymentsPath,
      [
        "# Payments ADR",
        "",
        "## Decision",
        "",
        "We decided to use Stripe for the initial marketplace launch.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const targetedResult = await publishKnowledgeCodemap(repoRoot, [paymentsPath, searchPath], {
      changedFiles: ["notes/adr-001-payments.md"],
      outputDirName: ".codesight",
      trigger: "watch",
    });

    const claims = parseNdjson<{ type: string; subject: string; status: string }>(
      await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"),
    );
    const refreshPlan = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "refresh-plan.json"), "utf-8"),
    ) as {
      mode: string;
      targetedSourcePaths: string[];
    };

    assert.equal(targetedResult.refreshPlan.mode, "targeted");
    assert.equal(refreshPlan.mode, "targeted");
    assert.deepEqual(refreshPlan.targetedSourcePaths, ["notes/adr-001-payments.md"]);
    assert.ok(claims.some((claim) =>
      claim.type === "knowledge_decision"
      && claim.subject === "We decided to use Stripe for the initial marketplace launch."
      && claim.status === "verified",
    ));
    assert.ok(claims.some((claim) =>
      claim.type === "knowledge_decision"
      && claim.subject === "We decided to use Polar for the initial marketplace launch."
      && claim.status === "stale",
    ));
    assert.ok(claims.some((claim) =>
      claim.type === "knowledge_decision"
      && claim.subject === "We decided to keep search backed by Typesense."
      && claim.status === "verified",
    ));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("createSourceSnapshot normalizes source paths and generates deterministic manifest entries", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-snapshot-"));
  try {
    const sourceDir = join(repoRoot, "src");
    const absolutePath = join(sourceDir, "routes.ts");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(absolutePath, "export const routes = [];\n", "utf-8");

    const snapshot = await createSourceSnapshot({
      repoRoot,
      absolutePath,
      sourceKind: "code",
      createdAt: "2026-04-22T12:00:00.000Z",
      language: "typescript",
    });

    const manifest = buildSnapshotManifest([snapshot]);

    assert.equal(snapshot.sourcePath, "src/routes.ts");
    assert.equal(snapshot.id, await createSourceSnapshot({
      repoRoot,
      absolutePath,
      sourceKind: "code",
      createdAt: "2026-04-22T12:00:00.000Z",
      language: "typescript",
    }).then((next) => next.id));
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].sourcePath, "src/routes.ts");
    assert.equal(manifest.generatedAt, "2026-04-22T12:00:00.000Z");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("file-backed CodeMap stores persist deterministic canonical data under .codemap", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-store-"));
  try {
    const sourceDir = join(repoRoot, "src");
    const absolutePath = join(sourceDir, "routes.ts");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(absolutePath, "export const routes = [];\n", "utf-8");

    const snapshot = await createSourceSnapshot({
      repoRoot,
      absolutePath,
      sourceKind: "code",
      createdAt: "2026-04-22T12:00:00.000Z",
      language: "typescript",
    });

    const evidence = {
      id: makeCodemapId("evidence", "route-users-list"),
      snapshotId: snapshot.id,
      sourcePath: snapshot.sourcePath,
      startLine: 1,
      endLine: 1,
      excerptHash: "excerpt-hash",
      detectorMethod: "ast" as const,
      confidence: 0.98,
      labels: ["code"],
    };

    const claim = {
      id: makeCodemapId("claim", "route-users-list"),
      type: "route" as const,
      subject: "GET /users",
      text: "GET /users is handled in src/routes.ts.",
      sourceSnapshotIds: [snapshot.id],
      evidenceSpanIds: [evidence.id],
      status: "candidate" as const,
      supportScore: 0.98,
      publicationConfidence: 0.9,
      firstSeenAt: "2026-04-22T12:00:00.000Z",
      tags: ["api", "route"],
    };

    const verification = {
      id: makeCodemapId("verification", "route-users-list"),
      claimId: claim.id,
      verifier: "line-exists" as const,
      outcome: "pass" as const,
      reason: "line span resolved",
      createdAt: "2026-04-22T12:05:00.000Z",
      snapshotIdsChecked: [snapshot.id],
    };

    const conflict = {
      id: makeCodemapId("conflict", "route-users-list"),
      claimA: claim.id,
      claimB: makeCodemapId("claim", "route-users-legacy"),
      relation: "duplicates" as const,
      severity: "low" as const,
      createdAt: "2026-04-22T12:06:00.000Z",
      rationale: "legacy route aliases the same endpoint",
    };

    const snapshotStore = new FileSnapshotStore(repoRoot);
    const claimStore = new FileClaimStore(repoRoot);
    const evidenceStore = new FileEvidenceStore(repoRoot);
    const verificationStore = new FileVerificationStore(repoRoot);
    const conflictStore = new FileConflictStore(repoRoot);

    await snapshotStore.put(snapshot);
    await claimStore.put(claim);
    await evidenceStore.put(evidence);
    await verificationStore.put(verification);
    await conflictStore.put(conflict);

    assert.equal((await snapshotStore.getById(snapshot.id))?.sourcePath, "src/routes.ts");
    assert.equal(await snapshotStore.getContent(snapshot.id), "export const routes = [];\n");
    assert.equal((await claimStore.getById(claim.id))?.subject, "GET /users");
    assert.equal((await evidenceStore.getById(evidence.id))?.detectorMethod, "ast");
    assert.equal((await verificationStore.listByClaimId(claim.id)).length, 1);
    assert.equal((await conflictStore.listByClaimId(claim.id)).length, 1);

    const manifest = JSON.parse(await readFile(join(repoRoot, ".codemap", "snapshots", "manifest.json"), "utf-8"));
    const claimIndex = JSON.parse(await readFile(join(repoRoot, ".codemap", "claims", "claim-index.json"), "utf-8"));

    assert.equal(manifest.entries[0].snapshotId, snapshot.id);
    assert.equal(claimIndex.claims[0].claimId, claim.id);
    assert.ok(claimIndex.claims[0].tags.includes("route"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("searchCodemapClaims surfaces conflict membership for verified claims with low-severity conflicts", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-search-conflicts-"));
  try {
    const sourceDir = join(repoRoot, "src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "routes.ts"), "export const routes = [];\n", "utf-8");

    const snapshot = await createSourceSnapshot({
      repoRoot,
      absolutePath: join(sourceDir, "routes.ts"),
      sourceKind: "code",
      createdAt: "2026-04-25T12:00:00.000Z",
      language: "typescript",
    });

    const evidenceA = {
      id: makeCodemapId("evidence", "route-users-conflicted"),
      snapshotId: snapshot.id,
      sourcePath: snapshot.sourcePath,
      startLine: 1,
      endLine: 1,
      excerptHash: "excerpt-hash-a",
      detectorMethod: "ast" as const,
      confidence: 0.98,
      labels: ["code"],
    };

    const conflictedClaim = {
      id: makeCodemapId("claim", "route-users-conflicted"),
      type: "route" as const,
      subject: "GET /users",
      text: "GET /users is handled in src/routes.ts.",
      sourceSnapshotIds: [snapshot.id],
      evidenceSpanIds: [evidenceA.id],
      status: "verified" as const,
      supportScore: 0.98,
      publicationConfidence: 0.9,
      firstSeenAt: "2026-04-25T12:00:00.000Z",
      lastVerifiedAt: "2026-04-25T12:05:00.000Z",
      tags: ["api", "route"],
    };

    const cleanClaim = {
      id: makeCodemapId("claim", "route-orders-clean"),
      type: "route" as const,
      subject: "GET /orders",
      text: "GET /orders is handled in src/routes.ts.",
      sourceSnapshotIds: [snapshot.id],
      evidenceSpanIds: [evidenceA.id],
      status: "verified" as const,
      supportScore: 0.98,
      publicationConfidence: 0.9,
      firstSeenAt: "2026-04-25T12:00:00.000Z",
      lastVerifiedAt: "2026-04-25T12:05:00.000Z",
      tags: ["api", "route"],
    };

    const conflict = {
      id: makeCodemapId("conflict", "route-users-duplicates"),
      claimA: conflictedClaim.id,
      claimB: makeCodemapId("claim", "route-users-legacy"),
      relation: "duplicates" as const,
      severity: "low" as const,
      createdAt: "2026-04-25T12:06:00.000Z",
      rationale: "legacy route aliases the same endpoint",
    };

    await new FileSnapshotStore(repoRoot).put(snapshot);
    await new FileEvidenceStore(repoRoot).put(evidenceA);
    const claimStore = new FileClaimStore(repoRoot);
    await claimStore.put(conflictedClaim);
    await claimStore.put(cleanClaim);
    await new FileConflictStore(repoRoot).put(conflict);

    const result = await searchCodemapClaims(repoRoot, { type: "route", limit: 10 });
    assert.equal(result.totalMatches, 2);

    const conflicted = result.claims.find((claim) => claim.claimId === conflictedClaim.id);
    const clean = result.claims.find((claim) => claim.claimId === cleanClaim.id);
    assert.ok(conflicted, "conflicted claim should be in search results");
    assert.ok(clean, "non-conflicted claim should be in search results");
    assert.equal(conflicted!.status, "verified", "conflicted claim status is unchanged");
    assert.equal(conflicted!.conflictCount, 1, "conflict membership exposed on verified claim");
    assert.equal(clean!.conflictCount, 0, "claims without conflicts report zero");

    const formatted = formatCodemapSearchClaims(result);
    assert.match(formatted, /conflicts: 1/);
    assert.ok(!/GET \/orders.*conflicts:/.test(formatted), "non-conflicted row should not advertise a conflict count");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishRouteCodemap writes route claims, verification, and derived views alongside legacy output", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-routes-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-routes",
      dependencies: { express: "^4.0.0" },
    }), "utf-8");
    await writeFile(
      join(srcDir, "routes.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        'router.post("/users", (_req, res) => res.json({ ok: true }));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    const codemapResult = await publishRouteCodemap({
      ...result,
      routes: result.routes.map((route) => ({ ...route, confidence: "ast" as const })),
    });

    assert.ok(codemapResult.claims >= 2);
    assert.ok(codemapResult.snapshots >= 1);
    assert.ok(codemapResult.views.length >= 3);
    assert.equal((await readFile(join(repoRoot, ".codesight", "CODESIGHT.md"), "utf-8")).includes("# codemap-routes"), true);

    const claimsNdjson = await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8");
    const verificationNdjson = await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8");
    const routesView = await readFile(join(repoRoot, ".codemap", "views", "code", "routes.md"), "utf-8");

    assert.match(claimsNdjson, /GET \/users/);
    assert.match(verificationNdjson, /"verifier":"line-exists"/);
    assert.match(routesView, /claim_ids:/);
    assert.match(routesView, /\[verified\]/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishRouteCodemap preserves inferred labeling for regex-backed route claims", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-inferred-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "server.js"), 'if (url === "/health") { res.end("ok"); }\n', "utf-8");

    const manualResult = {
      project: {
        root: repoRoot,
      },
      routes: [
        {
          method: "GET",
          path: "/health",
          file: "src/server.js",
          tags: [],
          framework: "raw-http",
          confidence: "regex",
        },
      ],
    };

    const codemapResult = await publishRouteCodemap(manualResult as unknown as Awaited<ReturnType<typeof scan>>);
    const claimsNdjson = await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8");
    const routesView = await readFile(join(repoRoot, ".codemap", "views", "code", "routes.md"), "utf-8");

    assert.equal(codemapResult.claims, 1);
    assert.match(claimsNdjson, /"status":"inferred"/);
    assert.match(routesView, /\[inferred\]/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap preserves unrelated route claims during a targeted single-file route refresh", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-targeted-single-route-"));
  try {
    const routesDir = join(repoRoot, "src", "routes");
    await mkdir(routesDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-targeted-single-route",
      dependencies: {
        express: "^4.0.0",
      },
    }), "utf-8");
    const usersRoutePath = join(routesDir, "users.ts");
    const adminRoutePath = join(routesDir, "admin.ts");
    await writeFile(
      usersRoutePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      adminRoutePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/admin", (_req, res) => res.json({ ok: true }));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    await writeFile(
      usersRoutePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        'router.post("/users", (_req, res) => res.json({ ok: true }));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const rescanned = await scan(repoRoot, ".codesight", 10, {}, true);
    const targetedResult = await publishCodeCodemap(
      {
        ...rescanned,
        routes: rescanned.routes.filter((route) => route.file.replace(/\\/g, "/") === "src/routes/users.ts"),
      },
      {
        changedFiles: ["src/routes/users.ts"],
        trigger: "watch",
        outputDirName: ".codesight",
      },
    );

    const claims = parseNdjson<{ type: string; subject: string; status: string }>(
      await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"),
    );
    const routesView = await readFile(join(repoRoot, ".codemap", "views", "code", "routes.md"), "utf-8");

    assert.equal(targetedResult.refreshPlan.mode, "targeted");
    assert.ok(targetedResult.refreshPlan.impactedClaimTypes.includes("route"));
    assert.ok(claims.some((claim) => claim.type === "route" && claim.subject === "GET /admin" && claim.status !== "stale"));
    assert.ok(claims.some((claim) => claim.type === "route" && claim.subject === "GET /users" && claim.status !== "stale"));
    assert.ok(claims.some((claim) => claim.type === "route" && claim.subject === "POST /users" && claim.status !== "stale"));
    assert.match(routesView, /GET \/admin/);
    assert.match(routesView, /POST \/users/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap refreshes env claims for targeted code changes and preserves unrelated env claims", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-targeted-env-refresh-"));
  try {
    const routesDir = join(repoRoot, "src", "routes");
    await mkdir(routesDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-targeted-env-refresh",
      dependencies: {
        express: "^4.0.0",
      },
    }), "utf-8");
    const authRoutePath = join(routesDir, "auth.ts");
    const billingRoutePath = join(routesDir, "billing.ts");
    await writeFile(
      authRoutePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/auth/session", (_req, res) => {',
        '  res.json({ token: process.env.AUTH_SECRET });',
        "});",
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      billingRoutePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/billing/health", (_req, res) => {',
        '  res.json({ stripe: process.env.STRIPE_SECRET });',
        "});",
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    await writeFile(
      authRoutePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/auth/session", (_req, res) => {',
        '  res.json({ token: process.env.SESSION_SECRET });',
        "});",
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const targetedResult = await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true), {
      changedFiles: ["src/routes/auth.ts"],
      trigger: "watch",
      outputDirName: ".codesight",
    });

    const claims = parseNdjson<{ type: string; subject: string; status: string }>(
      await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"),
    );
    const claimHistory = parseNdjson<{
      claimId: string;
      subject: string;
      status: string;
      transition: string;
      previousStatus?: string;
    }>(
      await readFile(join(repoRoot, ".codemap", "history", "claims.ndjson"), "utf-8"),
    );

    assert.equal(targetedResult.refreshPlan.mode, "targeted");
    assert.ok(targetedResult.refreshPlan.impactedClaimTypes.includes("env_var"));
    assert.ok(claims.some((claim) =>
      claim.type === "env_var" && claim.subject === "SESSION_SECRET" && claim.status === "verified",
    ));
    assert.ok(claims.some((claim) =>
      claim.type === "env_var" && claim.subject === "STRIPE_SECRET" && claim.status === "verified",
    ));
    assert.ok(claims.some((claim) =>
      claim.type === "env_var" && claim.subject === "AUTH_SECRET" && claim.status === "stale",
    ));
    assert.ok(claimHistory.some((entry) =>
      entry.subject === "AUTH_SECRET"
      && entry.status === "stale"
      && entry.transition === "status_changed"
      && entry.previousStatus === "verified",
    ));
    const authSecretClaim = claimHistory.find((entry) => entry.subject === "AUTH_SECRET" && entry.status === "stale");
    assert.ok(authSecretClaim);
    assert.ok(
      parseNdjson<{ claimId: string; status: string }>(
        await readFile(join(repoRoot, getClaimHistoryPartitionFile(authSecretClaim!.claimId)), "utf-8"),
      ).some((entry) => entry.claimId === authSecretClaim!.claimId && entry.status === "stale"),
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap narrows hotspot refreshes to changed files and direct dependency neighbors", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-targeted-hotspot-refresh-"));
  try {
    const sharedDir = join(repoRoot, "src", "shared");
    await mkdir(sharedDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-targeted-hotspot-refresh",
    }), "utf-8");
    await writeFile(join(sharedDir, "core.ts"), "export const core = 'core';\n", "utf-8");
    await writeFile(join(sharedDir, "feature.ts"), "export const feature = 'feature';\n", "utf-8");
    await writeFile(join(sharedDir, "unrelated.ts"), "export const unrelated = 'unrelated';\n", "utf-8");
    const changedFilePath = join(repoRoot, "src", "a.ts");
    await writeFile(
      changedFilePath,
      [
        'import { core } from "./shared/core";',
        'import { feature } from "./shared/feature";',
        "export const a = [core, feature];",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(repoRoot, "src", "b.ts"),
      [
        'import { core } from "./shared/core";',
        "export const b = core;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(repoRoot, "src", "c.ts"),
      [
        'import { unrelated } from "./shared/unrelated";',
        "export const c = unrelated;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    await writeFile(
      changedFilePath,
      [
        'import { core } from "./shared/core";',
        "export const a = [core];",
        "",
      ].join("\n"),
      "utf-8",
    );

    const targetedResult = await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true), {
      changedFiles: ["src/a.ts"],
      trigger: "watch",
      outputDirName: ".codesight",
    });

    const claims = parseNdjson<{ type: string; subject: string; status: string }>(
      await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"),
    );
    const dependencyGraphCache = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "dependency-graph.json"), "utf-8"),
    ) as {
      edges: Array<{ from: string; to: string }>;
    };

    assert.equal(targetedResult.refreshPlan.mode, "targeted");
    assert.ok(targetedResult.refreshPlan.impactedClaimTypes.includes("dependency_hotspot"));
    assert.ok(claims.some((claim) =>
      claim.type === "dependency_hotspot" && claim.subject === "src/shared/core.ts" && claim.status === "verified",
    ));
    assert.ok(claims.some((claim) =>
      claim.type === "dependency_hotspot" && claim.subject === "src/shared/unrelated.ts" && claim.status === "verified",
    ));
    assert.ok(claims.some((claim) =>
      claim.type === "dependency_hotspot" && claim.subject === "src/shared/feature.ts" && claim.status === "stale",
    ));
    assert.ok(dependencyGraphCache.edges.some((edge) =>
      edge.from === "src/a.ts" && edge.to === "src/shared/core.ts",
    ));
    assert.ok(!dependencyGraphCache.edges.some((edge) =>
      edge.from === "src/a.ts" && edge.to === "src/shared/feature.ts",
    ));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap preserves unrelated schema claims during a targeted route-only refresh", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-targeted-route-refresh-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-targeted-route-refresh",
      dependencies: {
        express: "^4.0.0",
        "drizzle-orm": "^0.30.0",
      },
    }), "utf-8");
    const routePath = join(srcDir, "routes.ts");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(srcDir, "schema.ts"),
      [
        'import { pgTable, text, uuid } from "drizzle-orm/pg-core";',
        "",
        'export const users = pgTable("users", {',
        '  id: uuid("id").primaryKey(),',
        '  email: text("email").notNull().unique(),',
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        'router.post("/users", (_req, res) => res.json({ ok: true }));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const rescanned = await scan(repoRoot, ".codesight", 10, {}, true);
    const targetedResult = await publishCodeCodemap(
      {
        ...rescanned,
        schemas: [],
      },
      {
        changedFiles: ["src/routes.ts"],
        trigger: "watch",
        outputDirName: ".codesight",
      },
    );

    const claims = parseNdjson<{ type: string; subject: string; status: string }>(
      await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"),
    );
    const databaseView = await readFile(join(repoRoot, ".codemap", "views", "code", "database.md"), "utf-8");

    assert.equal(targetedResult.refreshPlan.mode, "targeted");
    assert.ok(targetedResult.refreshPlan.impactedClaimTypes.includes("route"));
    assert.ok(!targetedResult.refreshPlan.impactedClaimTypes.includes("model"));
    assert.ok(claims.some((claim) => claim.type === "model" && claim.subject === "users" && claim.status === "verified"));
    assert.match(databaseView, /users/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap renders schema-backed model and relation claims as derived database views", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-schema-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-schema",
      dependencies: {
        express: "^4.0.0",
        "drizzle-orm": "^0.30.0",
      },
    }), "utf-8");
    await writeFile(
      join(srcDir, "routes.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(srcDir, "schema.ts"),
      [
        'import { pgTable, text, uuid } from "drizzle-orm/pg-core";',
        "",
        'export const users = pgTable("users", {',
        '  id: uuid("id").primaryKey(),',
        '  email: text("email").notNull().unique(),',
        "});",
        "",
        'export const posts = pgTable("posts", {',
        '  id: uuid("id").primaryKey(),',
        '  userId: uuid("user_id").references(() => users.id),',
        '  title: text("title").notNull(),',
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    const codemapResult = await publishCodeCodemap(result);

    const claimsNdjson = await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8");
    const verificationNdjson = await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8");
    const databaseView = await readFile(join(repoRoot, ".codemap", "views", "code", "database.md"), "utf-8");
    const compatibilityIndex = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "index.md"), "utf-8");
    const compatibilityOverview = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "overview.md"), "utf-8");
    const compatibilityDatabase = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "database.md"), "utf-8");
    const compatibilityUsers = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "users.md"), "utf-8");

    assert.ok(codemapResult.claims >= 4);
    assert.ok(codemapResult.views.some((view) => view.path === ".codemap/views/code/database.md"));
    assert.ok(codemapResult.compatibilityViews.some((view) => view.path === ".codemap/compatibility/wiki/index.md"));
    assert.match(claimsNdjson, /"type":"model"/);
    assert.match(claimsNdjson, /"type":"relation"/);
    assert.match(claimsNdjson, /"subject":"users"/);
    assert.match(claimsNdjson, /"subject":"posts.userId"/);
    assert.match(verificationNdjson, /"verifier":"schema-consistency"/);
    assert.match(databaseView, /Database Inventory/);
    assert.match(databaseView, /claim_ids:/);
    assert.match(databaseView, /posts.userId/);
    assert.match(compatibilityIndex, /Compatibility Wiki/);
    assert.match(compatibilityIndex, /\[Database\]\(\.\/database\.md\)/);
    assert.match(compatibilityOverview, /Subsystems/);
    assert.match(compatibilityOverview, /\[Users\]\(\.\/users\.md\)/);
    assert.match(compatibilityDatabase, /### users \[verified\]/);
    assert.match(compatibilityUsers, /`GET` `\/users` \[(verified|inferred)\]/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap renders component claims as derived ui views", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-ui-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-ui",
      dependencies: {
        react: "^18.0.0",
      },
    }), "utf-8");
    await writeFile(
      join(srcDir, "UserProfile.tsx"),
      [
        '"use client";',
        "",
        "type Props = { name: string; email: string };",
        "",
        "export function UserProfile({ name, email }: Props) {",
        "  return <div>{name} - {email}</div>;",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(srcDir, "DashboardShell.tsx"),
      [
        "type Props = { title: string };",
        "",
        "export default function DashboardShell({ title }: Props) {",
        "  return <main>{title}</main>;",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    const codemapResult = await publishCodeCodemap(result);

    const claimsNdjson = await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8");
    const verificationNdjson = await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8");
    const uiView = await readFile(join(repoRoot, ".codemap", "views", "code", "ui.md"), "utf-8");
    const compatibilityUi = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "ui.md"), "utf-8");

    assert.ok(codemapResult.views.some((view) => view.path === ".codemap/views/code/ui.md"));
    assert.ok(codemapResult.compatibilityViews.some((view) => view.path === ".codemap/compatibility/wiki/ui.md"));
    assert.match(claimsNdjson, /"type":"component"/);
    assert.match(claimsNdjson, /"subject":"UserProfile"/);
    assert.match(verificationNdjson, /"verifier":"component-consistency"/);
    assert.match(uiView, /UI Inventory/);
    assert.match(uiView, /Client Components/);
    assert.match(uiView, /UserProfile/);
    assert.match(compatibilityUi, /# UI/);
    assert.match(compatibilityUi, /Client Components/);
    assert.match(compatibilityUi, /\*\*UserProfile\*\*/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap renders library claims as derived library views", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-libraries-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-libraries",
    }), "utf-8");

    for (let index = 0; index < 10; index++) {
      await writeFile(
        join(srcDir, `lib-${index}.ts`),
        [
          `export const item${index} = ${index};`,
          `export function read${index}() { return item${index}; }`,
          "",
        ].join("\n"),
        "utf-8",
      );
    }

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    await generateWiki(result, join(repoRoot, ".codesight"));
    const codemapResult = await publishCodeCodemap(result);

    const claimsNdjson = await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8");
    const verificationNdjson = await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8");
    const librariesView = await readFile(join(repoRoot, ".codemap", "views", "code", "libraries.md"), "utf-8");
    const compatibilityLibraries = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "libraries.md"), "utf-8");

    assert.ok(codemapResult.views.some((view) => view.path === ".codemap/views/code/libraries.md"));
    assert.ok(codemapResult.compatibilityViews.some((view) => view.path === ".codemap/compatibility/wiki/libraries.md"));
    assert.match(claimsNdjson, /"type":"library_module"/);
    assert.match(claimsNdjson, /"subject":"src\/lib-0.ts"/);
    assert.match(verificationNdjson, /"verifier":"library-consistency"/);
    assert.match(librariesView, /Library Inventory/);
    assert.match(librariesView, /read0/);
    assert.match(compatibilityLibraries, /# Libraries/);
    assert.match(compatibilityLibraries, /10 library files/);
    assert.match(compatibilityLibraries, /src\/lib-0\.ts/);
    assert.ok(codemapResult.compatibilityParity.articles.some((article) => article.article === "libraries.md" && article.status === "match"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap renders dependency hotspot claims and compatibility high-impact file sections", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-hotspots-"));
  try {
    const routesDir = join(repoRoot, "src", "routes");
    const sharedDir = join(repoRoot, "src", "shared");
    const servicesDir = join(repoRoot, "src", "services");
    await mkdir(routesDir, { recursive: true });
    await mkdir(sharedDir, { recursive: true });
    await mkdir(servicesDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-hotspots",
      dependencies: {
        express: "^4.0.0",
      },
    }), "utf-8");
    await writeFile(
      join(sharedDir, "core.ts"),
      [
        "export function coreHelper() {",
        "  return 'core';",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(routesDir, "users.ts"),
      [
        'import { Router } from "express";',
        'import { coreHelper } from "../shared/core";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json({ helper: coreHelper() }));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(routesDir, "admin.ts"),
      [
        'import { Router } from "express";',
        'import { coreHelper } from "../shared/core";',
        "const router = Router();",
        'router.get("/admin/stats", (_req, res) => res.json({ helper: coreHelper() }));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(servicesDir, "report.ts"),
      [
        'import { coreHelper } from "../shared/core";',
        "",
        "export function buildReport() {",
        "  return coreHelper();",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    await generateWiki(result, join(repoRoot, ".codesight"));
    const codemapResult = await publishCodeCodemap(result);

    const claimsNdjson = await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8");
    const verificationNdjson = await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8");
    const impactView = await readFile(join(repoRoot, ".codemap", "views", "code", "impact.md"), "utf-8");
    const overviewView = await readFile(join(repoRoot, ".codemap", "views", "overview.md"), "utf-8");
    const compatibilityOverview = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "overview.md"), "utf-8");

    assert.ok(codemapResult.views.some((view) => view.path === ".codemap/views/code/impact.md"));
    assert.match(claimsNdjson, /"type":"dependency_hotspot"/);
    assert.match(claimsNdjson, /"subject":"src\/shared\/core\.ts"/);
    assert.match(verificationNdjson, /"verifier":"hotspot-consistency"/);
    assert.match(impactView, /Impact Inventory/);
    assert.match(impactView, /src\/shared\/core\.ts/);
    assert.match(impactView, /imported by 3 files/);
    assert.match(overviewView, /High-Impact Files/);
    assert.match(compatibilityOverview, /## High-Impact Files/);
    assert.match(compatibilityOverview, /src\/shared\/core\.ts/);
    assert.match(compatibilityOverview, /imported by \*\*3\*\* files/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap renders config file and package dependency claims as a derived config view", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-config-"));
  try {
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-config",
      dependencies: {
        express: "^4.0.0",
        zod: "^3.0.0",
      },
      devDependencies: {
        typescript: "^5.0.0",
      },
    }, null, 2), "utf-8");
    await writeFile(join(repoRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
      },
    }, null, 2), "utf-8");
    await writeFile(join(repoRoot, "vite.config.ts"), "export default {};\n", "utf-8");
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "src", "index.ts"), "export const ok = true;\n", "utf-8");

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    const codemapResult = await publishCodeCodemap(result);

    const claimsNdjson = await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8");
    const verificationNdjson = await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8");
    const configView = await readFile(join(repoRoot, ".codemap", "views", "code", "config.md"), "utf-8");
    const indexView = await readFile(join(repoRoot, ".codemap", "views", "index.md"), "utf-8");
    const overviewView = await readFile(join(repoRoot, ".codemap", "views", "overview.md"), "utf-8");

    assert.ok(codemapResult.views.some((view) => view.path === ".codemap/views/code/config.md"));
    assert.match(claimsNdjson, /"type":"config_file"/);
    assert.match(claimsNdjson, /"type":"package_dependency"/);
    assert.match(claimsNdjson, /"subject":"tsconfig\.json"/);
    assert.match(claimsNdjson, /"subject":"express"/);
    assert.match(verificationNdjson, /"verifier":"config-consistency"/);
    assert.match(verificationNdjson, /"verifier":"dependency-consistency"/);
    assert.match(configView, /Config Inventory/);
    assert.match(configView, /Config Files/);
    assert.match(configView, /tsconfig\.json/);
    assert.match(configView, /Key Dependencies/);
    assert.match(configView, /express/);
    assert.match(configView, /Development Dependencies/);
    assert.match(configView, /typescript/);
    assert.match(indexView, /Config Inventory/);
    assert.match(overviewView, /## Setup/);
    assert.match(overviewView, /package dependency claims/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap writes scan-state metadata for watch-driven refreshes", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-scan-state-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-scan-state",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    await writeFile(
      join(srcDir, "routes.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    const codemapResult = await publishCodeCodemap(result, {
      changedFiles: ["src/routes.ts", "package.json"],
      outputDirName: ".codesight",
      trigger: "watch",
    });

    const scanState = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "scan-state.json"), "utf-8"),
    ) as {
      currentDomain: string;
      domain: string;
      trigger: string;
      outputDirName: string;
      changedFiles: string[];
      claims: number;
      domains: { code?: { domain: string; trigger: string; }; };
      incidents: number;
      compatibilityParity: { legacyWikiPresent: boolean; };
      refresh: { mode: string; impactedClaimTypes: string[]; targetedClaimCount: number; };
    };
    const codeScanState = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "cache", "code-scan-state.json"), "utf-8"),
    ) as {
      domain: string;
      trigger: string;
    };

    assert.equal(codemapResult.scanState.trigger, "watch");
    assert.equal(scanState.trigger, "watch");
    assert.equal(scanState.domain, "code");
    assert.equal(scanState.currentDomain, "code");
    assert.equal(scanState.domains.code?.domain, "code");
    assert.equal(codeScanState.domain, "code");
    assert.equal(codeScanState.trigger, "watch");
    assert.equal(scanState.outputDirName, ".codesight");
    assert.deepEqual(scanState.changedFiles, ["package.json", "src/routes.ts"]);
    assert.ok(scanState.claims >= 1);
    assert.equal(scanState.incidents, codemapResult.incidents.length);
    assert.equal(scanState.compatibilityParity.legacyWikiPresent, false);
    assert.equal(scanState.refresh.mode, "targeted");
    assert.ok(scanState.refresh.impactedClaimTypes.includes("route"));
    assert.ok(scanState.refresh.targetedClaimCount >= 1);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap renders runtime claims and compatibility runtime signals from env vars and middleware", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-runtime-"));
  try {
    const srcDir = join(repoRoot, "src");
    const middlewareDir = join(srcDir, "middleware");
    await mkdir(middlewareDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-runtime",
      dependencies: {
        express: "^4.0.0",
      },
    }), "utf-8");
    await writeFile(
      join(repoRoot, ".env.example"),
      [
        "DATABASE_URL=postgres://localhost/app",
        "AUTH_SECRET=",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(middlewareDir, "auth.ts"),
      [
        "export function requireAuth(_req: unknown, _res: unknown, next: () => void) {",
        "  next();",
        "}",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(srcDir, "routes.ts"),
      [
        'import { Router } from "express";',
        'import { requireAuth } from "./middleware/auth";',
        "const router = Router();",
        'router.get("/auth/profile", requireAuth, (_req, res) => {',
        '  const token = process.env.AUTH_SECRET;',
        '  const databaseUrl = process.env.DATABASE_URL;',
        '  res.json({ ok: Boolean(token && databaseUrl) });',
        "});",
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    await generateWiki(result, join(repoRoot, ".codesight"));
    const codemapResult = await publishCodeCodemap(result);

    const claimsNdjson = await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8");
    const verificationNdjson = await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8");
    const runtimeView = await readFile(join(repoRoot, ".codemap", "views", "code", "runtime.md"), "utf-8");
    const compatibilityOverview = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "overview.md"), "utf-8");
    const compatibilityIndex = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "index.md"), "utf-8");
    const compatibilityAuth = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "auth.md"), "utf-8");

    assert.ok(codemapResult.views.some((view) => view.path === ".codemap/views/code/runtime.md"));
    assert.match(claimsNdjson, /"type":"env_var"/);
    assert.match(claimsNdjson, /"type":"middleware"/);
    assert.match(claimsNdjson, /"subject":"AUTH_SECRET"/);
    assert.match(claimsNdjson, /"subject":"auth"/);
    assert.match(verificationNdjson, /"verifier":"env-consistency"/);
    assert.match(verificationNdjson, /"verifier":"middleware-consistency"/);
    assert.match(runtimeView, /Runtime Inventory/);
    assert.match(runtimeView, /Required Environment Variables/);
    assert.match(runtimeView, /AUTH_SECRET/);
    assert.match(runtimeView, /Middleware/);
    assert.match(compatibilityOverview, /Required Environment Variables/);
    assert.match(compatibilityOverview, /AUTH_SECRET/);
    assert.match(compatibilityIndex, /Env vars:/);
    assert.match(compatibilityIndex, /Middleware:/);
    assert.match(compatibilityAuth, /## Middleware/);
    assert.match(compatibilityAuth, /\*\*auth\*\* \(auth\)/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap writes a parity report when a legacy wiki baseline exists", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-parity-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-parity",
      dependencies: {
        express: "^4.0.0",
        "drizzle-orm": "^0.30.0",
      },
    }), "utf-8");
    await writeFile(
      join(srcDir, "routes.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(srcDir, "schema.ts"),
      [
        'import { pgTable, text, uuid } from "drizzle-orm/pg-core";',
        "",
        'export const users = pgTable("users", {',
        '  id: uuid("id").primaryKey(),',
        '  email: text("email").notNull().unique(),',
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    await generateWiki(result, join(repoRoot, ".codesight"));
    const codemapResult = await publishCodeCodemap(result);

    const parity = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "compatibility", "parity.json"), "utf-8"),
    ) as {
      legacyWikiPresent: boolean;
      summary: { missingCompatibility: number; matched: number; };
      articles: Array<{ article: string; status: string; }>;
    };
    const incidents = parseNdjson<{ message: string }>(
      await readFile(join(repoRoot, ".codemap", "publish", "incidents.ndjson"), "utf-8"),
    );

    assert.equal(codemapResult.compatibilityParity.legacyWikiPresent, true);
    assert.equal(parity.legacyWikiPresent, true);
    assert.equal(parity.summary.missingCompatibility, 0);
    assert.ok(parity.summary.matched >= 3);
    assert.ok(parity.articles.some((article) => article.article === "database.md" && article.status === "match"));
    assert.equal(incidents.length, 0);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap quarantines relation claims when the target model is missing", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-relation-missing-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-relation-missing",
      dependencies: {
        "drizzle-orm": "^0.30.0",
      },
    }), "utf-8");
    await writeFile(
      join(srcDir, "schema.ts"),
      [
        'import { pgTable, text, uuid } from "drizzle-orm/pg-core";',
        "",
        'export const posts = pgTable("posts", {',
        '  id: uuid("id").primaryKey(),',
        '  userId: uuid("user_id").references(() => users.id),',
        '  title: text("title").notNull(),',
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    await publishCodeCodemap(result);

    const claims = parseNdjson<{ type: string; subject: string; status: string }>(
      await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"),
    );
    const verification = parseNdjson<{ claimId: string; verifier: string; outcome: string; reason: string }>(
      await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8"),
    );

    const relationClaim = claims.find((claim) => claim.type === "relation" && claim.subject === "posts.userId");
    assert.equal(relationClaim?.status, "quarantined");
    assert.ok(verification.some((record) =>
      record.verifier === "schema-consistency"
      && record.outcome === "fail"
      && record.reason.includes("target model"),
    ));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap invalidates previously published schema claims when source files are deleted", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-schema-stale-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-schema-stale",
      dependencies: {
        "drizzle-orm": "^0.30.0",
      },
    }), "utf-8");
    const schemaPath = join(srcDir, "schema.ts");
    await writeFile(
      schemaPath,
      [
        'import { pgTable, text, uuid } from "drizzle-orm/pg-core";',
        "",
        'export const users = pgTable("users", {',
        '  id: uuid("id").primaryKey(),',
        '  email: text("email").notNull().unique(),',
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));
    await rm(schemaPath, { force: true });
    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const claims = parseNdjson<{ type: string; subject: string; status: string }>(
      await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"),
    );
    const verification = parseNdjson<{ verifier: string; outcome: string; reason: string }>(
      await readFile(join(repoRoot, ".codemap", "verification", "verification.ndjson"), "utf-8"),
    );
    const databaseView = await readFile(join(repoRoot, ".codemap", "views", "code", "database.md"), "utf-8");
    const compatibilityDatabase = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "database.md"), "utf-8");

    const userClaim = claims.find((claim) => claim.type === "model" && claim.subject === "users");
    assert.equal(userClaim?.status, "stale");
    assert.ok(verification.some((record) =>
      record.verifier === "line-exists"
      && record.outcome === "fail"
      && record.reason.includes("missing"),
    ));
    assert.match(databaseView, /Stale Claims/);
    assert.match(databaseView, /users/);
    assert.match(compatibilityDatabase, /## Stale Claims/);
    assert.match(compatibilityDatabase, /`users` \[stale\]/);

    const incidents = parseNdjson<{
      severity: string;
      message: string;
      claimIds: string[];
      source: string;
      sourceRecordId?: string;
    }>(await readFile(join(repoRoot, ".codemap", "publish", "incidents.ndjson"), "utf-8"));
    const staleIncident = incidents.find((incident) =>
      incident.source === "claim-stale-critical" && incident.message.includes("users"));
    assert.ok(staleIncident);
    assert.equal(staleIncident?.severity, "high");
    assert.ok(staleIncident?.sourceRecordId?.startsWith("verification:"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap records parity incidents for legacy wiki articles without CodeMap compatibility coverage", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-parity-custom-gap-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-parity-custom-gap",
    }), "utf-8");
    await writeFile(join(srcDir, "routes.ts"), 'export const ok = true;\n', "utf-8");

    const result = await scan(repoRoot, ".codesight", 10, {}, true);
    await generateWiki(result, join(repoRoot, ".codesight"));
    await writeFile(
      join(repoRoot, ".codesight", "wiki", "custom.md"),
      "# Custom\n\nLegacy-only article.\n",
      "utf-8",
    );
    const codemapResult = await publishCodeCodemap(result);

    const parity = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "compatibility", "parity.json"), "utf-8"),
    ) as {
      legacyWikiPresent: boolean;
      summary: { missingCompatibility: number; };
      articles: Array<{ article: string; status: string; }>;
    };
    const incidents = parseNdjson<{ message: string }>(
      await readFile(join(repoRoot, ".codemap", "publish", "incidents.ndjson"), "utf-8"),
    );

    assert.equal(codemapResult.compatibilityParity.legacyWikiPresent, true);
    assert.ok(parity.summary.missingCompatibility >= 1);
    assert.ok(parity.articles.some((article) => article.article === "custom.md" && article.status === "missing_compatibility"));
    assert.ok(incidents.some((incident) => incident.message.includes("custom.md")));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap renders schema conflicts for contradictory duplicate models", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-schema-conflicts-"));
  try {
    const schemaDir = join(repoRoot, "src", "schema");
    await mkdir(schemaDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-schema-conflicts",
      dependencies: {
        "drizzle-orm": "^0.30.0",
      },
    }), "utf-8");
    await writeFile(
      join(schemaDir, "current.ts"),
      [
        'import { pgTable, text, uuid } from "drizzle-orm/pg-core";',
        'export const users = pgTable("users", {',
        '  id: uuid("id").primaryKey(),',
        '  email: text("email").notNull().unique(),',
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(schemaDir, "legacy.ts"),
      [
        'import { pgTable, text, uuid } from "drizzle-orm/pg-core";',
        'export const users = pgTable("users", {',
        '  id: uuid("id").primaryKey(),',
        '  email: text("email").notNull().unique(),',
        '  name: text("name"),',
        "});",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const conflicts = parseNdjson<{ relation: string; severity: string; rationale: string }>(
      await readFile(join(repoRoot, ".codemap", "conflicts", "conflicts.ndjson"), "utf-8"),
    );
    const databaseView = await readFile(join(repoRoot, ".codemap", "views", "code", "database.md"), "utf-8");
    const compatibilityDatabase = await readFile(join(repoRoot, ".codemap", "compatibility", "wiki", "database.md"), "utf-8");

    assert.ok(conflicts.some((conflict) => conflict.relation === "conflicts" && conflict.severity === "medium"));
    assert.match(databaseView, /## Conflicts/);
    assert.match(databaseView, /\[medium\] conflicts/);
    assert.match(databaseView, /disagree on schema details/);
    assert.match(compatibilityDatabase, /## Conflicts/);
    assert.match(compatibilityDatabase, /disagree on schema details/);

    const incidents = parseNdjson<{
      severity: string;
      message: string;
      claimIds: string[];
      source: string;
      sourceRecordId?: string;
    }>(await readFile(join(repoRoot, ".codemap", "publish", "incidents.ndjson"), "utf-8"));
    const conflictIncident = incidents.find((incident) => incident.source === "conflict-medium");
    assert.ok(conflictIncident);
    assert.equal(conflictIncident?.severity, "medium");
    assert.equal(conflictIncident?.claimIds.length, 2);
    assert.ok(conflictIncident?.sourceRecordId);
    assert.match(conflictIncident!.message, /schema details/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CodeMap claim verification and snapshot diff surface live workspace drift", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-verify-diff-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-verify-diff",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    const routePath = join(srcDir, "routes.ts");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/accounts", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    const verifyResponse = await getCodemapVerifyClaim(repoRoot, { subject: "GET /users" });
    const diffResponse = await getCodemapDiffSinceSnapshot(repoRoot, { source_path: "src/routes.ts" });

    assert.ok(verifyResponse);
    assert.equal(verifyResponse?.verdict, "warning");
    assert.equal(verifyResponse?.workspaceDriftCount, 1);
    assert.ok(verifyResponse?.snapshots.some((snapshot) => snapshot.sourcePath === "src/routes.ts" && snapshot.state === "changed"));

    assert.ok(diffResponse);
    assert.equal(diffResponse?.snapshot.sourcePath, "src/routes.ts");
    assert.equal(diffResponse?.current.state, "changed");
    assert.equal(diffResponse?.contentDiff?.kind, "changed");
    assert.ok(diffResponse?.contentDiff?.stored?.excerpt.some((line) => line.includes("/users")));
    assert.ok(diffResponse?.contentDiff?.current?.excerpt.some((line) => line.includes("/accounts")));
    assert.ok(diffResponse?.activeClaims.some((claim) => claim.subject === "GET /users"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CodeMap keeps historical snapshot content diffable after a republish", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-historical-snapshot-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-historical-snapshot",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    const routePath = join(srcDir, "routes.ts");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));
    const initialDiff = await getCodemapDiffSinceSnapshot(repoRoot, { source_path: "src/routes.ts" });
    const initialSnapshotId = initialDiff?.snapshot.id;

    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/accounts", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    assert.ok(initialSnapshotId);
    const historicalDiff = await getCodemapDiffSinceSnapshot(repoRoot, { snapshot_id: initialSnapshotId! });

    assert.ok(historicalDiff);
    assert.equal(historicalDiff?.snapshot.id, initialSnapshotId);
    assert.equal(historicalDiff?.snapshot.sourcePath, "src/routes.ts");
    assert.equal(historicalDiff?.current.state, "changed");
    assert.equal(historicalDiff?.contentDiff?.kind, "changed");
    assert.ok(historicalDiff?.contentDiff?.stored?.excerpt.some((line) => line.includes("/users")));
    assert.ok(historicalDiff?.contentDiff?.current?.excerpt.some((line) => line.includes("/accounts")));
    assert.ok(historicalDiff?.activeClaims.some((claim) => claim.subject === "GET /accounts"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap plans snapshot archive segments for historical snapshots in observe mode", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-snapshot-archive-plan-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-snapshot-archive-plan",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    const routePath = join(srcDir, "routes.ts");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));
    const firstDiff = await getCodemapDiffSinceSnapshot(repoRoot, { source_path: "src/routes.ts" });
    const firstSnapshotId = firstDiff?.snapshot.id;

    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/accounts", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const snapshotManifest = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "archive", "snapshot-manifest.json"), "utf-8"),
    ) as {
      mode: string;
      plannedBytes: number;
      segments: Array<{ snapshotId: string; state: string; sourcePath: string; bytes: number; }>;
    };
    const historyStorage = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "history", "storage-status.json"), "utf-8"),
    ) as {
      snapshotStorage: {
        activeSnapshots: number;
        historicalHotSnapshots: number;
        plannedSnapshots: number;
      };
      snapshotArchiveCandidates: Array<{ snapshotId: string }>;
    };
    assert.ok(firstSnapshotId);
    assert.equal(snapshotManifest.mode, "observe");
    assert.ok(snapshotManifest.plannedBytes > 0);
    assert.ok(snapshotManifest.segments.some((segment) =>
      segment.snapshotId === firstSnapshotId
      && segment.state === "planned"
      && segment.sourcePath === "src/routes.ts"
      && segment.bytes > 0,
    ));
    assert.ok(historyStorage.snapshotStorage.activeSnapshots >= 1);
    assert.ok(historyStorage.snapshotStorage.historicalHotSnapshots >= 1);
    assert.ok(historyStorage.snapshotStorage.plannedSnapshots >= 1);
    assert.ok(historyStorage.snapshotArchiveCandidates.some((candidate) => candidate.snapshotId === firstSnapshotId));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishCodeCodemap compacts historical snapshots into archive bundles while keeping snapshot lookups working", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-snapshot-archive-compact-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-snapshot-archive-compact",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    const routePath = join(srcDir, "routes.ts");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));
    const firstDiff = await getCodemapDiffSinceSnapshot(repoRoot, { source_path: "src/routes.ts" });
    const firstSnapshotId = firstDiff?.snapshot.id;

    await writeFile(join(repoRoot, ".codemap", "history", "policy.json"), JSON.stringify({
      version: 1,
      updatedAt: "2026-04-22T12:00:00.000Z",
      mode: "compact",
      maxHotBytes: 1,
      targetHotBytes: 0,
      warnAtPercent: 0.5,
      segmentTargetBytes: 512,
      preserveFullLedgers: true,
    }, null, 2), "utf-8");
    await writeFile(
      routePath,
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/accounts", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );
    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true));

    const snapshotManifest = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "archive", "snapshot-manifest.json"), "utf-8"),
    ) as {
      mode: string;
      totalArchiveBytes: number;
      segments: Array<{
        snapshotId: string;
        state: string;
        bundlePath?: string;
        metadataPath?: string;
        contentPath?: string;
        compression: string;
      }>;
    };
    const snapshotIndex = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "archive", "snapshot-index.json"), "utf-8"),
    ) as {
      snapshots: Array<{
        snapshotId: string;
        bundlePath?: string;
        metadataPath?: string;
        contentPath?: string;
      }>;
    };
    const historyStorage = JSON.parse(
      await readFile(join(repoRoot, ".codemap", "history", "storage-status.json"), "utf-8"),
    ) as {
      snapshotStorage: {
        historicalHotSnapshots: number;
        archivedSnapshots: number;
      };
    };
    const snapshotStore = new FileSnapshotStore(repoRoot);
    const archivedSnapshot = await snapshotStore.getById(firstSnapshotId!);
    const archivedContent = await snapshotStore.getContent(firstSnapshotId!);
    const archivedDiff = await getCodemapDiffSinceSnapshot(repoRoot, { snapshot_id: firstSnapshotId! });

    assert.ok(firstSnapshotId);
    assert.equal(snapshotManifest.mode, "compact");
    assert.ok(snapshotManifest.totalArchiveBytes > 0);
    const targetSegment = snapshotManifest.segments.find((segment) =>
      segment.snapshotId === firstSnapshotId && segment.state === "archived");
    assert.ok(targetSegment);
    assert.equal(targetSegment?.compression, "gzip");
    assert.equal(targetSegment?.bundlePath, undefined);
    assert.ok(targetSegment?.metadataPath?.startsWith(".codemap/archive/snapshots/files/"));
    assert.ok(targetSegment?.metadataPath?.endsWith(".json"));
    assert.ok(targetSegment?.contentPath?.startsWith(".codemap/archive/snapshots/content/"));
    assert.ok(targetSegment?.contentPath?.endsWith(".txt.gz"));
    const targetIndexEntry = snapshotIndex.snapshots.find((entry) => entry.snapshotId === firstSnapshotId);
    assert.ok(targetIndexEntry);
    assert.equal(targetIndexEntry?.bundlePath, undefined);
    assert.equal(targetIndexEntry?.metadataPath, targetSegment?.metadataPath);
    assert.equal(targetIndexEntry?.contentPath, targetSegment?.contentPath);
    const metadataShard = JSON.parse(
      await readFile(join(repoRoot, targetSegment!.metadataPath!), "utf-8"),
    ) as { id: string };
    assert.equal(metadataShard.id, firstSnapshotId);
    const contentShardBytes = await readFile(join(repoRoot, targetSegment!.contentPath!));
    assert.ok(gunzipSync(contentShardBytes).toString("utf-8").includes("/users"));
    assert.equal(historyStorage.snapshotStorage.historicalHotSnapshots, 0);
    assert.ok(historyStorage.snapshotStorage.archivedSnapshots >= 1);
    assert.equal(archivedSnapshot?.id, firstSnapshotId);
    assert.ok(archivedContent?.includes("/users"));
    assert.ok(archivedDiff);
    assert.equal(archivedDiff?.contentDiff?.kind, "changed");
    assert.ok(archivedDiff?.contentDiff?.stored?.excerpt.some((line) => line.includes("/users")));
    assert.ok(archivedDiff?.contentDiff?.current?.excerpt.some((line) => line.includes("/accounts")));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("FileSnapshotStore reads legacy bundle-based snapshot archives without per-snapshot shards", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-snapshot-archive-legacy-"));
  try {
    const { gzipSync } = await import("node:zlib");
    const { createHash } = await import("node:crypto");

    const snapshotId = "snapshot:legacy-fixture";
    const sourcePath = "src/legacy.ts";
    const contentHash = "deadbeef";
    const createdAt = "2026-04-23T00:00:00.000Z";
    const segmentId = "snapshot:archive-legacy-segment";
    const sourceText = 'export const value = "legacy archive content";\n';

    const basename = createHash("sha256").update(snapshotId).digest("hex");
    const bundlePath = `.codemap/archive/snapshots/${basename}.json.gz`;
    const bundle = {
      version: 1,
      segmentId,
      createdAt,
      mode: "archive",
      snapshot: {
        id: snapshotId,
        sourcePath,
        sourceKind: "code",
        contentHash,
        createdAt,
        sizeBytes: sourceText.length,
      },
      content: sourceText,
    };
    const compressedBundle = gzipSync(Buffer.from(JSON.stringify(bundle), "utf-8"));

    await mkdir(join(repoRoot, ".codemap", "archive", "snapshots"), { recursive: true });
    await mkdir(join(repoRoot, ".codemap", "archive"), { recursive: true });
    await writeFile(join(repoRoot, bundlePath), compressedBundle);

    await writeFile(
      join(repoRoot, ".codemap", "archive", "snapshot-manifest.json"),
      `${JSON.stringify({
        version: 1,
        generatedAt: createdAt,
        mode: "archive",
        segments: [{
          id: segmentId,
          snapshotId,
          sourcePath,
          createdAt,
          contentHash,
          sizeBytes: sourceText.length,
          bytes: compressedBundle.byteLength,
          state: "archived",
          compression: "gzip",
          bundlePath,
        }],
        totalArchiveBytes: compressedBundle.byteLength,
        plannedBytes: 0,
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      join(repoRoot, ".codemap", "archive", "snapshot-index.json"),
      `${JSON.stringify({
        version: 1,
        generatedAt: createdAt,
        snapshots: [{
          snapshotId,
          sourcePath,
          createdAt,
          contentHash,
          sizeBytes: sourceText.length,
          bytes: compressedBundle.byteLength,
          segmentId,
          bundlePath,
        }],
      }, null, 2)}\n`,
      "utf-8",
    );

    const snapshotStore = new FileSnapshotStore(repoRoot);
    const fetched = await snapshotStore.getById(snapshotId);
    const fetchedContent = await snapshotStore.getContent(snapshotId);

    assert.equal(fetched?.id, snapshotId);
    assert.equal(fetched?.sourcePath, sourcePath);
    assert.equal(fetchedContent, sourceText);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CodeMap publish status summarizes latest run, refresh scope, and storage state", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-publish-status-"));
  try {
    const srcDir = join(repoRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-publish-status",
      dependencies: {
        express: "^4.0.0",
      },
    }, null, 2), "utf-8");
    await writeFile(
      join(srcDir, "routes.ts"),
      [
        'import { Router } from "express";',
        "const router = Router();",
        'router.get("/users", (_req, res) => res.json([]));',
        "export default router;",
        "",
      ].join("\n"),
      "utf-8",
    );

    await publishCodeCodemap(await scan(repoRoot, ".codesight", 10, {}, true), {
      changedFiles: ["src/routes.ts"],
      trigger: "watch",
      outputDirName: ".codesight",
    });

    const status = await getCodemapPublishStatus(repoRoot);

    assert.ok(status.latestRun);
    assert.equal(status.currentDomain, "code");
    assert.equal(status.latestRun?.trigger, "watch");
    assert.equal(status.scanState?.trigger, "watch");
    assert.equal(status.refreshPlan?.mode, "targeted");
    assert.equal(status.domainScanStates.code?.domain, "code");
    assert.equal(status.domainScanStates.knowledge, undefined);
    assert.equal(status.domainRefreshPlans.code?.domain, "code");
    assert.equal(status.domainPublishPlans.code?.totalItems, status.publishPlan?.totalItems);
    assert.equal(status.domainPublishPlans.code?.blockingClaims, status.publishPlan?.blockingClaims);
    assert.equal(status.domainPublishPlans.knowledge, undefined);
    assert.ok(status.publishPlan);
    assert.ok(status.publishPlan!.totalItems > 0);
    assert.ok(status.publishPlan!.decisionCounts.some((entry) =>
      entry.decision === "publish" || entry.decision === "republish_with_warning",
    ));
    assert.equal(status.incidents.total, 0);
    assert.ok(status.compatibility.code);
    assert.ok(status.historyStorage);
    assert.ok(status.historyStorage!.totalBytes >= status.historyStorage!.hotBytes);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("renderKnowledgeViews labels a stale-but-originally-inferred decision so the inferred provenance survives status flip", () => {
  const snapshot = {
    id: "snapshot:note-decisions",
    sourcePath: "notes/decisions/payments.md",
    sourceKind: "note" as const,
    contentHash: "hash-decisions",
    createdAt: "2026-04-25T12:00:00.000Z",
    sizeBytes: 100,
  };
  const staleInferredDecision = {
    id: "claim:knowledge-payments",
    type: "knowledge_decision" as const,
    subject: "Payments rails",
    text: "Team picked Polar over Stripe Connect.",
    sourceSnapshotIds: [snapshot.id],
    evidenceSpanIds: ["evidence:knowledge-payments"],
    status: "stale" as const,
    supportScore: 0.7,
    publicationConfidence: 0.6,
    firstSeenAt: "2026-04-22T12:00:00.000Z",
    lastVerifiedAt: "2026-04-25T12:00:00.000Z",
    tags: ["decision", "inferred"],
  };
  const verifiedDecision = {
    ...staleInferredDecision,
    id: "claim:knowledge-deploys",
    subject: "Deploy cadence",
    text: "Team merges to main daily.",
    status: "verified" as const,
    tags: ["decision"],
  };

  const views = renderKnowledgeViews([staleInferredDecision, verifiedDecision], [snapshot], [], "2026-04-25T12:00:00.000Z");
  const overview = views.find((view) => view.path.endsWith("knowledge/overview.md"));
  assert.ok(overview, "knowledge overview view should be produced");

  assert.match(overview!.markdown, /Payments rails`\s+\[stale\]\s+\[inferred\]/);
  assert.ok(!/Deploy cadence`\s+\[verified\]\s+\[inferred\]/.test(overview!.markdown), "verified non-inferred decision should not get the inferred label");
});

test("renderCompatibilityWiki labels stale-but-originally-inferred routes so legacy wiki readers see the regex provenance", () => {
  const snapshot = {
    id: "snapshot:routes",
    sourcePath: "src/routes.ts",
    sourceKind: "code" as const,
    contentHash: "hash-routes",
    createdAt: "2026-04-25T12:00:00.000Z",
    language: "typescript",
    sizeBytes: 120,
  };
  const staleInferredRoute = {
    id: "claim:route-stale-inferred",
    type: "route" as const,
    subject: "GET /legacy",
    text: "GET /legacy is defined in src/routes.ts.",
    sourceSnapshotIds: [snapshot.id],
    evidenceSpanIds: ["evidence:route-legacy"],
    status: "stale" as const,
    supportScore: 0.72,
    publicationConfidence: 0.72,
    firstSeenAt: "2026-04-22T12:00:00.000Z",
    lastVerifiedAt: "2026-04-25T12:00:00.000Z",
    tags: ["api", "route", "framework:express", "method:GET", "inferred"],
  };
  const verifiedRoute = {
    ...staleInferredRoute,
    id: "claim:route-verified",
    subject: "GET /current",
    text: "GET /current is defined in src/routes.ts.",
    status: "verified" as const,
    tags: ["api", "route", "framework:express", "method:GET"],
  };

  const views = renderCompatibilityWiki({
    projectName: "test",
    claims: [staleInferredRoute, verifiedRoute],
    conflicts: [],
    snapshots: [snapshot],
    generatedAt: "2026-04-25T12:00:00.000Z",
  });
  const merged = views.map((view) => view.markdown).join("\n\n");

  assert.match(merged, /GET`\s+`\/legacy`\s+\[stale\]\s+\[inferred\]/);
  assert.ok(!/GET`\s+`\/current`\s+\[verified\]\s+\[inferred\]/.test(merged), "verified non-inferred route should not get the inferred label");
});

test("getCodemapConflicts orders results by severity rank so truncated lists keep high-severity edges", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-conflicts-order-"));
  try {
    const sourceDir = join(repoRoot, "src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "routes.ts"), "export const routes = [];\n", "utf-8");

    const snapshot = await createSourceSnapshot({
      repoRoot,
      absolutePath: join(sourceDir, "routes.ts"),
      sourceKind: "code",
      createdAt: "2026-04-25T12:00:00.000Z",
      language: "typescript",
    });

    const evidence = {
      id: makeCodemapId("evidence", "route-shared"),
      snapshotId: snapshot.id,
      sourcePath: snapshot.sourcePath,
      startLine: 1,
      endLine: 1,
      excerptHash: "excerpt-hash",
      detectorMethod: "ast" as const,
      confidence: 0.98,
      labels: ["code"],
    };

    const claimA = {
      id: makeCodemapId("claim", "route-a"),
      type: "route" as const,
      subject: "GET /a",
      text: "GET /a is handled in src/routes.ts.",
      sourceSnapshotIds: [snapshot.id],
      evidenceSpanIds: [evidence.id],
      status: "verified" as const,
      supportScore: 0.98,
      publicationConfidence: 0.9,
      firstSeenAt: "2026-04-25T12:00:00.000Z",
      tags: ["api", "route"],
    };

    const claimB = {
      ...claimA,
      id: makeCodemapId("claim", "route-b"),
      subject: "GET /b",
      text: "GET /b is handled in src/routes.ts.",
    };

    const claimC = {
      ...claimA,
      id: makeCodemapId("claim", "route-c"),
      subject: "GET /c",
      text: "GET /c is handled in src/routes.ts.",
    };

    // IDs intentionally sort alphabetically opposite of severity rank:
    // "conflict:aaaa-low" < "conflict:mmmm-medium" < "conflict:zzzz-high"
    const lowConflict = {
      id: "conflict:aaaa-low",
      claimA: claimA.id,
      claimB: claimB.id,
      relation: "duplicates" as const,
      severity: "low" as const,
      createdAt: "2026-04-25T12:01:00.000Z",
      rationale: "low severity",
    };
    const mediumConflict = {
      id: "conflict:mmmm-medium",
      claimA: claimA.id,
      claimB: claimC.id,
      relation: "narrows" as const,
      severity: "medium" as const,
      createdAt: "2026-04-25T12:02:00.000Z",
      rationale: "medium severity",
    };
    const highConflict = {
      id: "conflict:zzzz-high",
      claimA: claimB.id,
      claimB: claimC.id,
      relation: "conflicts" as const,
      severity: "high" as const,
      createdAt: "2026-04-25T12:03:00.000Z",
      rationale: "high severity",
    };

    await new FileSnapshotStore(repoRoot).put(snapshot);
    await new FileEvidenceStore(repoRoot).put(evidence);
    const claimStore = new FileClaimStore(repoRoot);
    await claimStore.put(claimA);
    await claimStore.put(claimB);
    await claimStore.put(claimC);
    const conflictStore = new FileConflictStore(repoRoot);
    await conflictStore.put(lowConflict);
    await conflictStore.put(mediumConflict);
    await conflictStore.put(highConflict);

    const all = await getCodemapConflicts(repoRoot);
    assert.equal(all.totalConflicts, 3);
    assert.equal(all.conflicts[0].id, "conflict:zzzz-high", "high severity sorts first despite alphabetically-late id");
    assert.equal(all.conflicts[1].id, "conflict:mmmm-medium");
    assert.equal(all.conflicts[2].id, "conflict:aaaa-low");

    // With limit=1, the AI must still see the high-severity edge — not the alphabetically-first low one.
    const truncated = await getCodemapConflicts(repoRoot, { limit: 1 });
    assert.equal(truncated.totalConflicts, 3);
    assert.equal(truncated.conflicts.length, 1);
    assert.equal(truncated.conflicts[0].id, "conflict:zzzz-high");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CodeMap publish status incident summary breaks counts down by source and severity", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-incident-bysource-"));
  try {
    const publishDir = join(repoRoot, ".codemap", "publish");
    await mkdir(publishDir, { recursive: true });

    const codeIncidents = [
      {
        id: "incident:conflict-routes",
        createdAt: "2026-04-25T12:00:00.000Z",
        severity: "high",
        message: "two routes collide",
        claimIds: ["claim:route-a", "claim:route-b"],
        source: "conflict-high",
        sourceRecordId: "conflict:routes-collide",
      },
      {
        id: "incident:stale-route",
        createdAt: "2026-04-25T12:01:00.000Z",
        severity: "high",
        message: "route source moved",
        claimIds: ["claim:route-c"],
        source: "claim-stale-critical",
        sourceRecordId: "verification:route-c",
      },
      {
        id: "incident:stale-component",
        createdAt: "2026-04-25T12:02:00.000Z",
        severity: "medium",
        message: "component drifted",
        claimIds: ["claim:component-x"],
        source: "claim-stale",
        sourceRecordId: "verification:component-x",
      },
    ];
    const knowledgeIncidents = [
      {
        id: "incident:stale-decision",
        createdAt: "2026-04-25T12:03:00.000Z",
        severity: "high",
        message: "decision lost evidence",
        claimIds: ["claim:knowledge-decision-1"],
        source: "claim-stale-critical",
        sourceRecordId: "verification:knowledge-decision-1",
      },
    ];

    await writeFile(
      join(publishDir, "incidents.ndjson"),
      `${codeIncidents.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf-8",
    );
    await writeFile(
      join(publishDir, "knowledge-incidents.ndjson"),
      `${knowledgeIncidents.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf-8",
    );

    const status = await getCodemapPublishStatus(repoRoot);

    assert.equal(status.incidents.total, 4);
    assert.equal(status.incidents.code, 3);
    assert.equal(status.incidents.knowledge, 1);

    const bySource = status.incidents.bySource;
    assert.equal(bySource.length, 3);

    const conflictHigh = bySource.find((entry) => entry.source === "conflict-high");
    const staleCritical = bySource.find((entry) => entry.source === "claim-stale-critical");
    const stale = bySource.find((entry) => entry.source === "claim-stale");
    assert.deepEqual(conflictHigh, { source: "conflict-high", severity: "high", count: 1 });
    assert.deepEqual(staleCritical, { source: "claim-stale-critical", severity: "high", count: 2 });
    assert.deepEqual(stale, { source: "claim-stale", severity: "medium", count: 1 });

    const highEntries = bySource.filter((entry) => entry.severity === "high");
    const mediumEntries = bySource.filter((entry) => entry.severity === "medium");
    const lastHighIndex = bySource.lastIndexOf(highEntries.at(-1)!);
    const firstMediumIndex = bySource.indexOf(mediumEntries[0]);
    assert.ok(lastHighIndex < firstMediumIndex, "high-severity entries sort before medium");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("recordDecision writes a structured decision note in notes/decisions/recorded/ with ai-recorded tag", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-record-decision-unit-"));
  try {
    const result = await recordDecision({
      repoRoot,
      subject: "Switch payments from Stripe to Polar",
      decision: "We are going with Polar instead of Stripe for the initial marketplace launch.",
      rationale: "Polar lets us avoid the Stripe Connect onboarding overhead.",
      relatedSourcePaths: ["src/payments/index.ts"],
      supersedes: ["Use Stripe Connect for payouts"],
      recordedAt: "2026-04-24T12:34:56.789Z",
    });

    assert.equal(result.recordedAt, "2026-04-24T12:34:56.789Z");
    assert.ok(result.relativePath.startsWith(`${RECORDED_DECISIONS_DIR}/`));
    assert.ok(result.filename.endsWith(".md"));
    assert.equal(result.filename.includes(":"), false);
    assert.ok(result.filename.includes("switch-payments-from-stripe-to-polar"));

    const content = await readFile(result.absolutePath, "utf-8");
    assert.match(content, /recorded_at: 2026-04-24T12:34:56.789Z/);
    assert.match(content, /recorded_by: ai-session/);
    assert.match(content, new RegExp(`tags: \\[${AI_RECORDED_TAG}\\]`));
    assert.match(content, /## Decision/);
    assert.match(content, /Polar instead of Stripe/);
    assert.match(content, /## Rationale/);
    assert.match(content, /## Related Source Paths/);
    assert.match(content, /- src\/payments\/index\.ts/);
    assert.match(content, /## Supersedes/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("recordDecision rejects empty subject or decision", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-record-decision-validate-"));
  try {
    await assert.rejects(
      recordDecision({ repoRoot, subject: "  ", decision: "x" }),
      /subject must not be empty/,
    );
    await assert.rejects(
      recordDecision({ repoRoot, subject: "x", decision: "" }),
      /decision must not be empty/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("publishKnowledgeCodemap surfaces AI-recorded decisions with the recorded tag, lower confidence, and visible marker", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codemap-record-decision-e2e-"));
  try {
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({
      name: "codemap-record-decision-e2e",
    }, null, 2), "utf-8");

    const recorded = await recordDecision({
      repoRoot,
      subject: "Adopt Polar for marketplace payouts",
      decision: "Decided to use Polar for marketplace payouts.",
      rationale: "Avoids Stripe Connect onboarding overhead in MVP.",
      relatedSourcePaths: ["src/payments/index.ts"],
      recordedAt: "2026-04-24T12:34:56.789Z",
    });

    await publishKnowledgeCodemap(repoRoot, [recorded.absolutePath]);

    const claims = parseNdjson<{
      type: string;
      subject: string;
      tags: string[];
      publicationConfidence: number;
      supportScore: number;
    }>(await readFile(join(repoRoot, ".codemap", "claims", "claims.ndjson"), "utf-8"));
    const overview = await readFile(
      join(repoRoot, ".codemap", "views", "knowledge", "overview.md"),
      "utf-8",
    );

    const decisionClaim = claims.find((claim) =>
      claim.type === "knowledge_decision" && claim.subject.includes("Polar"));
    assert.ok(decisionClaim, "expected a knowledge_decision claim derived from the recorded note");
    assert.ok(decisionClaim?.tags.includes("recorded"));
    assert.ok(decisionClaim?.tags.includes(AI_RECORDED_TAG));
    assert.ok(decisionClaim!.publicationConfidence <= 0.5);
    assert.ok(decisionClaim!.supportScore <= 0.6);

    assert.match(overview, /## Decisions/);
    assert.match(overview, /\[recorded\] `Decided to use Polar for marketplace payouts/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
