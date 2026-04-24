import { CODEMAP_FILES } from "../model/layout.js";
import type { VerificationRecord } from "../model/types.js";
import type { VerificationStore } from "./index.js";
import {
  ensureCodemapLayout,
  readNdjsonFile,
  resolveCodemapPath,
  upsertById,
  writeNdjsonFile,
} from "./fs.js";

export class FileVerificationStore implements VerificationStore {
  constructor(private readonly repoRoot: string) {}

  async list(): Promise<VerificationRecord[]> {
    const verification = await readNdjsonFile<VerificationRecord>(this.getVerificationPath());
    return verification.sort((a, b) => a.id.localeCompare(b.id));
  }

  async listByClaimId(claimId: string): Promise<VerificationRecord[]> {
    const verification = await this.list();
    return verification
      .filter((record) => record.claimId === claimId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async put(record: VerificationRecord): Promise<void> {
    await ensureCodemapLayout(this.repoRoot);
    const records = upsertById(await this.list(), record);
    await this.replace(records);
  }

  async replace(records: VerificationRecord[]): Promise<void> {
    await ensureCodemapLayout(this.repoRoot);
    await writeNdjsonFile(
      this.getVerificationPath(),
      [...records].sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  private getVerificationPath(): string {
    return resolveCodemapPath(this.repoRoot, CODEMAP_FILES.verificationNdjson);
  }
}
