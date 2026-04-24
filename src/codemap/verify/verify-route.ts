import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim, ConflictEdge, EvidenceSpan, SourceSnapshot, VerificationRecord } from "../model/types.js";
import { hashSnapshotContent } from "../snapshot/snapshotter.js";
import { makeHashedCodemapId } from "../model/ids.js";

export interface RouteVerificationResult {
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
  createdAt: string
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

export async function verifyRouteClaims(
  repoRoot: string,
  claims: Claim[],
  evidence: EvidenceSpan[],
  snapshots: SourceSnapshot[],
  createdAt = new Date().toISOString()
): Promise<RouteVerificationResult> {
  const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const verification: VerificationRecord[] = [];
  const conflicts: ConflictEdge[] = [];
  const updatedClaims: Claim[] = [];

  for (const claim of claims) {
    const claimEvidence = claim.evidenceSpanIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((entry): entry is EvidenceSpan => Boolean(entry));

    let linePass = claimEvidence.length > 0;
    let hashPass = claimEvidence.length > 0;
    const snapshotIdsChecked = claim.sourceSnapshotIds.slice().sort();

    if (claimEvidence.length === 0) {
      verification.push(createVerificationRecord(
        claim.id,
        "line-exists",
        "fail",
        "claim has no evidence spans",
        snapshotIdsChecked,
        createdAt,
      ));
      verification.push(createVerificationRecord(
        claim.id,
        "hash-match",
        "fail",
        "claim has no source snapshots to verify",
        snapshotIdsChecked,
        createdAt,
      ));
      verification.push(createVerificationRecord(
        claim.id,
        "conflict-check",
        "pass",
        "no route conflicts detected in route-only pipeline",
        snapshotIdsChecked,
        createdAt,
      ));
      updatedClaims.push({
        ...claim,
        status: "quarantined",
        lastVerifiedAt: createdAt,
      });
      continue;
    }

    for (const evidenceEntry of claimEvidence) {
      const snapshot = snapshotsById.get(evidenceEntry.snapshotId);
      if (!snapshot) {
        linePass = false;
        hashPass = false;
        continue;
      }

      const absolutePath = join(repoRoot, snapshot.sourcePath);
      try {
        const content = await readFile(absolutePath, "utf-8");
        const lines = content.split(/\r?\n/);
        const evidenceLines = lines.slice(evidenceEntry.startLine - 1, evidenceEntry.endLine);
        if (evidenceEntry.startLine < 1 || evidenceEntry.endLine < evidenceEntry.startLine || evidenceLines.length === 0) {
          linePass = false;
        }

        const currentHash = hashSnapshotContent(content);
        if (currentHash !== snapshot.contentHash) {
          hashPass = false;
        }
      } catch {
        linePass = false;
        hashPass = false;
      }
    }

    verification.push(createVerificationRecord(
      claim.id,
      "line-exists",
      linePass ? "pass" : "fail",
      linePass ? "all route evidence spans resolved against source lines" : "one or more route evidence spans no longer resolve",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "hash-match",
      hashPass ? "pass" : "fail",
      hashPass ? "route source snapshots match current file hashes" : "route source snapshots drifted from current file hashes",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "conflict-check",
      "pass",
      "no route conflicts detected in route-only pipeline",
      snapshotIdsChecked,
      createdAt,
    ));

    const nextStatus = !linePass || !hashPass
      ? "stale"
      : claim.tags.includes("inferred")
        ? "inferred"
        : "verified";

    updatedClaims.push({
      ...claim,
      status: nextStatus,
      lastVerifiedAt: createdAt,
    });
  }

  return {
    claims: updatedClaims.sort((a, b) => a.id.localeCompare(b.id)),
    verification: verification.sort((a, b) => a.id.localeCompare(b.id)),
    conflicts,
  };
}
