import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim, ConflictEdge, EvidenceSpan, SourceSnapshot, VerificationRecord } from "../model/types.js";
import { makeHashedCodemapId } from "../model/ids.js";
import { hashSnapshotContent } from "../snapshot/snapshotter.js";

export interface SchemaVerificationResult {
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

function getTagValues(claim: Claim, prefix: string): string[] {
  return claim.tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .filter((value) => value.length > 0)
    .sort();
}

function normalizeSubject(value: string): string {
  return value.trim().toLowerCase();
}

function areClaimsEquivalent(left: Claim, right: Claim): boolean {
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "model") {
    return parseCountTag(left, "field-count:") === parseCountTag(right, "field-count:")
      && parseCountTag(left, "relation-count:") === parseCountTag(right, "relation-count:")
      && getTagValue(left, "orm:") === getTagValue(right, "orm:");
  }

  if (left.type === "relation") {
    return getTagValue(left, "orm:") === getTagValue(right, "orm:")
      && getTagValue(left, "model:") === getTagValue(right, "model:")
      && getTagValues(left, "relation-target:").join("|") === getTagValues(right, "relation-target:").join("|");
  }

  return left.text === right.text;
}

function detectSchemaConflicts(claims: Claim[], createdAt: string): ConflictEdge[] {
  const groups = new Map<string, Claim[]>();

  for (const claim of claims.filter((candidate) => candidate.type === "model" || candidate.type === "relation")) {
    const key = `${claim.type}:${claim.subject.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(claim);
  }

  const conflicts: ConflictEdge[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const sorted = [...group].sort((left, right) => left.id.localeCompare(right.id));
    for (let index = 0; index < sorted.length; index++) {
      for (let compareIndex = index + 1; compareIndex < sorted.length; compareIndex++) {
        const claimA = sorted[index];
        const claimB = sorted[compareIndex];
        const equivalent = areClaimsEquivalent(claimA, claimB);
        conflicts.push({
          id: makeHashedCodemapId("conflict", [claimA.id, claimB.id, equivalent ? "duplicates" : "conflicts"]),
          claimA: claimA.id,
          claimB: claimB.id,
          relation: equivalent ? "duplicates" : "conflicts",
          severity: equivalent ? "low" : "medium",
          createdAt,
          rationale: equivalent
            ? `${claimA.type} claims share the same subject and appear to describe the same schema fact.`
            : `${claimA.type} claims share the same subject but disagree on schema details and should be reviewed.`,
        });
      }
    }
  }

  return conflicts.sort((left, right) => left.id.localeCompare(right.id));
}

export async function verifySchemaClaims(
  repoRoot: string,
  claims: Claim[],
  evidence: EvidenceSpan[],
  snapshots: SourceSnapshot[],
  createdAt = new Date().toISOString()
): Promise<SchemaVerificationResult> {
  const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const conflicts = detectSchemaConflicts(claims, createdAt);
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

  const verification: VerificationRecord[] = [];
  const updatedClaims: Claim[] = [];
  const modelSubjects = new Set(claims.filter((claim) => claim.type === "model").map((claim) => claim.subject));
  const normalizedModelSubjects = new Set([...modelSubjects].map((subject) => normalizeSubject(subject)));

  for (const claim of claims) {
    const claimEvidence = claim.evidenceSpanIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((entry): entry is EvidenceSpan => Boolean(entry));
    const snapshotIdsChecked = claim.sourceSnapshotIds.slice().sort();
    const claimConflicts = conflictsByClaimId.get(claim.id) ?? [];

    let linePass = claimEvidence.length > 0;
    let hashPass = claimEvidence.length > 0;
    let missingSource = false;
    let extractionPass = claimEvidence.length > 0;

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

    const fieldCount = parseCountTag(claim, "field-count:");
    const relationCount = parseCountTag(claim, "relation-count:");
    const relationModel = getTagValue(claim, "model:");
    const relationTargets = getTagValues(claim, "relation-target:");
    const relationTargetsResolved = relationTargets.length === 0
      || relationTargets.some((target) => normalizedModelSubjects.has(normalizeSubject(target)));

    const consistencyPass = claim.type === "model"
      ? fieldCount !== null && relationCount !== null && fieldCount + relationCount >= 0
      : claim.type === "relation"
        ? Boolean(relationModel)
          && modelSubjects.has(relationModel!)
          && relationTargetsResolved
        : true;

    verification.push(createVerificationRecord(
      claim.id,
      "line-exists",
      linePass ? "pass" : "fail",
      linePass
        ? "all schema evidence spans resolved against current source lines"
        : missingSource
          ? "schema source file is missing from the current workspace"
          : "one or more schema evidence spans no longer resolve",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "hash-match",
      hashPass ? "pass" : "fail",
      hashPass
        ? "schema source snapshots match current file hashes"
        : missingSource
          ? "schema source file is missing so the snapshot can no longer be verified"
          : "schema source snapshots drifted from current file hashes",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "ast-shape",
      extractionPass ? "pass" : "fail",
      extractionPass
        ? "schema evidence still resolves to extracted source spans"
        : missingSource
          ? "schema evidence cannot be checked because the source file is missing"
          : "schema evidence no longer resolves cleanly to the original source span",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "schema-consistency",
      consistencyPass ? "pass" : "fail",
      consistencyPass
        ? "schema claim metadata is internally consistent"
        : claim.type === "relation"
          ? !relationModel || !modelSubjects.has(relationModel)
            ? "relation claim is missing a matching parent model claim"
            : "relation claim points at a target model that is not present in the current schema graph"
          : "schema claim is missing model metadata tags",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "conflict-check",
      claimConflicts.length > 0 ? "warn" : "pass",
      claimConflicts.length > 0
        ? `${claimConflicts.length} schema conflicts require review`
        : "no schema conflicts detected",
      snapshotIdsChecked,
      createdAt,
    ));

    const nextStatus = !linePass || !hashPass
      ? "stale"
      : !consistencyPass
        ? "quarantined"
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
    claims: updatedClaims.sort((left, right) => left.id.localeCompare(right.id)),
    verification: verification.sort((left, right) => left.id.localeCompare(right.id)),
    conflicts,
  };
}
