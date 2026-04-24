import type { Claim, ConflictEdge, RenderedView, SourceSnapshot } from "../../model/types.js";

function isKnowledgeClaimType(type: Claim["type"]): boolean {
  return type.startsWith("knowledge_");
}

function renderClaimStatus(claim: Claim): string {
  return claim.status === "verified" ? "" : ` [${claim.status}]`;
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

function sortKnowledgeClaims(claims: Claim[]): Claim[] {
  return [...claims].sort((left, right) =>
    (right.lastVerifiedAt ?? right.firstSeenAt).localeCompare(left.lastVerifiedAt ?? left.firstSeenAt)
    || left.subject.localeCompare(right.subject)
    || left.id.localeCompare(right.id),
  );
}

function renderConflictLines(conflicts: ConflictEdge[], claims: Claim[]): string[] {
  if (conflicts.length === 0) {
    return [];
  }

  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const relevantConflicts = conflicts.filter((conflict) =>
    claimById.has(conflict.claimA) && claimById.has(conflict.claimB),
  );

  if (relevantConflicts.length === 0) {
    return [];
  }

  return [
    `## Conflicts (${relevantConflicts.length})`,
    ...relevantConflicts.map((conflict) => {
      const left = claimById.get(conflict.claimA)?.subject ?? conflict.claimA;
      const right = claimById.get(conflict.claimB)?.subject ?? conflict.claimB;
      return `- [${conflict.severity}] ${left} <> ${right} — ${conflict.rationale}`;
    }),
    "",
  ];
}

export function renderCompatibilityKnowledge(params: {
  projectName: string;
  claims: Claim[];
  conflicts: ConflictEdge[];
  snapshots: SourceSnapshot[];
  generatedAt: string;
}): RenderedView[] {
  const knowledgeClaims = sortKnowledgeClaims(params.claims.filter((claim) => isKnowledgeClaimType(claim.type)));
  const knowledgeSnapshots = params.snapshots
    .filter((snapshot) => snapshot.sourceKind === "note")
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  const snapshotsById = new Map(knowledgeSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const knowledgeConflicts = params.conflicts.filter((conflict) => {
    const claimIds = new Set(knowledgeClaims.map((claim) => claim.id));
    return claimIds.has(conflict.claimA) && claimIds.has(conflict.claimB);
  });

  const decisions = knowledgeClaims.filter((claim) => claim.type === "knowledge_decision");
  const openQuestions = knowledgeClaims.filter((claim) => claim.type === "knowledge_question");
  const themes = knowledgeClaims.filter((claim) => claim.type === "knowledge_theme");
  const people = knowledgeClaims.filter((claim) => claim.type === "knowledge_person");
  const summaries = knowledgeClaims.filter((claim) => claim.type === "knowledge_summary");
  const staleClaims = knowledgeClaims.filter((claim) => claim.status === "stale" || claim.status === "quarantined");
  const topThemes = themes.slice(0, 4).map((claim) => claim.subject).join(", ");
  const topDecision = decisions[0]?.subject;

  const primerParts = [
    `This knowledge base has ${knowledgeClaims.length} canonical knowledge claims backed by ${knowledgeSnapshots.length} note snapshots.`,
    topThemes ? `Key topics: ${topThemes}.` : "",
    topDecision ? `Most recent decision: ${topDecision}.` : "",
    openQuestions.length > 0 ? `${openQuestions.length} open question${openQuestions.length === 1 ? "" : "s"} remain.` : "",
  ].filter(Boolean);

  const lines: string[] = [
    `# Knowledge Map — ${params.projectName}`,
    `> ${knowledgeSnapshots.length} notes · ${decisions.length} decisions · ${openQuestions.length} open questions · generated ${params.generatedAt}`,
    "",
    `> **AI Primer:** ${primerParts.join(" ") || "No canonical knowledge claims found yet."}`,
    "",
  ];

  if (decisions.length > 0) {
    lines.push(`## Key Decisions (${decisions.length})`);
    for (const claim of decisions) {
      lines.push(`- ${claim.subject}${renderClaimStatus(claim)}`);
    }
    lines.push("");
  }

  if (openQuestions.length > 0) {
    lines.push(`## Open Questions (${openQuestions.length})`);
    for (const claim of openQuestions) {
      lines.push(`- ${claim.subject}${renderClaimStatus(claim)}`);
    }
    lines.push("");
  }

  if (themes.length > 0) {
    lines.push("## Recurring Themes");
    lines.push(themes.map((claim) => `${claim.subject}${renderClaimStatus(claim)}`).join(" · "));
    lines.push("");
  }

  if (people.length > 0) {
    lines.push("## People");
    lines.push(people.map((claim) => `${claim.subject}${renderClaimStatus(claim)}`).join(" · "));
    lines.push("");
  }

  if (summaries.length > 0) {
    lines.push(`## Note Index (${summaries.length})`);
    for (const claim of summaries.sort((left, right) => left.subject.localeCompare(right.subject))) {
      lines.push(`- \`${claim.subject}\`${renderClaimStatus(claim)} — ${claim.text}`);
    }
    lines.push("");
  }

  lines.push(...renderConflictLines(knowledgeConflicts, knowledgeClaims));

  if (staleClaims.length > 0) {
    lines.push("## Stale Claims");
    for (const claim of staleClaims) {
      lines.push(`- \`${getPrimarySourcePath(claim, snapshotsById)}\` — ${claim.subject} [${claim.status}]`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("_Derived from canonical CodeMap knowledge claims; markdown here is a compatibility view, not the source of truth._");

  return [{
    path: ".codemap/compatibility/KNOWLEDGE.md",
    title: "Knowledge Map",
    markdown: lines.join("\n"),
    claimIds: knowledgeClaims.map((claim) => claim.id),
  }];
}
