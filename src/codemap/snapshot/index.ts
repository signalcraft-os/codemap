import type { SnapshotManifest, SourceSnapshot } from "../model/types.js";

export interface SnapshotWriter {
  writeSnapshot(snapshot: SourceSnapshot): Promise<void>;
  writeManifest(manifest: SnapshotManifest): Promise<void>;
}

export interface SnapshotReader {
  readSnapshot(snapshotId: string): Promise<SourceSnapshot | null>;
  readManifest(): Promise<SnapshotManifest | null>;
}

export * from "./manifest.js";
export * from "./snapshotter.js";
