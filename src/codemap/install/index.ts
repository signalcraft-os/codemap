import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const SECTION_BEGIN_MARKER = "<!-- codemap-claude-md-section-begin -->";
export const SECTION_END_MARKER = "<!-- codemap-claude-md-section-end -->";

export type InstallClaudeMdAction = "created" | "appended" | "updated" | "skipped";

export interface InstallClaudeMdOptions {
  targetPath?: string;
  sectionText?: string;
  force?: boolean;
}

export interface InstallClaudeMdResult {
  targetPath: string;
  action: InstallClaudeMdAction;
}

export async function installClaudeMdSection(
  options: InstallClaudeMdOptions = {},
): Promise<InstallClaudeMdResult> {
  const targetPath = options.targetPath ?? defaultClaudeMdPath();
  const sectionText = options.sectionText ?? await readBundledSection();
  const trimmedSection = sectionText.replace(/^\n+/, "").replace(/\n+$/, "");

  await mkdir(dirname(targetPath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(targetPath, "utf-8");
  } catch {
    // File doesn't exist; will be created below.
  }

  if (existing.length === 0) {
    await writeFile(targetPath, `${trimmedSection}\n`);
    return { targetPath, action: "created" };
  }

  const hasMarker = existing.includes(SECTION_BEGIN_MARKER);

  if (hasMarker && !options.force) {
    return { targetPath, action: "skipped" };
  }

  if (hasMarker && options.force) {
    const beginIdx = existing.indexOf(SECTION_BEGIN_MARKER);
    const endIdx = existing.indexOf(SECTION_END_MARKER, beginIdx);
    if (endIdx === -1) {
      throw new Error(
        `${SECTION_BEGIN_MARKER} found without a matching ${SECTION_END_MARKER} in ${targetPath}`,
      );
    }
    const before = existing.slice(0, beginIdx).replace(/\n+$/, "");
    const after = existing.slice(endIdx + SECTION_END_MARKER.length).replace(/^\n+/, "");
    const parts = [before, trimmedSection, after].filter((part) => part.length > 0);
    const updated = `${parts.join("\n\n")}\n`;
    await writeFile(targetPath, updated);
    return { targetPath, action: "updated" };
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(targetPath, `${existing}${separator}${trimmedSection}\n`);
  return { targetPath, action: "appended" };
}

export function defaultClaudeMdPath(): string {
  return join(homedir(), ".claude", "CLAUDE.md");
}

async function readBundledSection(): Promise<string> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // dist/codemap/install/index.js -> ../../../assets/claude-md-codemap-section.md
  // src/codemap/install/index.ts  -> ../../../assets/claude-md-codemap-section.md
  // Both resolve to <pkg>/assets/claude-md-codemap-section.md.
  const assetPath = join(__dirname, "..", "..", "..", "assets", "claude-md-codemap-section.md");
  return await readFile(assetPath, "utf-8");
}
