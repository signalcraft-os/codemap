import { CODEMAP_FILES } from "../model/layout.js";
import type { EvidenceSpan } from "../model/types.js";
import type { EvidenceStore } from "./index.js";
import {
  ensureCodemapLayout,
  readNdjsonFile,
  resolveCodemapPath,
  upsertById,
  writeNdjsonFile,
} from "./fs.js";

export class FileEvidenceStore implements EvidenceStore {
  constructor(private readonly repoRoot: string) {}

  async getById(evidenceId: string): Promise<EvidenceSpan | null> {
    const evidence = await this.list();
    return evidence.find((entry) => entry.id === evidenceId) ?? null;
  }

  async list(): Promise<EvidenceSpan[]> {
    const evidence = await readNdjsonFile<EvidenceSpan>(this.getEvidencePath());
    return evidence.sort((a, b) => a.id.localeCompare(b.id));
  }

  async put(entry: EvidenceSpan): Promise<void> {
    await ensureCodemapLayout(this.repoRoot);
    const evidence = upsertById(await this.list(), entry);
    await this.replace(evidence);
  }

  async replace(evidence: EvidenceSpan[]): Promise<void> {
    await ensureCodemapLayout(this.repoRoot);
    await writeNdjsonFile(
      this.getEvidencePath(),
      [...evidence].sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  private getEvidencePath(): string {
    return resolveCodemapPath(this.repoRoot, CODEMAP_FILES.evidenceNdjson);
  }
}
