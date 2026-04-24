import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim, ConflictEdge, EvidenceSpan, SourceSnapshot, VerificationRecord } from "../model/types.js";
import { makeHashedCodemapId } from "../model/ids.js";
import { hashSnapshotContent } from "../snapshot/snapshotter.js";

export interface MiddlewareVerificationResult {
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

function buildMiddlewareConflicts(claims: Claim[], createdAt: string): ConflictEdge[] {
  const claimsBySubject = new Map<string, Claim[]>();

  for (const claim of claims) {
    if (!claimsBySubject.has(claim.subject)) {
      claimsBySubject.set(claim.subject, []);
    }
    claimsBySubject.get(claim.subject)!.push(claim);
  }

  const conflicts: ConflictEdge[] = [];

  for (const group of claimsBySubject.values()) {
    if (group.length < 2) {
      continue;
    }

    const sortedGroup = [...group].sort((left, right) => left.id.localeCompare(right.id));
    for (let leftIndex = 0; leftIndex < sortedGroup.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < sortedGroup.length; rightIndex++) {
        const leftClaim = sortedGroup[leftIndex];
        const rightClaim = sortedGroup[rightIndex];
        const leftType = getTagValue(leftClaim, "middleware-type:") ?? "custom";
        const rightType = getTagValue(rightClaim, "middleware-type:") ?? "custom";
        const relation = leftType === rightType ? "duplicates" : "conflicts";
        const severity = leftType === rightType ? "low" : "medium";
        const rationale = leftType === rightType
          ? `middleware claims for ${leftClaim.subject} were detected in multiple files with the same ${leftType} classification`
          : `middleware claims for ${leftClaim.subject} disagree on middleware type classification (${leftType} vs ${rightType})`;

        conflicts.push({
          id: makeHashedCodemapId("conflict", [
            "middleware",
            leftClaim.id,
            rightClaim.id,
            relation,
            severity,
          ]),
          claimA: leftClaim.id,
          claimB: rightClaim.id,
          relation,
          severity,
          createdAt,
          rationale,
        });
      }
    }
  }

  return conflicts.sort((left, right) => left.id.localeCompare(right.id));
}

export async function verifyMiddlewareClaims(
  repoRoot: string,
  claims: Claim[],
  evidence: EvidenceSpan[],
  snapshots: SourceSnapshot[],
  createdAt = new Date().toISOString(),
): Promise<MiddlewareVerificationResult> {
  const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const updatedClaims: Claim[] = [];
  const verification: VerificationRecord[] = [];

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

    const middlewareType = getTagValue(claim, "middleware-type:");
    const consistencyPass = middlewareType !== undefined
      && ["auth", "rate-limit", "cors", "validation", "logging", "error-handler", "custom"].includes(middlewareType);

    verification.push(createVerificationRecord(
      claim.id,
      "line-exists",
      linePass ? "pass" : "fail",
      linePass
        ? "all middleware evidence spans resolved against current source lines"
        : missingSource
          ? "middleware source file is missing from the current workspace"
          : "one or more middleware evidence spans no longer resolve",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "hash-match",
      hashPass ? "pass" : "fail",
      hashPass
        ? "middleware source snapshots match current file hashes"
        : missingSource
          ? "middleware source file is missing so the snapshot can no longer be verified"
          : "middleware source snapshots drifted from current file hashes",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "ast-shape",
      extractionPass ? "pass" : "fail",
      extractionPass
        ? "middleware evidence still resolves to extracted source spans"
        : missingSource
          ? "middleware evidence cannot be checked because the source file is missing"
          : "middleware evidence no longer resolves cleanly to the original source span",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "middleware-consistency",
      consistencyPass ? "pass" : "fail",
      consistencyPass
        ? "middleware claim metadata is internally consistent"
        : "middleware claim is missing a valid middleware type tag",
      snapshotIdsChecked,
      createdAt,
    ));

    updatedClaims.push({
      ...claim,
      status: !linePass || !hashPass
        ? "stale"
        : !consistencyPass
          ? "quarantined"
          : "verified",
      lastVerifiedAt: createdAt,
    });
  }

  const conflicts = buildMiddlewareConflicts(updatedClaims, createdAt);
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

  for (const claim of updatedClaims) {
    const snapshotIdsChecked = claim.sourceSnapshotIds.slice().sort();
    const relatedConflicts = [...new Set(conflictIdsByClaimId.get(claim.id) ?? [])].sort();
    verification.push(createVerificationRecord(
      claim.id,
      "conflict-check",
      relatedConflicts.length > 0 ? "warn" : "pass",
      relatedConflicts.length > 0
        ? `middleware claim has ${relatedConflicts.length} naming conflict${relatedConflicts.length === 1 ? "" : "s"} to review`
        : "no middleware conflicts detected",
      snapshotIdsChecked,
      createdAt,
    ));
  }

  return {
    claims: updatedClaims.sort((left, right) => left.id.localeCompare(right.id)),
    verification: verification.sort((left, right) => left.id.localeCompare(right.id)),
    conflicts,
  };
}
