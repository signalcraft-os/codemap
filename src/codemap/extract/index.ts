import type { Claim, EvidenceSpan, SourceSnapshot } from "../model/types.js";

export interface ExtractedClaim {
  claim: Claim;
  evidence: EvidenceSpan[];
}

export interface ClaimExtractor {
  name: string;
  extract(snapshots: SourceSnapshot[]): Promise<ExtractedClaim[]>;
}

export * from "./code/index.js";
export * from "./knowledge/index.js";
