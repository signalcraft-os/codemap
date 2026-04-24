import { CODEMAP_FILES } from "../model/layout.js";
import type { Claim, ClaimIndex, ClaimIndexEntry } from "../model/types.js";
import type { ClaimStore } from "./index.js";
import {
  ensureCodemapLayout,
  readJsonFile,
  readNdjsonFile,
  resolveCodemapPath,
  upsertById,
  writeJsonFile,
  writeNdjsonFile,
} from "./fs.js";

function buildClaimIndex(claims: Claim[]): ClaimIndex {
  const entries: ClaimIndexEntry[] = claims
    .map((claim) => ({
      claimId: claim.id,
      type: claim.type,
      status: claim.status,
      subject: claim.subject,
      tags: [...claim.tags].sort(),
    }))
    .sort((a, b) => a.claimId.localeCompare(b.claimId));

  const generatedAt = claims.length > 0
    ? claims
      .map((claim) => claim.lastVerifiedAt ?? claim.firstSeenAt)
      .sort()
      .at(-1) ?? ""
    : "";

  return {
    generatedAt,
    claims: entries,
  };
}

export class FileClaimStore implements ClaimStore {
  constructor(private readonly repoRoot: string) {}

  async getById(claimId: string): Promise<Claim | null> {
    const claims = await this.list();
    return claims.find((claim) => claim.id === claimId) ?? null;
  }

  async list(): Promise<Claim[]> {
    const claims = await readNdjsonFile<Claim>(this.getClaimsPath());
    return claims.sort((a, b) => a.id.localeCompare(b.id));
  }

  async put(claim: Claim): Promise<void> {
    await ensureCodemapLayout(this.repoRoot);

    const claims = upsertById(await this.list(), claim);
    await this.replace(claims);
  }

  async replace(claims: Claim[]): Promise<void> {
    await ensureCodemapLayout(this.repoRoot);
    const sortedClaims = [...claims].sort((a, b) => a.id.localeCompare(b.id));
    await writeNdjsonFile(this.getClaimsPath(), sortedClaims);
    await writeJsonFile(this.getClaimIndexPath(), buildClaimIndex(sortedClaims));
  }

  async readIndex(): Promise<ClaimIndex | null> {
    return readJsonFile<ClaimIndex>(this.getClaimIndexPath());
  }

  private getClaimsPath(): string {
    return resolveCodemapPath(this.repoRoot, CODEMAP_FILES.claimsNdjson);
  }

  private getClaimIndexPath(): string {
    return resolveCodemapPath(this.repoRoot, CODEMAP_FILES.claimIndex);
  }
}
