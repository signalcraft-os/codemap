import type { Claim, ConflictEdge, PublishPlan, VerificationRecord } from "../model/types.js";

export interface PublishPlannerInput {
  claims: Claim[];
  verification: VerificationRecord[];
  conflicts: ConflictEdge[];
}

export interface PublishPlanner {
  plan(input: PublishPlannerInput): Promise<PublishPlan>;
}

export * from "./plans.js";
export * from "./routes-pipeline.js";
export * from "./code-pipeline.js";
export * from "./knowledge-pipeline.js";
