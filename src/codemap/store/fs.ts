import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEMAP_DIRECTORIES } from "../model/layout.js";

export function resolveCodemapPath(repoRoot: string, codemapPath: string): string {
  return join(repoRoot, codemapPath);
}

export async function ensureCodemapLayout(repoRoot: string): Promise<void> {
  for (const dir of Object.values(CODEMAP_DIRECTORIES)) {
    await mkdir(resolveCodemapPath(repoRoot, dir), { recursive: true });
  }
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export async function readNdjsonFile<T>(path: string): Promise<T[]> {
  try {
    const content = await readFile(path, "utf-8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

export async function writeNdjsonFile(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(path, content ? `${content}\n` : "", "utf-8");
}

export function upsertById<T extends { id: string }>(existing: T[], next: T): T[] {
  const byId = new Map(existing.map((item) => [item.id, item]));
  byId.set(next.id, next);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
