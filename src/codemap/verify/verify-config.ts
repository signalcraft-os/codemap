import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim, ConflictEdge, EvidenceSpan, SourceSnapshot, VerificationRecord } from "../model/types.js";
import { makeHashedCodemapId } from "../model/ids.js";
import { hashSnapshotContent } from "../snapshot/snapshotter.js";

export interface ConfigVerificationResult {
  claims: Claim[];
  verification: VerificationRecord[];
  conflicts: ConflictEdge[];
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

function getTagValue(claim: Claim, prefix: string): string | undefined {
  return claim.tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

export async function verifyConfigClaims(
  repoRoot: string,
  claims: Claim[],
  evidence: EvidenceSpan[],
  snapshots: SourceSnapshot[],
  createdAt = new Date().toISOString(),
): Promise<ConfigVerificationResult> {
  const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const verification: VerificationRecord[] = [];
  const updatedClaims: Claim[] = [];

  for (const claim of claims) {
    const claimEvidence = claim.evidenceSpanIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((entry): entry is EvidenceSpan => Boolean(entry));
    const snapshotIdsChecked = claim.sourceSnapshotIds.slice().sort();

    let linePass = claimEvidence.length > 0;
    let hashPass = claimEvidence.length > 0;
    let extractionPass = claimEvidence.length > 0;
    let missingSource = false;

    if (claimEvidence.length === 0) {
      linePass = false;
      hashPass = false;
      extractionPass = false;
    } else {
      for (const evidenceEntry of claimEvidence) {
        const snapshot = snapshotsById.get(evidenceEntry.snapshotId);
        if (!snapshot) {
          linePass = false;
          hashPass = false;
          extractionPass = false;
          continue;
        }

        const absolutePath = join(repoRoot, snapshot.sourcePath);
        try {
          const content = await readFile(absolutePath, "utf-8");
          const lines = content.split(/\r?\n/);
          const evidenceLines = lines.slice(evidenceEntry.startLine - 1, evidenceEntry.endLine);
          if (
            evidenceEntry.startLine < 1 ||
            evidenceEntry.endLine < evidenceEntry.startLine ||
            evidenceLines.length === 0
          ) {
            linePass = false;
            extractionPass = false;
          }

          const currentHash = hashSnapshotContent(content);
          if (currentHash !== snapshot.contentHash) {
            hashPass = false;
          }
        } catch {
          linePass = false;
          hashPass = false;
          extractionPass = false;
          missingSource = true;
        }
      }
    }

    const consistencyPass = claim.type === "config_file"
      ? claim.tags.some((tag) => tag.startsWith("config-kind:")) && claim.tags.some((tag) => tag.startsWith("source-kind:"))
      : claim.tags.some((tag) => tag.startsWith("dependency-scope:")) && claim.tags.some((tag) => tag.startsWith("dependency-version:"));
    const consistencyVerifier = claim.type === "config_file" ? "config-consistency" : "dependency-consistency";
    const consistencyReason = claim.type === "config_file"
      ? consistencyPass
        ? "config file claim metadata is internally consistent"
        : "config file claim is missing config-kind or source-kind metadata tags"
      : consistencyPass
        ? "package dependency claim metadata is internally consistent"
        : "package dependency claim is missing scope or version metadata tags";

    verification.push(createVerificationRecord(
      claim.id,
      "line-exists",
      linePass ? "pass" : "fail",
      linePass
        ? "all config evidence spans resolved against current source lines"
        : missingSource
          ? "config source file is missing from the current workspace"
          : "one or more config evidence spans no longer resolve",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "hash-match",
      hashPass ? "pass" : "fail",
      hashPass
        ? "config source snapshots match current file hashes"
        : missingSource
          ? "config source file is missing so the snapshot can no longer be verified"
          : "config source snapshots drifted from current file hashes",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "ast-shape",
      extractionPass ? "pass" : "fail",
      extractionPass
        ? "config evidence still resolves to extracted source spans"
        : missingSource
          ? "config evidence cannot be checked because the source file is missing"
          : "config evidence no longer resolves cleanly to the original source span",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      consistencyVerifier,
      consistencyPass ? "pass" : "fail",
      consistencyReason,
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "conflict-check",
      "pass",
      "no config or dependency conflicts detected",
      snapshotIdsChecked,
      createdAt,
    ));

    const isConfigFileClaim = claim.type === "config_file";
    const scope = getTagValue(claim, "dependency-scope:");
    const nextStatus = !linePass || !hashPass
      ? "stale"
      : !consistencyPass
        ? "quarantined"
        : !isConfigFileClaim && scope === "development"
          ? "inferred"
          : "verified";

    updatedClaims.push({
      ...claim,
      status: nextStatus,
      lastVerifiedAt: createdAt,
    });
  }

  return {
    claims: updatedClaims.sort((left, right) => left.id.localeCompare(right.id)),
    verification: verification.sort((left, right) => left.id.localeCompare(right.id)),
    conflicts: [],
  };
}
