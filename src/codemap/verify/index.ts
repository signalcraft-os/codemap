import type {
  Claim,
  ConflictEdge,
  VerificationRecord,
  VerifierKind,
} from "../model/types.js";

export interface ClaimVerifier {
  name: VerifierKind;
  verify(claim: Claim): Promise<VerificationRecord>;
}

export interface ConflictDetector {
  detect(claims: Claim[]): Promise<ConflictEdge[]>;
}

export * from "./verify-route.js";
export * from "./verify-schema.js";
export * from "./verify-component.js";
export * from "./verify-config.js";
export * from "./verify-library.js";
export * from "./verify-env.js";
export * from "./verify-hotspot.js";
export * from "./verify-middleware.js";
export * from "./verify-knowledge.js";
