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

function getTagValue(claim: Claim, prefix: string): string | undefined {
  return claim.tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

function parseCountTag(claim: Claim, prefix: string): number | null {
  const value = getTagValue(claim, prefix);
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getPrimarySourcePath(claim: Claim, snapshotsById: Map<string, SourceSnapshot>): string {
  for (const snapshotId of claim.sourceSnapshotIds) {
    const snapshot = snapshotsById.get(snapshotId);
    if (snapshot?.sourcePath) {
      return snapshot.sourcePath;
    }
  }
  return "unknown";
}

function toSummaryLine(claim: Claim): string {
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
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([method, group]) => [
        method,
        group.sort((left, right) => left.subject.localeCompare(right.subject)),
      ]),
  );
}

function groupRelationsByModel(claims: Claim[]): Map<string, Claim[]> {
  const groups = new Map<string, Claim[]>();

  for (const claim of claims) {
    const modelName = getTagValue(claim, "model:") ?? "Unknown";
    if (!groups.has(modelName)) {
      groups.set(modelName, []);
    }
    groups.get(modelName)!.push(claim);
  }

  return new Map(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([modelName, group]) => [
        modelName,
        group.sort((left, right) => left.subject.localeCompare(right.subject)),
      ]),
  );
}

function groupComponentsByRole(claims: Claim[]): Map<string, Claim[]> {
  const groups = new Map<string, Claim[]>();

  for (const claim of claims) {
    const role = getTagValue(claim, "component-role:") ?? "shared";
    if (!groups.has(role)) {
      groups.set(role, []);
    }
    groups.get(role)!.push(claim);
  }

  return new Map(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, group]) => [
        role,
        group.sort((left, right) => left.subject.localeCompare(right.subject)),
      ]),
  );
}

function groupLibrariesByGroup(claims: Claim[]): Map<string, Claim[]> {
  const groups = new Map<string, Claim[]>();

  for (const claim of claims) {
    const group = getTagValue(claim, "library-group:") ?? "misc";
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group)!.push(claim);
  }

  return new Map(
    [...groups.entries()]
      .sort(([leftGroup, leftClaims], [rightGroup, rightClaims]) =>
        rightClaims.length - leftClaims.length || leftGroup.localeCompare(rightGroup))
      .map(([group, groupClaims]) => [
        group,
        groupClaims.sort((left, right) => left.subject.localeCompare(right.subject)),
      ]),
  );
}

function groupMiddlewareByType(claims: Claim[]): Map<string, Claim[]> {
  const groups = new Map<string, Claim[]>();

  for (const claim of claims) {
    const type = getTagValue(claim, "middleware-type:") ?? "custom";
    if (!groups.has(type)) {
      groups.set(type, []);
    }
    groups.get(type)!.push(claim);
  }

  return new Map(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, group]) => [
        type,
        group.sort((left, right) => left.subject.localeCompare(right.subject)),
      ]),
  );
}

function sortHotspotClaims(claims: Claim[]): Claim[] {
  return [...claims].sort((left, right) => {
    const leftCount = parseCountTag(left, "imported-by-count:") ?? 0;
    const rightCount = parseCountTag(right, "imported-by-count:") ?? 0;
    return rightCount - leftCount || left.subject.localeCompare(right.subject);
  });
}

function sortDependencyClaims(claims: Claim[]): Claim[] {
  return [...claims].sort((left, right) => {
    const leftNotable = left.tags.includes("notable-dependency") ? 1 : 0;
    const rightNotable = right.tags.includes("notable-dependency") ? 1 : 0;
    return rightNotable - leftNotable || left.subject.localeCompare(right.subject);
  });
}

function getTagValues(claim: Claim, prefix: string): string[] {
  return claim.tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .filter(Boolean)
    .sort();
}

function countModelsByOrm(claims: Claim[]): string[] {
  const counts = new Map<string, number>();

  for (const claim of claims) {
    const orm = getTagValue(claim, "orm:") ?? "unknown";
    counts.set(orm, (counts.get(orm) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([orm, count]) => `- ${orm}: ${count} model claims`);
}

function renderConflictLines(conflicts: ConflictEdge[], claims: Claim[], allowedTypes?: Set<Claim["type"]>): string[] {
  if (conflicts.length === 0) {
    return [];
  }

  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const relevantConflicts = conflicts.filter((conflict) => {
    if (!allowedTypes) {
      return true;
    }
    const claimA = claimById.get(conflict.claimA);
    const claimB = claimById.get(conflict.claimB);
    return Boolean(claimA && claimB && allowedTypes.has(claimA.type) && allowedTypes.has(claimB.type));
  });

  if (relevantConflicts.length === 0) {
    return [];
  }

  const lines = ["## Conflicts", ""];
  for (const conflict of relevantConflicts.sort((left, right) => left.id.localeCompare(right.id))) {
    const claimA = claimById.get(conflict.claimA);
    const claimB = claimById.get(conflict.claimB);
    const leftSubject = claimA?.subject ?? conflict.claimA;
    const rightSubject = claimB?.subject ?? conflict.claimB;
    lines.push(`- [${conflict.severity}] ${conflict.relation}: \`${leftSubject}\` vs \`${rightSubject}\` — ${conflict.rationale}`);
  }
  lines.push("");
  return lines;
}

export function renderCodeViews(
  claims: Claim[],
  snapshots: SourceSnapshot[],
  conflicts: ConflictEdge[],
  generatedAt: string
): RenderedView[] {
  const sortedClaims = [...claims].sort((left, right) => left.subject.localeCompare(right.subject));
  const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const routeClaims = sortedClaims.filter((claim) => claim.type === "route");
  const modelClaims = sortedClaims.filter((claim) => claim.type === "model");
  const relationClaims = sortedClaims.filter((claim) => claim.type === "relation");
  const configFileClaims = sortedClaims.filter((claim) => claim.type === "config_file");
  const packageDependencyClaims = sortDependencyClaims(sortedClaims.filter((claim) => claim.type === "package_dependency"));
  const envClaims = sortedClaims.filter((claim) => claim.type === "env_var");
  const middlewareClaims = sortedClaims.filter((claim) => claim.type === "middleware");
  const hotspotClaims = sortHotspotClaims(sortedClaims.filter((claim) => claim.type === "dependency_hotspot"));
  const componentClaims = sortedClaims.filter((claim) => claim.type === "component");
  const libraryClaims = sortedClaims.filter((claim) => claim.type === "library_module");
  const inferredClaims = sortedClaims.filter((claim) => claim.status === "inferred");
  const staleClaims = sortedClaims.filter((claim) => claim.status === "stale");
  const routeGroups = groupRoutesByMethod(routeClaims);
  const relationGroups = groupRelationsByModel(relationClaims);
  const middlewareGroups = groupMiddlewareByType(middlewareClaims);
  const componentGroups = groupComponentsByRole(componentClaims);
  const libraryGroups = groupLibrariesByGroup(libraryClaims);
  const requiredEnvClaims = envClaims.filter((claim) => claim.tags.includes("required"));
  const optionalEnvClaims = envClaims.filter((claim) => !claim.tags.includes("required"));

  const indexLines = [
    renderFrontmatter("CodeMap Index", generatedAt, sortedClaims, snapshots, conflicts, "codemap_index"),
    "# CodeMap",
    "",
    renderClaimRefComment(sortedClaims),
    "",
    "- [Overview](./overview.md)",
  ];

  if (routeClaims.length > 0) {
    indexLines.push("- [Route Inventory](./code/routes.md)");
  }
  if (modelClaims.length > 0 || relationClaims.length > 0) {
    indexLines.push("- [Database Inventory](./code/database.md)");
  }
  if (configFileClaims.length > 0 || packageDependencyClaims.length > 0) {
    indexLines.push("- [Config Inventory](./code/config.md)");
  }
  if (hotspotClaims.length > 0) {
    indexLines.push("- [Impact Inventory](./code/impact.md)");
  }
  if (envClaims.length > 0 || middlewareClaims.length > 0) {
    indexLines.push("- [Runtime Inventory](./code/runtime.md)");
  }
  if (componentClaims.length > 0) {
    indexLines.push("- [UI Inventory](./code/ui.md)");
  }
  if (libraryClaims.length > 0) {
    indexLines.push("- [Library Inventory](./code/libraries.md)");
  }

  indexLines.push("");
  indexLines.push(`Routes: ${routeClaims.length} claim${routeClaims.length === 1 ? "" : "s"}.`);
  indexLines.push(`Models: ${modelClaims.length} claim${modelClaims.length === 1 ? "" : "s"}.`);
  indexLines.push(`Relations: ${relationClaims.length} claim${relationClaims.length === 1 ? "" : "s"}.`);
  indexLines.push(`Config Files: ${configFileClaims.length} claim${configFileClaims.length === 1 ? "" : "s"}.`);
  indexLines.push(`Dependencies: ${packageDependencyClaims.length} claim${packageDependencyClaims.length === 1 ? "" : "s"}.`);
  indexLines.push(`Hotspots: ${hotspotClaims.length} claim${hotspotClaims.length === 1 ? "" : "s"}.`);
  indexLines.push(`Env Vars: ${envClaims.length} claim${envClaims.length === 1 ? "" : "s"}.`);
  indexLines.push(`Middleware: ${middlewareClaims.length} claim${middlewareClaims.length === 1 ? "" : "s"}.`);
  indexLines.push(`Components: ${componentClaims.length} claim${componentClaims.length === 1 ? "" : "s"}.`);
  indexLines.push(`Libraries: ${libraryClaims.length} claim${libraryClaims.length === 1 ? "" : "s"}.`);
  indexLines.push(
    conflicts.length > 0
      ? `Conflicts: ${conflicts.length} claim conflicts require review.`
      : "Conflicts: none detected in the current shadow pipeline.",
  );
  indexLines.push("");

  const overviewLines = [
    renderFrontmatter("Code Overview", generatedAt, sortedClaims, snapshots, conflicts, "code_overview"),
    "# Code Overview",
    "",
    renderClaimRefComment(sortedClaims),
    "",
    `This view is derived from ${sortedClaims.length} CodeMap claims backed by ${snapshots.length} source snapshots.`,
    "",
  ];

  if (routeClaims.length > 0) {
    overviewLines.push("## Routes");
    overviewLines.push("");
    for (const [method, group] of routeGroups) {
      overviewLines.push(`### ${method}`);
      overviewLines.push(renderClaimRefComment(group));
      overviewLines.push(`- ${group.length} route claims`);
      overviewLines.push("");
    }
  }

  if (modelClaims.length > 0 || relationClaims.length > 0) {
    overviewLines.push("## Data Model");
    overviewLines.push("");
    overviewLines.push(`- ${modelClaims.length} model claims`);
    overviewLines.push(`- ${relationClaims.length} relation claims`);
    overviewLines.push(...countModelsByOrm(modelClaims));
    overviewLines.push("");
  }

  if (configFileClaims.length > 0 || packageDependencyClaims.length > 0) {
    const notableDependencies = packageDependencyClaims.filter((claim) => claim.tags.includes("notable-dependency"));
    overviewLines.push("## Setup");
    overviewLines.push("");
    overviewLines.push(`- ${configFileClaims.length} config file claims`);
    overviewLines.push(`- ${packageDependencyClaims.length} package dependency claims`);
    overviewLines.push(`- ${notableDependencies.length} notable dependencies`);
    overviewLines.push("");
  }

  if (hotspotClaims.length > 0) {
    overviewLines.push("## High-Impact Files");
    overviewLines.push("");
    for (const claim of hotspotClaims.slice(0, 6)) {
      const importedBy = parseCountTag(claim, "imported-by-count:") ?? 0;
      overviewLines.push(`- \`${claim.subject}\` — imported by ${importedBy} file${importedBy === 1 ? "" : "s"}`);
    }
    overviewLines.push("");
  }

  if (envClaims.length > 0 || middlewareClaims.length > 0) {
    overviewLines.push("## Runtime");
    overviewLines.push("");
    overviewLines.push(`- ${envClaims.length} environment variable claims`);
    overviewLines.push(`- ${requiredEnvClaims.length} required environment variables`);
    overviewLines.push(`- ${middlewareClaims.length} middleware claims`);
    for (const [type, group] of middlewareGroups) {
      overviewLines.push(`- middleware ${type}: ${group.length} claim${group.length === 1 ? "" : "s"}`);
    }
    overviewLines.push("");
  }

  if (componentClaims.length > 0) {
    overviewLines.push("## UI");
    overviewLines.push("");
    for (const [role, group] of componentGroups) {
      overviewLines.push(`- ${role}: ${group.length} component claims`);
    }
    overviewLines.push("");
  }

  if (libraryClaims.length > 0) {
    overviewLines.push("## Libraries");
    overviewLines.push("");
    for (const [group, groupClaims] of libraryGroups) {
      overviewLines.push(`- ${group}: ${groupClaims.length} library claims`);
    }
    overviewLines.push("");
  }

  overviewLines.push(...renderConflictLines(conflicts, sortedClaims));

  if (inferredClaims.length > 0) {
    overviewLines.push("## Inferred Claims");
    overviewLines.push(renderClaimRefComment(inferredClaims));
    for (const claim of inferredClaims) {
      overviewLines.push(toSummaryLine(claim));
    }
    overviewLines.push("");
  }

  if (staleClaims.length > 0) {
    overviewLines.push("## Stale Claims");
    overviewLines.push(renderClaimRefComment(staleClaims));
    for (const claim of staleClaims) {
      overviewLines.push(toSummaryLine(claim));
    }
    overviewLines.push("");
  }

  const views: RenderedView[] = [
    {
      path: ".codemap/views/index.md",
      title: "CodeMap",
      markdown: indexLines.join("\n"),
      claimIds: sortedClaims.map((claim) => claim.id),
    },
    {
      path: ".codemap/views/overview.md",
      title: "Code Overview",
      markdown: overviewLines.join("\n"),
      claimIds: sortedClaims.map((claim) => claim.id),
    },
  ];

  if (routeClaims.length > 0) {
    const routeLines = [
      renderFrontmatter("Route Inventory", generatedAt, routeClaims, snapshots, conflicts, "code_topic"),
      "# Route Inventory",
      "",
      renderClaimRefComment(routeClaims),
      "",
      "Routes are rendered from canonical CodeMap claims. Markdown here is a derived navigation layer, not the source of truth.",
      "",
    ];
    for (const [method, group] of routeGroups) {
      routeLines.push(`## ${method}`);
      routeLines.push(renderClaimRefComment(group));
      routeLines.push("");
      for (const claim of group) {
        routeLines.push(toSummaryLine(claim));
      }
      routeLines.push("");
    }
    views.push({
      path: ".codemap/views/code/routes.md",
      title: "Route Inventory",
      markdown: routeLines.join("\n"),
      claimIds: routeClaims.map((claim) => claim.id),
    });
  }

  if (modelClaims.length > 0 || relationClaims.length > 0) {
    const databaseClaims = [...modelClaims, ...relationClaims].sort((left, right) => left.subject.localeCompare(right.subject));
    const databaseLines = [
      renderFrontmatter("Database Inventory", generatedAt, databaseClaims, snapshots, conflicts, "code_topic"),
      "# Database Inventory",
      "",
      renderClaimRefComment(databaseClaims),
      "",
      "Models and relations are rendered from canonical CodeMap claims. Markdown here is a derived navigation layer, not the source of truth.",
      "",
    ];

    if (modelClaims.length > 0) {
      databaseLines.push("## Models");
      databaseLines.push(renderClaimRefComment(modelClaims));
      databaseLines.push("");
      for (const claim of modelClaims) {
        databaseLines.push(toSummaryLine(claim));
      }
      databaseLines.push("");
    }

  if (relationClaims.length > 0) {
      databaseLines.push("## Relations");
      databaseLines.push(renderClaimRefComment(relationClaims));
      databaseLines.push("");
      for (const [modelName, group] of relationGroups) {
        databaseLines.push(`### ${modelName}`);
        databaseLines.push(renderClaimRefComment(group));
        databaseLines.push("");
        for (const claim of group) {
          databaseLines.push(toSummaryLine(claim));
        }
        databaseLines.push("");
      }
    }

    const staleDatabaseClaims = databaseClaims.filter((claim) => claim.status === "stale");
    if (staleDatabaseClaims.length > 0) {
      databaseLines.push("## Stale Claims");
      databaseLines.push(renderClaimRefComment(staleDatabaseClaims));
      databaseLines.push("");
      for (const claim of staleDatabaseClaims) {
        databaseLines.push(toSummaryLine(claim));
      }
      databaseLines.push("");
    }

    databaseLines.push(...renderConflictLines(
      conflicts,
      databaseClaims,
      new Set<Claim["type"]>(["model", "relation"]),
    ));

    views.push({
      path: ".codemap/views/code/database.md",
      title: "Database Inventory",
      markdown: databaseLines.join("\n"),
      claimIds: databaseClaims.map((claim) => claim.id),
    });
  }

  if (configFileClaims.length > 0 || packageDependencyClaims.length > 0) {
    const configClaims = [...configFileClaims, ...packageDependencyClaims].sort((left, right) => left.subject.localeCompare(right.subject));
    const runtimeDependencies = packageDependencyClaims.filter((claim) => getTagValue(claim, "dependency-scope:") === "runtime");
    const devDependencies = packageDependencyClaims.filter((claim) => getTagValue(claim, "dependency-scope:") === "development");
    const notableDependencies = packageDependencyClaims.filter((claim) => claim.tags.includes("notable-dependency"));
    const configLines = [
      renderFrontmatter("Config Inventory", generatedAt, configClaims, snapshots, conflicts, "code_topic"),
      "# Config Inventory",
      "",
      renderClaimRefComment(configClaims),
      "",
      "Config files and package dependencies are rendered from canonical CodeMap claims. Markdown here is a derived navigation layer, not the source of truth.",
      "",
    ];

    if (configFileClaims.length > 0) {
      configLines.push("## Config Files");
      configLines.push(renderClaimRefComment(configFileClaims));
      configLines.push("");
      for (const claim of configFileClaims) {
        const configKind = getTagValue(claim, "config-kind:") ?? "config";
        configLines.push(`- \`${claim.subject}\` [${claim.status}] — ${configKind}`);
      }
      configLines.push("");
    }

    if (notableDependencies.length > 0) {
      configLines.push("## Key Dependencies");
      configLines.push(renderClaimRefComment(notableDependencies));
      configLines.push("");
      for (const claim of notableDependencies) {
        const version = getTagValue(claim, "dependency-version:") ?? "unknown";
        const scope = getTagValue(claim, "dependency-scope:") ?? "runtime";
        configLines.push(`- \`${claim.subject}\` [${claim.status}] — ${version} (${scope})`);
      }
      configLines.push("");
    }

    if (runtimeDependencies.length > 0) {
      configLines.push("## Runtime Dependencies");
      configLines.push(renderClaimRefComment(runtimeDependencies));
      configLines.push("");
      for (const claim of runtimeDependencies) {
        const version = getTagValue(claim, "dependency-version:") ?? "unknown";
        const label = claim.tags.includes("notable-dependency") ? " notable" : "";
        configLines.push(`- \`${claim.subject}\` [${claim.status}] — ${version}${label}`);
      }
      configLines.push("");
    }

    if (devDependencies.length > 0) {
      configLines.push("## Development Dependencies");
      configLines.push(renderClaimRefComment(devDependencies));
      configLines.push("");
      for (const claim of devDependencies) {
        const version = getTagValue(claim, "dependency-version:") ?? "unknown";
        const label = claim.tags.includes("notable-dependency") ? " notable" : "";
        configLines.push(`- \`${claim.subject}\` [${claim.status}] — ${version}${label}`);
      }
      configLines.push("");
    }

    configLines.push(...renderConflictLines(
      conflicts,
      configClaims,
      new Set<Claim["type"]>(["config_file", "package_dependency"]),
    ));

    views.push({
      path: ".codemap/views/code/config.md",
      title: "Config Inventory",
      markdown: configLines.join("\n"),
      claimIds: configClaims.map((claim) => claim.id),
    });
  }

  if (hotspotClaims.length > 0) {
    const impactLines = [
      renderFrontmatter("Impact Inventory", generatedAt, hotspotClaims, snapshots, conflicts, "code_topic"),
      "# Impact Inventory",
      "",
      renderClaimRefComment(hotspotClaims),
      "",
      "Dependency hotspots are rendered from canonical CodeMap claims. Markdown here is a derived navigation layer, not the source of truth.",
      "",
      "## High-Impact Files",
      "",
    ];

    for (const claim of hotspotClaims) {
      const importedBy = parseCountTag(claim, "imported-by-count:") ?? 0;
      const bucket = getTagValue(claim, "hotspot-bucket:") ?? "medium";
      impactLines.push(`- \`${claim.subject}\` [${claim.status}] — imported by ${importedBy} file${importedBy === 1 ? "" : "s"} (${bucket})`);
    }
    impactLines.push("");
    impactLines.push(...renderConflictLines(
      conflicts,
      hotspotClaims,
      new Set<Claim["type"]>(["dependency_hotspot"]),
    ));

    views.push({
      path: ".codemap/views/code/impact.md",
      title: "Impact Inventory",
      markdown: impactLines.join("\n"),
      claimIds: hotspotClaims.map((claim) => claim.id),
    });
  }

  if (envClaims.length > 0 || middlewareClaims.length > 0) {
    const runtimeClaims = [...envClaims, ...middlewareClaims].sort((left, right) => left.subject.localeCompare(right.subject));
    const runtimeLines = [
      renderFrontmatter("Runtime Inventory", generatedAt, runtimeClaims, snapshots, conflicts, "code_topic"),
      "# Runtime Inventory",
      "",
      renderClaimRefComment(runtimeClaims),
      "",
      "Environment variables and middleware are rendered from canonical CodeMap claims. Markdown here is a derived navigation layer, not the source of truth.",
      "",
    ];

    if (requiredEnvClaims.length > 0) {
      runtimeLines.push("## Required Environment Variables");
      runtimeLines.push(renderClaimRefComment(requiredEnvClaims));
      runtimeLines.push("");
      for (const claim of requiredEnvClaims) {
        runtimeLines.push(`- \`${claim.subject}\` [${claim.status}] — \`${getPrimarySourcePath(claim, snapshotsById)}\``);
      }
      runtimeLines.push("");
    }

    if (optionalEnvClaims.length > 0) {
      runtimeLines.push("## Optional Environment Variables");
      runtimeLines.push(renderClaimRefComment(optionalEnvClaims));
      runtimeLines.push("");
      for (const claim of optionalEnvClaims) {
        runtimeLines.push(`- \`${claim.subject}\` [${claim.status}] — \`${getPrimarySourcePath(claim, snapshotsById)}\``);
      }
      runtimeLines.push("");
    }

    if (middlewareClaims.length > 0) {
      runtimeLines.push("## Middleware");
      runtimeLines.push(renderClaimRefComment(middlewareClaims));
      runtimeLines.push("");
      for (const [type, group] of middlewareGroups) {
        runtimeLines.push(`### ${type}`);
        runtimeLines.push(renderClaimRefComment(group));
        runtimeLines.push("");
        for (const claim of group) {
          runtimeLines.push(`- \`${claim.subject}\` [${claim.status}] — \`${getPrimarySourcePath(claim, snapshotsById)}\``);
        }
        runtimeLines.push("");
      }
    }

    runtimeLines.push(...renderConflictLines(
      conflicts,
      runtimeClaims,
      new Set<Claim["type"]>(["env_var", "middleware"]),
    ));

    views.push({
      path: ".codemap/views/code/runtime.md",
      title: "Runtime Inventory",
      markdown: runtimeLines.join("\n"),
      claimIds: runtimeClaims.map((claim) => claim.id),
    });
  }

  if (componentClaims.length > 0) {
    const uiLines = [
      renderFrontmatter("UI Inventory", generatedAt, componentClaims, snapshots, conflicts, "code_topic"),
      "# UI Inventory",
      "",
      renderClaimRefComment(componentClaims),
      "",
      "Components are rendered from canonical CodeMap claims. Markdown here is a derived navigation layer, not the source of truth.",
      "",
    ];

    for (const [role, group] of componentGroups) {
      const title = role === "client"
        ? "Client Components"
        : role === "server"
          ? "Server Components"
          : "Components";
      uiLines.push(`## ${title}`);
      uiLines.push(renderClaimRefComment(group));
      uiLines.push("");
      for (const claim of group) {
        const props = getTagValues(claim, "prop:");
        const propText = props.length > 0 ? ` — props: ${props.join(", ")}` : "";
        uiLines.push(`${toSummaryLine(claim)}${propText}`);
      }
      uiLines.push("");
    }

    views.push({
      path: ".codemap/views/code/ui.md",
      title: "UI Inventory",
      markdown: uiLines.join("\n"),
      claimIds: componentClaims.map((claim) => claim.id),
    });
  }

  if (libraryClaims.length > 0) {
    const libraryLines = [
      renderFrontmatter("Library Inventory", generatedAt, libraryClaims, snapshots, conflicts, "code_topic"),
      "# Library Inventory",
      "",
      renderClaimRefComment(libraryClaims),
      "",
      "Libraries are rendered from canonical CodeMap claims. Markdown here is a derived navigation layer, not the source of truth.",
      "",
    ];

    for (const [group, groupClaims] of libraryGroups) {
      const title = group.charAt(0).toUpperCase() + group.slice(1);
      libraryLines.push(`## ${title} (${groupClaims.length} files)`);
      libraryLines.push(renderClaimRefComment(groupClaims));
      libraryLines.push("");
      for (const claim of groupClaims) {
        const exports = getTagValues(claim, "export:").map((entry) => entry.split(":").at(-1) ?? entry);
        const exportText = exports.length > 0 ? ` — ${exports.slice(0, 6).join(", ")}${exports.length > 6 ? ", …" : ""}` : "";
        libraryLines.push(`- \`${claim.subject}\` [${claim.status}]${exportText}`);
      }
      libraryLines.push("");
    }

    views.push({
      path: ".codemap/views/code/libraries.md",
      title: "Library Inventory",
      markdown: libraryLines.join("\n"),
      claimIds: libraryClaims.map((claim) => claim.id),
    });
  }

  return views;
}
