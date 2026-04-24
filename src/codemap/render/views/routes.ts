import type { Claim, ConflictEdge, RenderedView, SourceSnapshot } from "../../model/types.js";

function renderFrontmatter(
  title: string,
  generatedAt: string,
  claims: Claim[],
  snapshots: SourceSnapshot[],
  conflicts: ConflictEdge[],
  viewType: string
): string {
  const verifiedCount = claims.filter((claim) => claim.status === "verified").length;
  const inferredCount = claims.filter((claim) => claim.status === "inferred").length;
  const staleCount = claims.filter((claim) => claim.status === "stale").length;

  return [
    "---",
    `title: ${title}`,
    `view_type: ${viewType}`,
    `generated_at: ${generatedAt}`,
    `claim_count: ${claims.length}`,
    `verified_claim_count: ${verifiedCount}`,
    `inferred_claim_count: ${inferredCount}`,
    `stale_claim_count: ${staleCount}`,
    `conflict_count: ${conflicts.length}`,
    `source_snapshot_count: ${snapshots.length}`,
    "---",
    "",
  ].join("\n");
}

function renderClaimRefComment(claims: Claim[]): string {
  return `<!-- claim_ids: ${claims.map((claim) => claim.id).join(", ")} -->`;
}

function toRouteSummaryLine(claim: Claim): string {
  const labels: string[] = [`[${claim.status}]`];
  if (claim.tags.includes("inferred") && claim.status !== "inferred") {
    labels.push("[inferred]");
  }
  return `- \`${claim.subject}\` ${labels.join(" ")} — ${claim.text}`;
}

function groupRoutesByMethod(claims: Claim[]): Map<string, Claim[]> {
  const groups = new Map<string, Claim[]>();

  for (const claim of claims) {
    const method = claim.subject.split(" ")[0] || "UNKNOWN";
    if (!groups.has(method)) {
      groups.set(method, []);
    }
    groups.get(method)!.push(claim);
  }

  return new Map(
    [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([method, group]) => [method, group.sort((left, right) => left.subject.localeCompare(right.subject))]),
  );
}

export function renderRouteViews(
  claims: Claim[],
  snapshots: SourceSnapshot[],
  conflicts: ConflictEdge[],
  generatedAt: string
): RenderedView[] {
  const sortedClaims = [...claims].sort((a, b) => a.subject.localeCompare(b.subject));
  const methodGroups = groupRoutesByMethod(sortedClaims);
  const staleClaims = sortedClaims.filter((claim) => claim.status === "stale");
  const inferredClaims = sortedClaims.filter((claim) => claim.status === "inferred");

  const indexMarkdown = [
    renderFrontmatter("CodeMap Index", generatedAt, sortedClaims, snapshots, conflicts, "codemap_index"),
    "# CodeMap",
    "",
    renderClaimRefComment(sortedClaims),
    "",
    "- [Overview](./overview.md)",
    "- [Route Inventory](./code/routes.md)",
    "",
    `Status: ${sortedClaims.filter((claim) => claim.status === "verified").length} verified, ${inferredClaims.length} inferred, ${staleClaims.length} stale.`,
    conflicts.length > 0 ? `Conflicts: ${conflicts.length} route conflicts require review.` : "Conflicts: none detected in the route-only pipeline.",
    "",
  ].join("\n");

  const overviewLines = [
    renderFrontmatter("Route Overview", generatedAt, sortedClaims, snapshots, conflicts, "code_overview"),
    "# Route Overview",
    "",
    renderClaimRefComment(sortedClaims),
    "",
    `This view is derived from ${sortedClaims.length} route claims backed by ${snapshots.length} source snapshots.`,
    "",
    "## By Method",
    "",
  ];
  for (const [method, group] of methodGroups) {
    overviewLines.push(`### ${method}`);
    overviewLines.push(renderClaimRefComment(group));
    overviewLines.push(`- ${group.length} route claims`);
    overviewLines.push("");
  }
  if (inferredClaims.length > 0) {
    overviewLines.push("## Inferred Routes");
    overviewLines.push(renderClaimRefComment(inferredClaims));
    for (const claim of inferredClaims) {
      overviewLines.push(toRouteSummaryLine(claim));
    }
    overviewLines.push("");
  }
  if (staleClaims.length > 0) {
    overviewLines.push("## Stale Routes");
    overviewLines.push(renderClaimRefComment(staleClaims));
    for (const claim of staleClaims) {
      overviewLines.push(toRouteSummaryLine(claim));
    }
    overviewLines.push("");
  }

  const routeLines = [
    renderFrontmatter("Route Inventory", generatedAt, sortedClaims, snapshots, conflicts, "code_topic"),
    "# Route Inventory",
    "",
    renderClaimRefComment(sortedClaims),
    "",
    "Routes are rendered from canonical CodeMap claims. Markdown here is a derived navigation layer, not the source of truth.",
    "",
  ];
  for (const [method, group] of methodGroups) {
    routeLines.push(`## ${method}`);
    routeLines.push(renderClaimRefComment(group));
    routeLines.push("");
    for (const claim of group) {
      routeLines.push(toRouteSummaryLine(claim));
    }
    routeLines.push("");
  }

  return [
    { path: ".codemap/views/index.md", title: "CodeMap", markdown: indexMarkdown, claimIds: sortedClaims.map((claim) => claim.id) },
    { path: ".codemap/views/overview.md", title: "Route Overview", markdown: overviewLines.join("\n"), claimIds: sortedClaims.map((claim) => claim.id) },
    { path: ".codemap/views/code/routes.md", title: "Route Inventory", markdown: routeLines.join("\n"), claimIds: sortedClaims.map((claim) => claim.id) },
  ];
}
