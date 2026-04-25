import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeMap, KnowledgeNote } from "../../../types.js";
import { makeHashedCodemapId } from "../../model/ids.js";
import type { Claim, ClaimStatus, ClaimType, EvidenceSpan, SourceSnapshot } from "../../model/types.js";
import { AI_RECORDED_TAG } from "../../notes/record-decision.js";
import { createSourceSnapshot } from "../../snapshot/snapshotter.js";
import { createSourcePathMatcher, type SourcePathFilterOptions } from "../code/source-path-filter.js";

const RECORDED_DECISION_SUPPORT_SCORE = 0.6;
const RECORDED_DECISION_PUBLICATION_CONFIDENCE = 0.5;
const RECORDED_CLAIM_TAG = "recorded" as const;

export interface KnowledgeClaimGraph {
  snapshots: SourceSnapshot[];
  evidence: EvidenceSpan[];
  claims: Claim[];
}

interface NoteContent {
  note: KnowledgeNote;
  content: string;
  snapshot: SourceSnapshot;
}

interface LocatedEvidence {
  startLine: number;
  endLine: number;
  excerpt: string;
  labels: string[];
}

function inferLanguageFromPath(path: string): string | undefined {
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".mdx")) return "mdx";
  return undefined;
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function hashExcerpt(excerpt: string): string {
  return createHash("sha256").update(excerpt).digest("hex");
}

function locateLineByMatchers(
  content: string,
  matchers: Array<{ text: string; inferred?: boolean }>,
  fallbackLabels: string[] = [],
): LocatedEvidence {
  const lines = content.split(/\r?\n/);

  for (const { text, inferred } of matchers) {
    const normalizedNeedle = normalizeForMatch(text);
    if (!normalizedNeedle) {
      continue;
    }

    for (const [index, line] of lines.entries()) {
      const normalizedLine = normalizeForMatch(line);
      if (!normalizedLine) {
        continue;
      }
      if (normalizedLine.includes(normalizedNeedle) || normalizedNeedle.includes(normalizedLine)) {
        return {
          startLine: index + 1,
          endLine: index + 1,
          excerpt: line.trim(),
          labels: unique([
            ...fallbackLabels,
            ...(inferred ? ["inferred"] : []),
          ]).sort(),
        };
      }
    }
  }

  const fallbackExcerpt = lines.slice(0, Math.min(lines.length, 4)).join("\n").trim() || content.slice(0, 200);
  return {
    startLine: 1,
    endLine: Math.max(Math.min(lines.length, 4), 1),
    excerpt: fallbackExcerpt,
    labels: unique([...fallbackLabels, "inferred", "file-level"]).sort(),
  };
}

function toKnowledgeTags(note: KnowledgeNote, claimType: ClaimType, extraTags: string[] = []): string[] {
  return unique([
    "knowledge",
    `claim:${claimType}`,
    `note-type:${note.type}`,
    ...note.tags,
    ...extraTags,
  ]).sort();
}

function createKnowledgeClaim(input: {
  note: KnowledgeNote;
  snapshot: SourceSnapshot;
  evidenceId: string;
  type: ClaimType;
  subject: string;
  text: string;
  status: ClaimStatus;
  supportScore: number;
  publicationConfidence: number;
  tags?: string[];
  firstSeenAt?: string;
}): Claim {
  return {
    id: makeHashedCodemapId("claim", [input.type, input.note.file, input.subject]),
    type: input.type,
    subject: input.subject,
    text: input.text,
    sourceSnapshotIds: [input.snapshot.id],
    evidenceSpanIds: [input.evidenceId],
    status: input.status,
    supportScore: input.supportScore,
    publicationConfidence: input.publicationConfidence,
    firstSeenAt: input.firstSeenAt ?? input.snapshot.createdAt,
    tags: unique(input.tags ?? []).sort(),
  };
}

function normalizeTheme(theme: string): string {
  return theme.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim();
}

function buildRecurringKnowledgeThemes(map: KnowledgeMap): string[] {
  const themes = new Set(map.recurringThemes.map(normalizeTheme).filter(Boolean));
  const tagCounts = new Map<string, number>();

  for (const note of map.notes) {
    for (const tag of note.tags.map(normalizeTheme).filter(Boolean)) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  for (const [tag, count] of tagCounts.entries()) {
    if (count > 1) {
      themes.add(tag);
    }
  }

  return [...themes].sort();
}

function extractRecurringThemesFromContent(note: KnowledgeNote, content: string, recurringThemes: string[]): string[] {
  const themes = new Set<string>();
  const normalizedTags = new Set(note.tags.map(normalizeTheme));
  const normalizedThemes = recurringThemes.map(normalizeTheme).filter(Boolean);

  for (const theme of normalizedThemes) {
    if (normalizedTags.has(theme)) {
      themes.add(theme);
      continue;
    }

    const headingMatcher = new RegExp(`^##\\s+${theme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "im");
    const tagMatcher = new RegExp(`(^|\\s)#${theme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|$)`, "i");
    if (headingMatcher.test(content) || tagMatcher.test(content)) {
      themes.add(theme);
    }
  }

  return [...themes].sort();
}

function createEvidenceEntry(
  snapshot: SourceSnapshot,
  located: LocatedEvidence,
  detectorMethod: EvidenceSpan["detectorMethod"],
  confidence: number,
  claimType: ClaimType,
): EvidenceSpan {
  const excerptHash = hashExcerpt(located.excerpt);
  return {
    id: makeHashedCodemapId("evidence", [
      snapshot.id,
      claimType,
      String(located.startLine),
      String(located.endLine),
      excerptHash,
    ]),
    snapshotId: snapshot.id,
    sourcePath: snapshot.sourcePath,
    startLine: located.startLine,
    endLine: located.endLine,
    excerptHash,
    detectorMethod,
    confidence,
    labels: unique(["knowledge", ...located.labels]).sort(),
  };
}

function buildDecisionClaims(
  noteContent: NoteContent,
  previousClaimsById: Map<string, Claim>,
): Array<{ claim: Claim; evidence: EvidenceSpan }> {
  const claims: Array<{ claim: Claim; evidence: EvidenceSpan }> = [];
  const isRecorded = noteContent.note.tags.includes(AI_RECORDED_TAG);
  const supportScore = isRecorded ? RECORDED_DECISION_SUPPORT_SCORE : 0.86;
  const publicationConfidence = isRecorded ? RECORDED_DECISION_PUBLICATION_CONFIDENCE : 0.8;
  const extraTags = isRecorded
    ? ["decision-record", RECORDED_CLAIM_TAG, AI_RECORDED_TAG]
    : ["decision-record"];

  for (const decision of noteContent.note.decisions) {
    const located = locateLineByMatchers(noteContent.content, [{ text: decision }], ["decision-record"]);
    const evidence = createEvidenceEntry(noteContent.snapshot, located, "heuristic", supportScore, "knowledge_decision");
    const claimId = makeHashedCodemapId("claim", ["knowledge_decision", noteContent.note.file, decision]);
    const previous = previousClaimsById.get(claimId);
    claims.push({
      evidence,
      claim: createKnowledgeClaim({
        note: noteContent.note,
        snapshot: noteContent.snapshot,
        evidenceId: evidence.id,
        type: "knowledge_decision",
        subject: decision,
        text: `Decision recorded in ${noteContent.note.file}: ${decision}`,
        status: "candidate",
        supportScore,
        publicationConfidence,
        tags: toKnowledgeTags(noteContent.note, "knowledge_decision", extraTags),
        firstSeenAt: previous?.firstSeenAt,
      }),
    });
  }

  return claims;
}

function buildQuestionClaims(
  noteContent: NoteContent,
  previousClaimsById: Map<string, Claim>,
): Array<{ claim: Claim; evidence: EvidenceSpan }> {
  const claims: Array<{ claim: Claim; evidence: EvidenceSpan }> = [];

  for (const question of noteContent.note.openQuestions) {
    const located = locateLineByMatchers(noteContent.content, [{ text: question }], ["open-question"]);
    const evidence = createEvidenceEntry(noteContent.snapshot, located, "heuristic", 0.82, "knowledge_question");
    const claimId = makeHashedCodemapId("claim", ["knowledge_question", noteContent.note.file, question]);
    const previous = previousClaimsById.get(claimId);
    claims.push({
      evidence,
      claim: createKnowledgeClaim({
        note: noteContent.note,
        snapshot: noteContent.snapshot,
        evidenceId: evidence.id,
        type: "knowledge_question",
        subject: question,
        text: `Open question recorded in ${noteContent.note.file}: ${question}`,
        status: "candidate",
        supportScore: 0.82,
        publicationConfidence: 0.76,
        tags: toKnowledgeTags(noteContent.note, "knowledge_question", ["open-question"]),
        firstSeenAt: previous?.firstSeenAt,
      }),
    });
  }

  return claims;
}

function buildPersonClaims(
  noteContent: NoteContent,
  previousClaimsById: Map<string, Claim>,
): Array<{ claim: Claim; evidence: EvidenceSpan }> {
  const claims: Array<{ claim: Claim; evidence: EvidenceSpan }> = [];

  for (const person of noteContent.note.people) {
    const located = locateLineByMatchers(noteContent.content, [
      { text: person },
      { text: `@${person}` },
      { text: `[[${person}]]` },
    ], ["person-mention"]);
    const evidence = createEvidenceEntry(noteContent.snapshot, located, "heuristic", 0.72, "knowledge_person");
    const claimId = makeHashedCodemapId("claim", ["knowledge_person", noteContent.note.file, person]);
    const previous = previousClaimsById.get(claimId);
    claims.push({
      evidence,
      claim: createKnowledgeClaim({
        note: noteContent.note,
        snapshot: noteContent.snapshot,
        evidenceId: evidence.id,
        type: "knowledge_person",
        subject: person,
        text: `${person} is mentioned in ${noteContent.note.file}.`,
        status: "candidate",
        supportScore: 0.72,
        publicationConfidence: 0.68,
        tags: toKnowledgeTags(noteContent.note, "knowledge_person", ["person"]),
        firstSeenAt: previous?.firstSeenAt,
      }),
    });
  }

  return claims;
}

function buildThemeClaims(
  noteContent: NoteContent,
  recurringThemes: string[],
  previousClaimsById: Map<string, Claim>,
): Array<{ claim: Claim; evidence: EvidenceSpan }> {
  const claims: Array<{ claim: Claim; evidence: EvidenceSpan }> = [];
  const noteThemes = extractRecurringThemesFromContent(noteContent.note, noteContent.content, recurringThemes);

  for (const theme of noteThemes) {
    const located = locateLineByMatchers(noteContent.content, [
      { text: `## ${theme}`, inferred: true },
      { text: `#${theme}`, inferred: true },
      { text: theme, inferred: true },
    ], ["theme", "inferred"]);
    const evidence = createEvidenceEntry(noteContent.snapshot, located, "heuristic", 0.6, "knowledge_theme");
    const claimId = makeHashedCodemapId("claim", ["knowledge_theme", noteContent.note.file, theme]);
    const previous = previousClaimsById.get(claimId);
    claims.push({
      evidence,
      claim: createKnowledgeClaim({
        note: noteContent.note,
        snapshot: noteContent.snapshot,
        evidenceId: evidence.id,
        type: "knowledge_theme",
        subject: theme,
        text: `Theme "${theme}" recurs in ${noteContent.note.file}.`,
        status: "inferred",
        supportScore: 0.6,
        publicationConfidence: 0.56,
        tags: toKnowledgeTags(noteContent.note, "knowledge_theme", ["theme", "inferred"]),
        firstSeenAt: previous?.firstSeenAt,
      }),
    });
  }

  return claims;
}

function buildSummaryClaim(
  noteContent: NoteContent,
  previousClaimsById: Map<string, Claim>,
): Array<{ claim: Claim; evidence: EvidenceSpan }> {
  if (!noteContent.note.summary) {
    return [];
  }

  const located = locateLineByMatchers(noteContent.content, [{ text: noteContent.note.summary, inferred: true }], [
    "summary",
    "inferred",
  ]);
  const evidence = createEvidenceEntry(noteContent.snapshot, located, "heuristic", 0.58, "knowledge_summary");
  const claimId = makeHashedCodemapId("claim", ["knowledge_summary", noteContent.note.file]);
  const previous = previousClaimsById.get(claimId);

  return [{
    evidence,
    claim: createKnowledgeClaim({
      note: noteContent.note,
      snapshot: noteContent.snapshot,
      evidenceId: evidence.id,
      type: "knowledge_summary",
      subject: noteContent.note.file,
      text: noteContent.note.summary,
      status: "inferred",
      supportScore: 0.58,
      publicationConfidence: 0.54,
      tags: toKnowledgeTags(noteContent.note, "knowledge_summary", ["summary", "inferred"]),
      firstSeenAt: previous?.firstSeenAt,
    }),
  }];
}

export async function extractKnowledgeClaimGraph(
  repoRoot: string,
  map: KnowledgeMap,
  previousClaims: Claim[] = [],
  options: SourcePathFilterOptions = {},
): Promise<KnowledgeClaimGraph> {
  const matchesSourcePath = createSourcePathMatcher(options.sourcePaths);
  const previousClaimsById = new Map(previousClaims.map((claim) => [claim.id, claim]));
  const recurringThemes = buildRecurringKnowledgeThemes(map);
  const notes = map.notes.filter((note) => matchesSourcePath(note.file));
  const noteContents: NoteContent[] = [];

  for (const note of notes) {
    const absolutePath = join(repoRoot, note.file);
    const content = await readFile(absolutePath, "utf-8");
    const snapshot = await createSourceSnapshot({
      repoRoot,
      absolutePath,
      sourceKind: "note",
      content,
      language: inferLanguageFromPath(note.file),
    });
    noteContents.push({
      note,
      content,
      snapshot,
    });
  }

  const evidence: EvidenceSpan[] = [];
  const claims: Claim[] = [];

  for (const noteContent of noteContents) {
    const entries = [
      ...buildDecisionClaims(noteContent, previousClaimsById),
      ...buildQuestionClaims(noteContent, previousClaimsById),
      ...buildPersonClaims(noteContent, previousClaimsById),
      ...buildThemeClaims(noteContent, recurringThemes, previousClaimsById),
      ...buildSummaryClaim(noteContent, previousClaimsById),
    ];

    for (const entry of entries) {
      evidence.push(entry.evidence);
      claims.push(entry.claim);
    }
  }

  return {
    snapshots: noteContents.map((noteContent) => noteContent.snapshot).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)),
    evidence: evidence.sort((a, b) => a.id.localeCompare(b.id)),
    claims: claims.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
