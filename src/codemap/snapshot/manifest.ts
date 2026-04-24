import type { SnapshotManifest, SnapshotManifestEntry, SourceSnapshot } from "../model/types.js";

function compareManifestEntries(a: SnapshotManifestEntry, b: SnapshotManifestEntry): number {
  return a.sourcePath.localeCompare(b.sourcePath)
    || a.contentHash.localeCompare(b.contentHash)
    || a.snapshotId.localeCompare(b.snapshotId);
}

export function buildSnapshotManifest(
  snapshots: SourceSnapshot[],
  version = "1"
): SnapshotManifest {
  const entries = snapshots
    .map((snapshot) => ({
      snapshotId: snapshot.id,
      sourcePath: snapshot.sourcePath,
      contentHash: snapshot.contentHash,
      createdAt: snapshot.createdAt,
    }))
    .sort(compareManifestEntries);

  const generatedAt = entries.length > 0
    ? entries.map((entry) => entry.createdAt).sort().at(-1) ?? ""
    : "";

  return {
    version,
    generatedAt,
    entries,
  };
}
