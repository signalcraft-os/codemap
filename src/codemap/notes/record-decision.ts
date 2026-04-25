import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const RECORDED_DECISIONS_DIR = "notes/decisions/recorded" as const;
export const AI_RECORDED_TAG = "ai-recorded" as const;

export interface RecordDecisionInput {
  repoRoot: string;
  subject: string;
  decision: string;
  rationale?: string;
  relatedSourcePaths?: string[];
  supersedes?: string[];
  recordedAt?: string;
}

export interface RecordDecisionResult {
  absolutePath: string;
  relativePath: string;
  recordedAt: string;
  filename: string;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    || "decision";
}

function timestampForFilename(iso: string): string {
  return iso.replace(/[:.]/g, "");
}

function renderFrontmatter(input: RecordDecisionInput, recordedAt: string): string {
  const lines = ["---", `recorded_at: ${recordedAt}`, "recorded_by: ai-session"];
  lines.push(`tags: [${AI_RECORDED_TAG}]`);
  lines.push(`title: ${input.subject.replace(/[\r\n]+/g, " ").trim()}`);
  if (input.supersedes && input.supersedes.length > 0) {
    lines.push("supersedes:");
    for (const prior of input.supersedes) {
      lines.push(`  - ${prior.replace(/[\r\n]+/g, " ").trim()}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function renderBody(input: RecordDecisionInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.subject.replace(/[\r\n]+/g, " ").trim()}`, "");
  lines.push("## Decision", "", input.decision.trim(), "");
  if (input.rationale && input.rationale.trim().length > 0) {
    lines.push("## Rationale", "", input.rationale.trim(), "");
  }
  if (input.relatedSourcePaths && input.relatedSourcePaths.length > 0) {
    lines.push("## Related Source Paths", "");
    for (const path of input.relatedSourcePaths) {
      lines.push(`- ${path.replace(/[\r\n]+/g, " ").trim()}`);
    }
    lines.push("");
  }
  if (input.supersedes && input.supersedes.length > 0) {
    lines.push("## Supersedes", "");
    for (const prior of input.supersedes) {
      lines.push(`- ${prior.replace(/[\r\n]+/g, " ").trim()}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function recordDecision(input: RecordDecisionInput): Promise<RecordDecisionResult> {
  const subject = input.subject?.trim();
  const decision = input.decision?.trim();
  if (!subject) {
    throw new Error("subject must not be empty");
  }
  if (!decision) {
    throw new Error("decision must not be empty");
  }

  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const filename = `${timestampForFilename(recordedAt)}-${slugify(subject)}.md`;
  const relativePath = `${RECORDED_DECISIONS_DIR}/${filename}`;
  const absolutePath = resolve(input.repoRoot, relativePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  const content = `${renderFrontmatter(input, recordedAt)}${renderBody(input)}`;
  await writeFile(absolutePath, content, "utf-8");

  return {
    absolutePath,
    relativePath: relativePath.replace(/\\/g, "/"),
    recordedAt,
    filename,
  };
}
