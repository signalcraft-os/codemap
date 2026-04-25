import { makeHashedCodemapId } from "../model/ids.js";
import type {
  Claim,
  ClaimType,
  ConflictEdge,
  ConflictSeverity,
  PublishIncident,
  PublishIncidentSource,
  VerificationRecord,
} from "../model/types.js";

export interface ClaimHealthIncidentsInput {
  claims: Claim[];
  conflicts: ConflictEdge[];
  verification: VerificationRecord[];
  generatedAt: string;
  criticalClaimTypes: ReadonlySet<ClaimType>;
}

export const DEFAULT_CRITICAL_CODE_CLAIM_TYPES: ReadonlySet<ClaimType> = new Set<ClaimType>([
  "route",
  "model",
  "env_var",
  "middleware",
]);

export const DEFAULT_CRITICAL_KNOWLEDGE_CLAIM_TYPES: ReadonlySet<ClaimType> = new Set<ClaimType>([
  "knowledge_decision",
]);

function makeIncidentId(source: PublishIncidentSource, parts: string[]): string {
  return makeHashedCodemapId("incident", [source, ...parts]);
}

function latestFailingVerificationId(
  verification: VerificationRecord[],
  claimId: string,
): string | undefined {
  const failures = verification
    .filter((record) => record.claimId === claimId && record.outcome !== "pass")
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  return failures[0]?.id;
}

function conflictIncident(
  edge: ConflictEdge,
  claimsById: Map<string, Claim>,
  generatedAt: string,
): PublishIncident | null {
  if (edge.severity !== "high" && edge.severity !== "medium") {
    return null;
  }

  const source: PublishIncidentSource = edge.severity === "high" ? "conflict-high" : "conflict-medium";
  const incidentSeverity: ConflictSeverity = edge.severity;
  const claimA = claimsById.get(edge.claimA);
  const claimB = claimsById.get(edge.claimB);
  const subjectA = claimA?.subject ?? edge.claimA;
  const subjectB = claimB?.subject ?? edge.claimB;
  const message = `${edge.severity} severity ${edge.relation} between '${subjectA}' and '${subjectB}': ${edge.rationale}`;

  return {
    id: makeIncidentId(source, [edge.id]),
    createdAt: generatedAt,
    severity: incidentSeverity,
    message,
    claimIds: [edge.claimA, edge.claimB].sort(),
    source,
    sourceRecordId: edge.id,
  };
}

function staleClaimIncident(
  claim: Claim,
  verification: VerificationRecord[],
  criticalTypes: ReadonlySet<ClaimType>,
  generatedAt: string,
): PublishIncident {
  const isCritical = criticalTypes.has(claim.type);
  const source: PublishIncidentSource = isCritical ? "claim-stale-critical" : "claim-stale";
  const severity: ConflictSeverity = isCritical ? "high" : "medium";
  const sourceRecordId = latestFailingVerificationId(verification, claim.id);
  const message = isCritical
    ? `Critical ${claim.type} claim '${claim.subject}' is stale and unsafe to publish without re-verification.`
    : `${claim.type} claim '${claim.subject}' is stale and needs re-verification.`;

  return {
    id: makeIncidentId(source, [claim.id]),
    createdAt: generatedAt,
    severity,
    message,
    claimIds: [claim.id],
    source,
    sourceRecordId,
  };
}

function conflictingClaimIncident(
  claim: Claim,
  verification: VerificationRecord[],
  generatedAt: string,
): PublishIncident {
  const sourceRecordId = latestFailingVerificationId(verification, claim.id);
  return {
    id: makeIncidentId("claim-conflicting", [claim.id]),
    createdAt: generatedAt,
    severity: "medium",
    message: `${claim.type} claim '${claim.subject}' is currently in a conflicting state.`,
    claimIds: [claim.id],
    source: "claim-conflicting",
    sourceRecordId,
  };
}

function quarantinedClaimIncident(
  claim: Claim,
  verification: VerificationRecord[],
  generatedAt: string,
): PublishIncident {
  const sourceRecordId = latestFailingVerificationId(verification, claim.id);
  return {
    id: makeIncidentId("claim-quarantined", [claim.id]),
    createdAt: generatedAt,
    severity: "medium",
    message: `${claim.type} claim '${claim.subject}' is quarantined and excluded from publication.`,
    claimIds: [claim.id],
    source: "claim-quarantined",
    sourceRecordId,
  };
}

export function buildClaimHealthIncidents(input: ClaimHealthIncidentsInput): PublishIncident[] {
  const claimsById = new Map(input.claims.map((claim) => [claim.id, claim]));
  const incidents: PublishIncident[] = [];

  for (const edge of input.conflicts) {
    const incident = conflictIncident(edge, claimsById, input.generatedAt);
    if (incident) {
      incidents.push(incident);
    }
  }

  for (const claim of input.claims) {
    if (claim.status === "stale") {
      incidents.push(staleClaimIncident(claim, input.verification, input.criticalClaimTypes, input.generatedAt));
    } else if (claim.status === "conflicting") {
      incidents.push(conflictingClaimIncident(claim, input.verification, input.generatedAt));
    } else if (claim.status === "quarantined") {
      incidents.push(quarantinedClaimIncident(claim, input.verification, input.generatedAt));
    }
  }

  return incidents.sort((left, right) => left.id.localeCompare(right.id));
}
