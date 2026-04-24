import { CODEMAP_FILES } from "../model/layout.js";
import type { ConflictEdge } from "../model/types.js";
import type { ConflictStore } from "./index.js";
import {
  ensureCodemapLayout,
  readNdjsonFile,
  resolveCodemapPath,
  upsertById,
  writeNdjsonFile,
} from "./fs.js";

export class FileConflictStore implements ConflictStore {
  constructor(private readonly repoRoot: string) {}

  async list(): Promise<ConflictEdge[]> {
    const conflicts = await readNdjsonFile<ConflictEdge>(this.getConflictsPath());
    return conflicts.sort((a, b) => a.id.localeCompare(b.id));
  }

  async listByClaimId(claimId: string): Promise<ConflictEdge[]> {
    const conflicts = await this.list();
    return conflicts
      .filter((edge) => edge.claimA === claimId || edge.claimB === claimId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async put(edge: ConflictEdge): Promise<void> {
    await ensureCodemapLayout(this.repoRoot);
    const edges = upsertById(await this.list(), edge);
    await this.replace(edges);
  }

  async replace(edges: ConflictEdge[]): Promise<void> {
    await ensureCodemapLayout(this.repoRoot);
    await writeNdjsonFile(
      this.getConflictsPath(),
      [...edges].sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  private getConflictsPath(): string {
    return resolveCodemapPath(this.repoRoot, CODEMAP_FILES.conflictsNdjson);
  }
}
