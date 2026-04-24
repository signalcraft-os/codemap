import { normalizeSourcePath } from "../../snapshot/snapshotter.js";

export interface SourcePathFilterOptions {
  sourcePaths?: string[];
}

export function createSourcePathMatcher(sourcePaths?: string[]) {
  const normalized = [...new Set((sourcePaths ?? []).map((sourcePath) => normalizeSourcePath(sourcePath)))].sort();
  if (normalized.length === 0) {
    return () => true;
  }

  const allowed = new Set(normalized);
  return (sourcePath?: string) => {
    if (!sourcePath) {
      return false;
    }
    return allowed.has(normalizeSourcePath(sourcePath));
  };
}
