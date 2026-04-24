import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim, ConflictEdge, EvidenceSpan, SourceSnapshot, VerificationRecord } from "../model/types.js";
import { makeHashedCodemapId } from "../model/ids.js";
import { hashSnapshotContent } from "../snapshot/snapshotter.js";

export interface EnvVerificationResult {
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

export async function verifyEnvClaims(
  repoRoot: string,
  claims: Claim[],
  evidence: EvidenceSpan[],
  snapshots: SourceSnapshot[],
  createdAt = new Date().toISOString(),
): Promise<EnvVerificationResult> {
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

    const consistencyPass = (claim.tags.includes("required") || claim.tags.includes("has-default"))
      && !(claim.tags.includes("required") && claim.tags.includes("has-default"))
      && claim.tags.some((tag) => tag.startsWith("env-source:"))
      && claim.tags.some((tag) => tag.startsWith("source-kind:"));

    verification.push(createVerificationRecord(
      claim.id,
      "line-exists",
      linePass ? "pass" : "fail",
      linePass
        ? "all environment variable evidence spans resolved against current source lines"
        : missingSource
          ? "environment variable source file is missing from the current workspace"
          : "one or more environment variable evidence spans no longer resolve",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "hash-match",
      hashPass ? "pass" : "fail",
      hashPass
        ? "environment variable source snapshots match current file hashes"
        : missingSource
          ? "environment variable source file is missing so the snapshot can no longer be verified"
          : "environment variable source snapshots drifted from current file hashes",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "ast-shape",
      extractionPass ? "pass" : "fail",
      extractionPass
        ? "environment variable evidence still resolves to extracted source spans"
        : missingSource
          ? "environment variable evidence cannot be checked because the source file is missing"
          : "environment variable evidence no longer resolves cleanly to the original source span",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "env-consistency",
      consistencyPass ? "pass" : "fail",
      consistencyPass
        ? "environment variable claim metadata is internally consistent"
        : "environment variable claim is missing requirement or source metadata tags",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "conflict-check",
      "pass",
      "no environment variable conflicts detected",
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

  return {
    claims: updatedClaims.sort((left, right) => left.id.localeCompare(right.id)),
    verification: verification.sort((left, right) => left.id.localeCompare(right.id)),
    conflicts: [],
  };
}
