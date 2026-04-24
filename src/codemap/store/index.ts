import type {
  Claim,
  ConflictEdge,
  EvidenceSpan,
  SourceSnapshot,
  VerificationRecord,
} from "../model/types.js";

export interface SnapshotStore {
  getById(snapshotId: string): Promise<SourceSnapshot | null>;
  getContent(snapshotId: string): Promise<string | null>;
  list(): Promise<SourceSnapshot[]>;
  put(snapshot: SourceSnapshot): Promise<void>;
  replace(snapshots: SourceSnapshot[]): Promise<void>;
}

export interface ClaimStore {
  getById(claimId: string): Promise<Claim | null>;
  list(): Promise<Claim[]>;
  put(claim: Claim): Promise<void>;
  replace(claims: Claim[]): Promise<void>;
}

export interface EvidenceStore {
  getById(evidenceId: string): Promise<EvidenceSpan | null>;
  list(): Promise<EvidenceSpan[]>;
  put(evidence: EvidenceSpan): Promise<void>;
  replace(evidence: EvidenceSpan[]): Promise<void>;
}

export interface VerificationStore {
  list(): Promise<VerificationRecord[]>;
  listByClaimId(claimId: string): Promise<VerificationRecord[]>;
  put(record: VerificationRecord): Promise<void>;
  replace(records: VerificationRecord[]): Promise<void>;
}

export interface ConflictStore {
  list(): Promise<ConflictEdge[]>;
  listByClaimId(claimId: string): Promise<ConflictEdge[]>;
  put(edge: ConflictEdge): Promise<void>;
  replace(edges: ConflictEdge[]): Promise<void>;
}

export * from "./claims-store.js";
export * from "./conflict-store.js";
export * from "./evidence-store.js";
export * from "./fs.js";
export * from "./snapshots-store.js";
export * from "./verification-store.js";
