import type { Claim, ConflictEdge, RenderedView, SourceSnapshot } from "../../model/types.js";

function renderFrontmatter(
  title: string,
  generatedAt: string,
  claims: Claim[],
  snapshots: SourceSnapshot[],
  conflicts: ConflictEdge[],
  viewType: string,
): string {
  const verifiedCount = claims.filter((claim) => claim.status === "verified").length;
  const inferredCount = claims.filter((claim) => claim.status === "inferred").length;
  const staleCount = claims.filter((claim) => claim.status === "stale").length;

  return [
    "---",
    `title: ${title}`,
    `view_type: ${viewType}`,
    `generated_at: ${generatedAt}`,
    `claim_count: ${claims.length}`,
    `verified_claim_count: ${verifiedCount}`,
    `inferred_claim_count: ${inferredCount}`,
    `stale_claim_count: ${staleCount}`,
    `conflict_count: ${conflicts.length}`,
    `source_snapshot_count: ${snapshots.length}`,
    "---",
    "",
  ].join("\n");
}

function renderClaimRefComment(claims: Claim[]): string {
  return `<!-- claim_ids: ${claims.map((claim) => claim.id).join(", ")} -->`;
}

function getPrimarySourcePath(claim: Claim, snapshotsById: Map<string, SourceSnapshot>): string {
  for (const snapshotId of claim.sourceSnapshotIds) {
    const snapshot = snapshotsById.get(snapshotId);
    if (snapshot?.sourcePath) {
      return snapshot.sourcePath;
    }
  }
  return "unknown";
}

function toSummaryLine(claim: Claim, snapshotsById: Map<string, SourceSnapshot>): string {
  const prefix = claim.tags.includes("recorded") ? "[recorded] " : "";
  return `- ${prefix}\`${claim.subject}\` [${claim.status}] — ${claim.text} (\`${getPrimarySourcePath(claim, snapshotsById)}\`)`;
}

function isKnowledgeClaimType(type: Claim["type"]): boolean {
  return type.startsWith("knowledge_");
}

function renderConflictLines(conflicts: ConflictEdge[], claims: Claim[]): string[] {
  if (conflicts.length === 0) {
    return [];
  }

  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const relevantConflicts = conflicts.filter((conflict) => {
    const claimA = claimById.get(conflict.claimA);
    const claimB = claimById.get(conflict.claimB);
    return Boolean(claimA && claimB);
  });

  if (relevantConflicts.length === 0) {
    return [];
  }

  const lines = ["## Conflicts", ""];
  for (const conflict of relevantConflicts.sort((left, right) => left.id.localeCompare(right.id))) {
    const claimA = claimById.get(conflict.claimA);
    const claimB = claimById.get(conflict.claimB);
    const leftSubject = claimA?.subject ?? conflict.claimA;
    const rightSubject = claimB?.subject ?? conflict.claimB;
    lines.push(`- [${conflict.severity}] ${conflict.relation}: \`${leftSubject}\` vs \`${rightSubject}\` — ${conflict.rationale}`);
  }
  lines.push("");
  return lines;
}

export function renderKnowledgeViews(
  claims: Claim[],
  snapshots: SourceSnapshot[],
  conflicts: ConflictEdge[],
  generatedAt: string,
): RenderedView[] {
  const knowledgeClaims = claims
    .filter((claim) => isKnowledgeClaimType(claim.type))
    .sort((left, right) => left.subject.localeCompare(right.subject) || left.id.localeCompare(right.id));
  const knowledgeSnapshots = snapshots
    .filter((snapshot) => snapshot.sourceKind === "note")
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const snapshotsById = new Map(knowledgeSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const knowledgeConflicts = conflicts.filter((conflict) => {
    const claimIds = new Set(knowledgeClaims.map((claim) => claim.id));
    return claimIds.has(conflict.claimA) && claimIds.has(conflict.claimB);
  });

  const decisionClaims = knowledgeClaims.filter((claim) => claim.type === "knowledge_decision");
  const questionClaims = knowledgeClaims.filter((claim) => claim.type === "knowledge_question");
  const personClaims = knowledgeClaims.filter((claim) => claim.type === "knowledge_person");
  const themeClaims = knowledgeClaims.filter((claim) => claim.type === "knowledge_theme");
  const summaryClaims = knowledgeClaims.filter((claim) => claim.type === "knowledge_summary");
  const staleClaims = knowledgeClaims.filter((claim) => claim.status === "stale" || claim.status === "quarantined");

  const indexLines = [
    renderFrontmatter("Knowledge Index", generatedAt, knowledgeClaims, knowledgeSnapshots, knowledgeConflicts, "knowledge_index"),
    "# Knowledge",
    "",
    renderClaimRefComment(knowledgeClaims),
    "",
    "- [Overview](./overview.md)",
    "",
    `Decisions: ${decisionClaims.length} claim${decisionClaims.length === 1 ? "" : "s"}.`,
    `Open Questions: ${questionClaims.length} claim${questionClaims.length === 1 ? "" : "s"}.`,
    `People: ${personClaims.length} claim${personClaims.length === 1 ? "" : "s"}.`,
    `Themes: ${themeClaims.length} claim${themeClaims.length === 1 ? "" : "s"}.`,
    `Summaries: ${summaryClaims.length} claim${summaryClaims.length === 1 ? "" : "s"}.`,
    knowledgeConflicts.length > 0
      ? `Conflicts: ${knowledgeConflicts.length} knowledge conflicts require review.`
      : "Conflicts: none detected in the current knowledge shadow pipeline.",
    "",
  ];

  const overviewLines = [
    renderFrontmatter("Knowledge Overview", generatedAt, knowledgeClaims, knowledgeSnapshots, knowledgeConflicts, "knowledge_overview"),
    "# Knowledge Overview",
    "",
    renderClaimRefComment(knowledgeClaims),
    "",
    `This view is derived from ${knowledgeClaims.length} canonical knowledge claims backed by ${knowledgeSnapshots.length} note snapshots.`,
    "",
  ];

  if (decisionClaims.length > 0) {
    overviewLines.push("## Decisions");
    overviewLines.push(renderClaimRefComment(decisionClaims));
    overviewLines.push("");
    for (const claim of decisionClaims) {
      overviewLines.push(toSummaryLine(claim, snapshotsById));
    }
    overviewLines.push("");
  }

  if (questionClaims.length > 0) {
    overviewLines.push("## Open Questions");
    overviewLines.push(renderClaimRefComment(questionClaims));
    overviewLines.push("");
    for (const claim of questionClaims) {
      overviewLines.push(toSummaryLine(claim, snapshotsById));
    }
    overviewLines.push("");
  }

  if (personClaims.length > 0) {
    overviewLines.push("## People");
    overviewLines.push(renderClaimRefComment(personClaims));
    overviewLines.push("");
    for (const claim of personClaims) {
      overviewLines.push(toSummaryLine(claim, snapshotsById));
    }
    overviewLines.push("");
  }

  if (themeClaims.length > 0) {
    overviewLines.push("## Themes");
    overviewLines.push(renderClaimRefComment(themeClaims));
    overviewLines.push("");
    for (const claim of themeClaims) {
      overviewLines.push(toSummaryLine(claim, snapshotsById));
    }
    overviewLines.push("");
  }

  if (summaryClaims.length > 0) {
    overviewLines.push("## Note Summaries");
    overviewLines.push(renderClaimRefComment(summaryClaims));
    overviewLines.push("");
    for (const claim of summaryClaims) {
      overviewLines.push(toSummaryLine(claim, snapshotsById));
    }
    overviewLines.push("");
  }

  overviewLines.push(...renderConflictLines(knowledgeConflicts, knowledgeClaims));

  if (staleClaims.length > 0) {
    overviewLines.push("## Stale Claims");
    overviewLines.push(renderClaimRefComment(staleClaims));
    overviewLines.push("");
    for (const claim of staleClaims) {
      overviewLines.push(toSummaryLine(claim, snapshotsById));
    }
    overviewLines.push("");
  }

  return [
    {
      path: ".codemap/views/knowledge/index.md",
      title: "Knowledge",
      markdown: indexLines.join("\n"),
      claimIds: knowledgeClaims.map((claim) => claim.id),
    },
    {
      path: ".codemap/views/knowledge/overview.md",
      title: "Knowledge Overview",
      markdown: overviewLines.join("\n"),
      claimIds: knowledgeClaims.map((claim) => claim.id),
    },
  ];
}
