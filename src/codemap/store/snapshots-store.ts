import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { readArchivedSnapshotById, readArchivedSnapshotContentById } from "../history/policy.js";
import { makeCodemapStorageBasename } from "../model/ids.js";
import { CODEMAP_DIRECTORIES, CODEMAP_FILES } from "../model/layout.js";
import type { SnapshotManifest, SourceSnapshot } from "../model/types.js";
import { buildSnapshotManifest } from "../snapshot/manifest.js";
import { hashSnapshotContent } from "../snapshot/snapshotter.js";
import type { SnapshotStore } from "./index.js";
import {
  ensureCodemapLayout,
  readJsonFile,
  resolveCodemapPath,
  upsertById,
  writeJsonFile,
} from "./fs.js";

export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly repoRoot: string) {}

  async getById(snapshotId: string): Promise<SourceSnapshot | null> {
    return (await readJsonFile<SourceSnapshot>(this.getSnapshotFilePath(snapshotId)))
      ?? (await readJsonFile<SourceSnapshot>(this.getLegacySnapshotFilePath(snapshotId)))
      ?? readArchivedSnapshotById(this.repoRoot, snapshotId);
  }

  async getContent(snapshotId: string): Promise<string | null> {
    try {
      const content = await readFile(this.getSnapshotContentPath(snapshotId));
      return gunzipSync(content).toString("utf-8");
    } catch {
      return readArchivedSnapshotContentById(this.repoRoot, snapshotId);
    }
  }

  async list(): Promise<SourceSnapshot[]> {
    const manifest = await this.readManifest();
    if (!manifest) {
      return [];
    }

    const snapshots: SourceSnapshot[] = [];
    for (const entry of manifest.entries) {
      const snapshot = await this.getById(entry.snapshotId);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  async put(snapshot: SourceSnapshot): Promise<void> {
    await ensureCodemapLayout(this.repoRoot);

    const merged = upsertById(await this.list(), snapshot);
    await this.replace(merged);
  }

  async readManifest(): Promise<SnapshotManifest | null> {
    return readJsonFile<SnapshotManifest>(this.getManifestPath());
  }

  async replace(snapshots: SourceSnapshot[]): Promise<void> {
    await ensureCodemapLayout(this.repoRoot);
    const sortedSnapshots = [...snapshots].sort((a, b) => a.id.localeCompare(b.id));
    const storedSnapshots: SourceSnapshot[] = [];
    for (const snapshot of sortedSnapshots) {
      await this.persistSnapshotContent(snapshot);
      await writeJsonFile(this.getSnapshotFilePath(snapshot.id), snapshot);
      storedSnapshots.push(snapshot);
    }

    await writeJsonFile(this.getManifestPath(), buildSnapshotManifest(storedSnapshots));
  }

  private getManifestPath(): string {
    return resolveCodemapPath(this.repoRoot, CODEMAP_FILES.snapshotManifest);
  }

  private getSnapshotFilePath(snapshotId: string): string {
    return resolveCodemapPath(
      this.repoRoot,
      `${CODEMAP_DIRECTORIES.snapshotFiles}/${makeCodemapStorageBasename(snapshotId, ".json")}`,
    );
  }

  private getLegacySnapshotFilePath(snapshotId: string): string {
    return resolveCodemapPath(this.repoRoot, `${CODEMAP_DIRECTORIES.snapshotFiles}/${snapshotId}.json`);
  }

  private getSnapshotContentPath(snapshotId: string): string {
    const basename = createHash("sha256").update(snapshotId).digest("hex");
    return resolveCodemapPath(this.repoRoot, `${CODEMAP_DIRECTORIES.snapshotContents}/${basename}.txt.gz`);
  }

  private async persistSnapshotContent(snapshot: SourceSnapshot): Promise<void> {
    if (await this.getContent(snapshot.id) !== null) {
      return;
    }

    try {
      const content = await readFile(resolveCodemapPath(this.repoRoot, snapshot.sourcePath), "utf-8");
      if (hashSnapshotContent(content) !== snapshot.contentHash) {
        return;
      }
      await writeFile(this.getSnapshotContentPath(snapshot.id), gzipSync(content));
    } catch {}
  }
}
