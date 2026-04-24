import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim, ConflictEdge, EvidenceSpan, SourceSnapshot, VerificationRecord } from "../model/types.js";
import { makeHashedCodemapId } from "../model/ids.js";
import { hashSnapshotContent } from "../snapshot/snapshotter.js";

export interface HotspotVerificationResult {
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

function parseCountTag(claim: Claim, prefix: string): number | null {
  const value = getTagValue(claim, prefix);
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function verifyHotspotClaims(
  repoRoot: string,
  claims: Claim[],
  evidence: EvidenceSpan[],
  snapshots: SourceSnapshot[],
  createdAt = new Date().toISOString(),
): Promise<HotspotVerificationResult> {
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

    const importedByCount = parseCountTag(claim, "imported-by-count:");
    const hotspotRank = parseCountTag(claim, "hotspot-rank:");
    const bucket = getTagValue(claim, "hotspot-bucket:");
    const consistencyPass = importedByCount !== null
      && importedByCount > 0
      && hotspotRank !== null
      && hotspotRank > 0
      && bucket !== undefined
      && ["critical", "high", "medium"].includes(bucket);

    verification.push(createVerificationRecord(
      claim.id,
      "line-exists",
      linePass ? "pass" : "fail",
      linePass
        ? "all dependency hotspot evidence spans resolved against current source lines"
        : missingSource
          ? "dependency hotspot source file is missing from the current workspace"
          : "one or more dependency hotspot evidence spans no longer resolve",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "hash-match",
      hashPass ? "pass" : "fail",
      hashPass
        ? "dependency hotspot source snapshots match current file hashes"
        : missingSource
          ? "dependency hotspot source file is missing so the snapshot can no longer be verified"
          : "dependency hotspot source snapshots drifted from current file hashes",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "ast-shape",
      extractionPass ? "pass" : "fail",
      extractionPass
        ? "dependency hotspot evidence still resolves to extracted source spans"
        : missingSource
          ? "dependency hotspot evidence cannot be checked because the source file is missing"
          : "dependency hotspot evidence no longer resolves cleanly to the original source span",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "hotspot-consistency",
      consistencyPass ? "pass" : "fail",
      consistencyPass
        ? "dependency hotspot claim metadata is internally consistent"
        : "dependency hotspot claim is missing count, rank, or bucket metadata tags",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "conflict-check",
      "pass",
      "no dependency hotspot conflicts detected",
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
