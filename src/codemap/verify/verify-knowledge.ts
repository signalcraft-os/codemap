import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim, ConflictEdge, EvidenceSpan, SourceSnapshot, VerificationRecord } from "../model/types.js";
import { makeHashedCodemapId } from "../model/ids.js";
import { hashSnapshotContent } from "../snapshot/snapshotter.js";

export interface KnowledgeVerificationResult {
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

function createConflict(
  claimA: string,
  claimB: string,
  severity: ConflictEdge["severity"],
  rationale: string,
  createdAt: string,
): ConflictEdge {
  const orderedClaimIds = [claimA, claimB].sort();
  return {
    id: makeHashedCodemapId("conflict", ["duplicates", severity, rationale, ...orderedClaimIds]),
    claimA: orderedClaimIds[0],
    claimB: orderedClaimIds[1],
    relation: "duplicates",
    severity,
    createdAt,
    rationale,
  };
}

function hashExcerpt(excerpt: string): string {
  return createHash("sha256").update(excerpt).digest("hex");
}

function normalizeSubject(subject: string): string {
  return subject.toLowerCase().replace(/\s+/g, " ").trim();
}

function isInferredKnowledgeClaim(claim: Claim): boolean {
  return claim.type === "knowledge_theme" || claim.type === "knowledge_summary" || claim.tags.includes("inferred");
}

function buildKnowledgeConflicts(claims: Claim[], createdAt: string): ConflictEdge[] {
  const duplicateTypes = new Set<Claim["type"]>(["knowledge_decision", "knowledge_question"]);
  const grouped = new Map<string, Claim[]>();

  for (const claim of claims) {
    if (!duplicateTypes.has(claim.type)) {
      continue;
    }

    const key = `${claim.type}:${normalizeSubject(claim.subject)}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(claim);
  }

  const conflicts: ConflictEdge[] = [];

  for (const group of grouped.values()) {
    const uniqueClaims = [...new Map(group.map((claim) => [claim.id, claim])).values()]
      .sort((left, right) => left.id.localeCompare(right.id));
    if (uniqueClaims.length < 2) {
      continue;
    }

    const rationale = uniqueClaims[0].type === "knowledge_decision"
      ? "multiple notes record the same decision subject"
      : "multiple notes repeat the same open question";

    for (let index = 0; index < uniqueClaims.length - 1; index += 1) {
      conflicts.push(createConflict(
        uniqueClaims[index].id,
        uniqueClaims[index + 1].id,
        "low",
        rationale,
        createdAt,
      ));
    }
  }

  return conflicts.sort((left, right) => left.id.localeCompare(right.id));
}

export async function verifyKnowledgeClaims(
  repoRoot: string,
  claims: Claim[],
  evidence: EvidenceSpan[],
  snapshots: SourceSnapshot[],
  createdAt = new Date().toISOString(),
): Promise<KnowledgeVerificationResult> {
  const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const conflicts = buildKnowledgeConflicts(claims, createdAt);
  const conflictingClaimIds = new Set(conflicts.flatMap((conflict) => [conflict.claimA, conflict.claimB]));
  const verification: VerificationRecord[] = [];
  const updatedClaims: Claim[] = [];

  for (const claim of claims) {
    const claimEvidence = claim.evidenceSpanIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((entry): entry is EvidenceSpan => Boolean(entry));
    const snapshotIdsChecked = claim.sourceSnapshotIds.slice().sort();

    let linePass = claimEvidence.length > 0;
    let hashPass = claimEvidence.length > 0;
    let supportPass = claimEvidence.length > 0;
    let supportWarn = isInferredKnowledgeClaim(claim);

    if (claimEvidence.length === 0) {
      verification.push(createVerificationRecord(
        claim.id,
        "line-exists",
        "fail",
        "knowledge claim has no evidence spans",
        snapshotIdsChecked,
        createdAt,
      ));
      verification.push(createVerificationRecord(
        claim.id,
        "hash-match",
        "fail",
        "knowledge claim has no source snapshots to verify",
        snapshotIdsChecked,
        createdAt,
      ));
      verification.push(createVerificationRecord(
        claim.id,
        "knowledge-support",
        "fail",
        "knowledge claim has no note-backed evidence span",
        snapshotIdsChecked,
        createdAt,
      ));
      verification.push(createVerificationRecord(
        claim.id,
        "conflict-check",
        "pass",
        "no knowledge conflicts detected for this claim",
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
        supportPass = false;
        continue;
      }

      const absolutePath = join(repoRoot, snapshot.sourcePath);
      try {
        const content = await readFile(absolutePath, "utf-8");
        const lines = content.split(/\r?\n/);
        const evidenceLines = lines.slice(evidenceEntry.startLine - 1, evidenceEntry.endLine);
        if (evidenceEntry.startLine < 1 || evidenceEntry.endLine < evidenceEntry.startLine || evidenceLines.length === 0) {
          linePass = false;
          supportPass = false;
        } else {
          const currentExcerptHash = hashExcerpt(evidenceLines.join("\n").trim());
          if (currentExcerptHash !== evidenceEntry.excerptHash) {
            supportPass = false;
          }
        }

        if (hashSnapshotContent(content) !== snapshot.contentHash) {
          hashPass = false;
        }

        if (evidenceEntry.labels.includes("file-level") || evidenceEntry.labels.includes("inferred")) {
          supportWarn = true;
        }
      } catch {
        linePass = false;
        hashPass = false;
        supportPass = false;
      }
    }

    verification.push(createVerificationRecord(
      claim.id,
      "line-exists",
      linePass ? "pass" : "fail",
      linePass
        ? "knowledge evidence spans resolved against current note lines"
        : "one or more knowledge evidence spans no longer resolve against the note",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "hash-match",
      hashPass ? "pass" : "fail",
      hashPass
        ? "knowledge note snapshots match current file hashes"
        : "knowledge note snapshots drifted from current file hashes",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "knowledge-support",
      supportPass ? (supportWarn ? "warn" : "pass") : "fail",
      supportPass
        ? supportWarn
          ? "knowledge claim remains heuristically supported by note evidence"
          : "knowledge claim is directly supported by note evidence"
        : "knowledge evidence no longer supports the extracted claim text",
      snapshotIdsChecked,
      createdAt,
    ));
    verification.push(createVerificationRecord(
      claim.id,
      "conflict-check",
      conflictingClaimIds.has(claim.id) ? "warn" : "pass",
      conflictingClaimIds.has(claim.id)
        ? "knowledge claim duplicates another note-backed claim and should be reviewed together"
        : "no knowledge conflicts detected for this claim",
      snapshotIdsChecked,
      createdAt,
    ));

    const nextStatus = !linePass || !hashPass || !supportPass
      ? "stale"
      : isInferredKnowledgeClaim(claim)
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
