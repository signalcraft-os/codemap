import { CODEMAP_FILES } from "../../model/layout.js";
import type { Claim, ConflictEdge, RenderedView, SourceSnapshot } from "../../model/types.js";

interface CompatibilityWikiInput {
  projectName: string;
  claims: Claim[];
  conflicts: ConflictEdge[];
  snapshots: SourceSnapshot[];
  generatedAt: string;
}

interface CompatibilityRouteClaim {
  claim: Claim;
  method: string;
  path: string;
  sourcePath: string;
  framework: string;
  tags: string[];
}

interface CompatibilityModelClaim {
  claim: Claim;
  sourcePath: string;
  orm: string;
  fieldCount: number | null;
  relationCount: number | null;
}

interface CompatibilityRelationClaim {
  claim: Claim;
  sourcePath: string;
  orm: string;
  model: string;
  targets: string[];
}

interface CompatibilityComponentClaim {
  claim: Claim;
  sourcePath: string;
  framework: string;
  role: "client" | "server" | "shared";
  props: string[];
}

interface CompatibilityLibraryClaim {
  claim: Claim;
  sourcePath: string;
  group: string;
  language: string;
  exports: string[];
}

interface CompatibilityHotspotClaim {
  claim: Claim;
  sourcePath: string;
  importedBy: number;
  bucket: string;
}

interface CompatibilityEnvClaim {
  claim: Claim;
  sourcePath: string;
  required: boolean;
  sourceRole: "declaration" | "usage";
}

interface CompatibilityMiddlewareClaim {
  claim: Claim;
  sourcePath: string;
  type: string;
}

interface CompatibilityDomain {
  name: string;
  routes: CompatibilityRouteClaim[];
}

interface CompatibilityDomainView extends RenderedView {
  slug: string;
}

const COMPATIBILITY_LIBRARY_THRESHOLD = 10;

function today(value: string): string {
  return value.slice(0, 10);
}

function getTagValue(claim: Claim, prefix: string): string | undefined {
  return claim.tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
}

function getTagValues(claim: Claim, prefix: string): string[] {
  return claim.tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .filter(Boolean)
    .sort();
}

function parseCountTag(claim: Claim, prefix: string): number | null {
  const value = getTagValue(claim, prefix);
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseRouteSubject(subject: string): { method: string; path: string } {
  const [method = "UNKNOWN", ...rest] = subject.split(" ");
  const path = rest.join(" ").trim() || "/";
  return { method, path };
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

function safeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase() || "section";
}

function compatibilityWikiPath(fileName: string): string {
  return `.codemap/compatibility/wiki/${fileName}`;
}

function domainFromFile(file: string): string | null {
  if (!file || file === "unknown") {
    return null;
  }

  const parts = file.replace(/\\/g, "/").split("/");
  let containerIdx = -1;
  for (let index = parts.length - 1; index >= 0; index--) {
    if (["routes", "routers", "handlers", "controllers", "endpoints"].includes(parts[index])) {
      containerIdx = index;
      break;
    }
  }

  if (containerIdx >= 0 && containerIdx + 1 < parts.length) {
    const name = parts[containerIdx + 1].replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|swift|brs|bs)$/, "");
    const generic = new Set(["index", "server", "app", "main", "router", "routes", "api", "handler", "handlers", "base"]);
    if (!generic.has(name) && name.length > 1) {
      return name;
    }
  }

  const basename = parts[parts.length - 1].replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|swift|brs|bs)$/, "");
  const generic = new Set(["index", "server", "app", "main", "router", "routes", "api", "handler", "handlers", "rest", "cli", "dashboard"]);
  if (!generic.has(basename) && basename.length > 1 && !basename.startsWith("_")) {
    return basename;
  }

  return null;
}

function detectDomains(routes: CompatibilityRouteClaim[]): CompatibilityDomain[] {
  const buckets = new Map<string, CompatibilityRouteClaim[]>();

  for (const route of routes) {
    const path = route.path.toLowerCase();
    let domain: string;

    if (route.framework === "trpc") {
      domain = route.path.split(".")[0] || "procedures";
    } else if (
      path === "/" ||
      /^\/(health|healthz|metrics|status|ping|ready|readyz|live|livez|mcp|sse|messages)(\/|$)/.test(path)
    ) {
      domain = "infra";
    } else if (
      /\/(auth|login|logout|signup|sign-in|sign-up|sign-out|register|oauth|sso|saml|token|refresh|password|forgot|reset|verify|confirm)(\/|$)/.test(path) ||
      /\/(google|github|discord|twitter|reddit|microsoft|apple)(\/callback)?(\/|$)/.test(path)
    ) {
      domain = "auth";
    } else if (
      /\/(payment|billing|stripe|polar|lemon|paddle|checkout|subscription|subscribe|invoice|webhook|webhooks|pricing)(\/|$)/.test(path)
    ) {
      domain = "payments";
    } else if (/\/admin(\/|$)/.test(path)) {
      domain = "admin";
    } else {
      const fileDomain = domainFromFile(route.sourcePath);
      if (fileDomain) {
        domain = fileDomain;
      } else {
        const segments = route.path
          .split("/")
          .filter((segment) =>
            segment &&
            !segment.startsWith(":") &&
            !segment.startsWith("{") &&
            !segment.startsWith("<") &&
            !["api", "v1", "v2", "v3"].includes(segment)
          );
        domain = segments[0]?.replace(/_/g, "-") || "api";
      }
    }

    if (!buckets.has(domain)) {
      buckets.set(domain, []);
    }
    buckets.get(domain)!.push(route);
  }

  const priority = ["auth", "payments"];
  const last = ["infra", "api"];
  const middle = [...buckets.keys()].filter((key) => !priority.includes(key) && !last.includes(key)).sort();
  const ordered = [...priority, ...middle, ...last].filter((key) => buckets.has(key));

  return ordered.map((name) => ({
    name,
    routes: [...(buckets.get(name) ?? [])].sort((left, right) => left.claim.subject.localeCompare(right.claim.subject)),
  }));
}

function renderClaimIdComment(claims: Claim[]): string {
  return `<!-- claim_ids: ${claims.map((claim) => claim.id).join(", ")} -->`;
}

function toStatusBadge(claim: Claim): string {
  if (claim.tags.includes("inferred") && claim.status !== "inferred") {
    return `[${claim.status}] [inferred]`;
  }
  return `[${claim.status}]`;
}

function renderConflictSection(
  claims: Claim[],
  conflicts: ConflictEdge[],
  allowedTypes?: Set<Claim["type"]>
): string[] {
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const relevant = conflicts.filter((conflict) => {
    if (!allowedTypes) {
      return claimById.has(conflict.claimA) || claimById.has(conflict.claimB);
    }
    const left = claimById.get(conflict.claimA);
    const right = claimById.get(conflict.claimB);
    return Boolean(left && right && allowedTypes.has(left.type) && allowedTypes.has(right.type));
  });

  if (relevant.length === 0) {
    return [];
  }

  const lines = ["## Conflicts", ""];
  for (const conflict of relevant.sort((left, right) => left.id.localeCompare(right.id))) {
    const left = claimById.get(conflict.claimA);
    const right = claimById.get(conflict.claimB);
    lines.push(`- [${conflict.severity}] ${left?.subject ?? conflict.claimA} vs ${right?.subject ?? conflict.claimB} — ${conflict.rationale}`);
  }
  lines.push("");
  return lines;
}

function renderHealthSection(claims: Claim[], conflicts: ConflictEdge[]): string[] {
  if (claims.length === 0) {
    return [];
  }

  const count = (status: Claim["status"]) => claims.filter((claim) => claim.status === status).length;
  return [
    "## Claim Health",
    "",
    `- Verified: ${count("verified")}`,
    `- Inferred: ${count("inferred")}`,
    `- Stale: ${count("stale")}`,
    `- Quarantined: ${count("quarantined")}`,
    `- Conflicts: ${conflicts.length}`,
    "",
  ];
}

function buildRouteClaims(claims: Claim[], snapshotsById: Map<string, SourceSnapshot>): CompatibilityRouteClaim[] {
  return claims
    .filter((claim) => claim.type === "route")
    .map((claim) => {
      const { method, path } = parseRouteSubject(claim.subject);
      return {
        claim,
        method,
        path,
        sourcePath: getPrimarySourcePath(claim, snapshotsById),
        framework: getTagValue(claim, "framework:") ?? "unknown",
        tags: claim.tags.filter((tag) => !tag.startsWith("framework:") && !tag.startsWith("method:") && tag !== "inferred").sort(),
      };
    })
    .sort((left, right) => left.claim.subject.localeCompare(right.claim.subject));
}

function buildModelClaims(claims: Claim[], snapshotsById: Map<string, SourceSnapshot>): CompatibilityModelClaim[] {
  return claims
    .filter((claim) => claim.type === "model")
    .map((claim) => ({
      claim,
      sourcePath: getPrimarySourcePath(claim, snapshotsById),
      orm: getTagValue(claim, "orm:") ?? "unknown",
      fieldCount: parseCountTag(claim, "field-count:"),
      relationCount: parseCountTag(claim, "relation-count:"),
    }))
    .sort((left, right) => left.claim.subject.localeCompare(right.claim.subject));
}

function buildRelationClaims(claims: Claim[], snapshotsById: Map<string, SourceSnapshot>): CompatibilityRelationClaim[] {
  return claims
    .filter((claim) => claim.type === "relation")
    .map((claim) => ({
      claim,
      sourcePath: getPrimarySourcePath(claim, snapshotsById),
      orm: getTagValue(claim, "orm:") ?? "unknown",
      model: getTagValue(claim, "model:") ?? "unknown",
      targets: getTagValues(claim, "relation-target:"),
    }))
    .sort((left, right) => left.claim.subject.localeCompare(right.claim.subject));
}

function buildComponentClaims(claims: Claim[], snapshotsById: Map<string, SourceSnapshot>): CompatibilityComponentClaim[] {
  return claims
    .filter((claim) => claim.type === "component")
    .map((claim) => ({
      claim,
      sourcePath: getPrimarySourcePath(claim, snapshotsById),
      framework: getTagValue(claim, "component-framework:") ?? "unknown",
      role: ((getTagValue(claim, "component-role:") ?? "shared") as "client" | "server" | "shared"),
      props: getTagValues(claim, "prop:"),
    }))
    .sort((left, right) => left.claim.subject.localeCompare(right.claim.subject));
}

function buildLibraryClaims(claims: Claim[], snapshotsById: Map<string, SourceSnapshot>): CompatibilityLibraryClaim[] {
  return claims
    .filter((claim) => claim.type === "library_module")
    .map((claim) => ({
      claim,
      sourcePath: getPrimarySourcePath(claim, snapshotsById),
      group: getTagValue(claim, "library-group:") ?? "misc",
      language: getTagValue(claim, "language:") ?? "unknown",
      exports: getTagValues(claim, "export:").map((entry) => entry.split(":").at(-1) ?? entry),
    }))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function buildHotspotClaims(claims: Claim[], snapshotsById: Map<string, SourceSnapshot>): CompatibilityHotspotClaim[] {
  return claims
    .filter((claim) => claim.type === "dependency_hotspot")
    .map((claim) => ({
      claim,
      sourcePath: getPrimarySourcePath(claim, snapshotsById),
      importedBy: parseCountTag(claim, "imported-by-count:") ?? 0,
      bucket: getTagValue(claim, "hotspot-bucket:") ?? "medium",
    }))
    .sort((left, right) => right.importedBy - left.importedBy || left.sourcePath.localeCompare(right.sourcePath));
}

function buildEnvClaims(claims: Claim[], snapshotsById: Map<string, SourceSnapshot>): CompatibilityEnvClaim[] {
  return claims
    .filter((claim) => claim.type === "env_var")
    .map((claim) => ({
      claim,
      sourcePath: getPrimarySourcePath(claim, snapshotsById),
      required: claim.tags.includes("required"),
      sourceRole: ((getTagValue(claim, "env-source:") ?? "usage") as "declaration" | "usage"),
    }))
    .sort((left, right) => left.claim.subject.localeCompare(right.claim.subject));
}

function buildMiddlewareClaims(claims: Claim[], snapshotsById: Map<string, SourceSnapshot>): CompatibilityMiddlewareClaim[] {
  return claims
    .filter((claim) => claim.type === "middleware")
    .map((claim) => ({
      claim,
      sourcePath: getPrimarySourcePath(claim, snapshotsById),
      type: getTagValue(claim, "middleware-type:") ?? "custom",
    }))
    .sort((left, right) => left.claim.subject.localeCompare(right.claim.subject));
}

function renderOverviewView(
  projectName: string,
  generatedAt: string,
  routeClaims: CompatibilityRouteClaim[],
  modelClaims: CompatibilityModelClaim[],
  relationClaims: CompatibilityRelationClaim[],
  hotspotClaims: CompatibilityHotspotClaim[],
  envClaims: CompatibilityEnvClaim[],
  middlewareClaims: CompatibilityMiddlewareClaim[],
  componentClaims: CompatibilityComponentClaim[],
  libraryClaims: CompatibilityLibraryClaim[],
  conflicts: ConflictEdge[],
  domains: CompatibilityDomain[]
): RenderedView {
  const allClaims = [
    ...routeClaims.map((entry) => entry.claim),
    ...modelClaims.map((entry) => entry.claim),
    ...relationClaims.map((entry) => entry.claim),
    ...hotspotClaims.map((entry) => entry.claim),
    ...envClaims.map((entry) => entry.claim),
    ...middlewareClaims.map((entry) => entry.claim),
    ...componentClaims.map((entry) => entry.claim),
    ...libraryClaims.map((entry) => entry.claim),
  ];
  const requiredEnvClaims = envClaims.filter((entry) => entry.required);
  const lines = [
    `# ${projectName} — Overview`,
    "",
    "> Compatibility wiki article derived from canonical CodeMap claims for legacy wiki consumers.",
    "",
    renderClaimIdComment(allClaims),
    "",
    `Generated ${today(generatedAt)} from ${allClaims.length} code claims backed by immutable snapshots.`,
    "",
    "## Scale",
    "",
    `${routeClaims.length} routes · ${modelClaims.length} models · ${relationClaims.length} relations · ${hotspotClaims.length} hotspots · ${middlewareClaims.length} middleware · ${envClaims.length} env vars · ${componentClaims.length} components · ${libraryClaims.length} libraries`,
    "",
  ];

  if (domains.length > 0) {
    lines.push("## Subsystems", "");
    for (const domain of domains) {
      const title = domain.name.charAt(0).toUpperCase() + domain.name.slice(1);
      lines.push(`- **[${title}](./${safeFilename(domain.name)}.md)** — ${domain.routes.length} route claims`);
    }
    lines.push("");
  }

  if (modelClaims.length > 0 || relationClaims.length > 0) {
    const orms = [...new Set([...modelClaims, ...relationClaims].map((entry) => entry.orm))].sort();
    lines.push(`**Database:** ${orms.join(", ")}, ${modelClaims.length} models — see [database.md](./database.md)`, "");
  }

  if (componentClaims.length > 0) {
    const componentFrameworks = [...new Set(componentClaims.map((entry) => entry.framework))].sort();
    lines.push(`**UI:** ${componentClaims.length} components (${componentFrameworks.join(", ")}) — see [ui.md](./ui.md)`, "");
  }

  if (libraryClaims.length >= COMPATIBILITY_LIBRARY_THRESHOLD) {
    lines.push(`**Libraries:** ${libraryClaims.length} files — see [libraries.md](./libraries.md)`, "");
  }

  if (hotspotClaims.length > 0) {
    lines.push("## High-Impact Files", "");
    for (const hotspotClaim of hotspotClaims.slice(0, 6)) {
      lines.push(`- \`${hotspotClaim.sourcePath}\` — imported by **${hotspotClaim.importedBy}** files`);
    }
    lines.push("");
  }

  if (requiredEnvClaims.length > 0) {
    lines.push("## Required Environment Variables", "");
    for (const envClaim of requiredEnvClaims.slice(0, 12)) {
      lines.push(`- \`${envClaim.claim.subject}\` — \`${envClaim.sourcePath}\``);
    }
    if (requiredEnvClaims.length > 12) {
      lines.push(`- _...${requiredEnvClaims.length - 12} more_`);
    }
    lines.push("");
  }

  lines.push(...renderHealthSection(allClaims, conflicts));
  lines.push(...renderConflictSection(allClaims, conflicts));
  lines.push("---", `_Back to [index.md](./index.md)_`);

  return {
    path: CODEMAP_FILES.compatibilityWikiOverview,
    title: "Overview",
    markdown: lines.join("\n"),
    claimIds: allClaims.map((claim) => claim.id),
  };
}

function renderDomainView(
  domain: CompatibilityDomain,
  hotspotClaims: CompatibilityHotspotClaim[],
  middlewareClaims: CompatibilityMiddlewareClaim[],
  conflicts: ConflictEdge[],
  slug: string,
): CompatibilityDomainView {
  const title = domain.name.charAt(0).toUpperCase() + domain.name.slice(1);
  const routeClaims = domain.routes.map((entry) => entry.claim);
  const domainFiles = [...new Set(domain.routes.map((route) => route.sourcePath))];
  const middlewareTypes: string[] = [];
  if (domain.name === "auth") {
    middlewareTypes.push("auth");
  }
  if (domain.name === "payments") {
    middlewareTypes.push("validation");
  }
  const relatedMiddleware = middlewareClaims.filter((entry) => middlewareTypes.includes(entry.type));
  const hotInDomain = hotspotClaims.filter((entry) => domainFiles.includes(entry.sourcePath));
  const claims = [
    ...routeClaims,
    ...hotInDomain.map((entry) => entry.claim),
    ...relatedMiddleware.map((entry) => entry.claim),
  ];
  const lines = [
    `# ${title}`,
    "",
    "> Compatibility wiki article derived from CodeMap route claims.",
    "",
    renderClaimIdComment(claims),
    "",
    `The ${title} subsystem currently includes **${domain.routes.length} route claims**.`,
    "",
    "## Routes",
    "",
  ];

  for (const route of domain.routes) {
    const tags = route.tags.length > 0 ? ` [${route.tags.join(", ")}]` : "";
    lines.push(`- \`${route.method}\` \`${route.path}\` ${toStatusBadge(route.claim)}${tags}`);
    lines.push(`  \`${route.sourcePath}\``);
  }
  lines.push("");

  if (relatedMiddleware.length > 0) {
    lines.push("## Middleware", "");
    for (const middleware of relatedMiddleware) {
      lines.push(`- **${middleware.claim.subject}** (${middleware.type}) — \`${middleware.sourcePath}\``);
    }
    lines.push("");
  }

  if (hotInDomain.length > 0) {
    lines.push("## High-Impact Files", "");
    for (const hotspotClaim of hotInDomain) {
      lines.push(`- \`${hotspotClaim.sourcePath}\` — imported by ${hotspotClaim.importedBy} files`);
    }
    lines.push("");
  }

  const sourceFiles = [...new Set(domain.routes.map((route) => route.sourcePath))].sort();
  if (sourceFiles.length > 0) {
    lines.push("## Source Files", "");
    for (const sourceFile of sourceFiles) {
      lines.push(`- \`${sourceFile}\``);
    }
    lines.push("");
  }

  lines.push(...renderConflictSection(claims, conflicts, new Set<Claim["type"]>(["route"])));
  lines.push("---", `_Back to [overview.md](./overview.md)_`);

  return {
    path: compatibilityWikiPath(`${slug}.md`),
    title,
    markdown: lines.join("\n"),
    claimIds: claims.map((claim) => claim.id),
    slug,
  };
}

function renderDatabaseView(
  generatedAt: string,
  modelClaims: CompatibilityModelClaim[],
  relationClaims: CompatibilityRelationClaim[],
  hotspotClaims: CompatibilityHotspotClaim[],
  conflicts: ConflictEdge[]
): RenderedView {
  const claims = [...modelClaims.map((entry) => entry.claim), ...relationClaims.map((entry) => entry.claim)];
  const lines = [
    "# Database",
    "",
    "> Compatibility wiki article derived from CodeMap model and relation claims.",
    "",
    renderClaimIdComment(claims),
    "",
    `Generated ${today(generatedAt)} from ${modelClaims.length} model claims and ${relationClaims.length} relation claims.`,
    "",
  ];

  if (claims.length === 0) {
    lines.push("No database claims are currently available.", "");
  } else {
    const byOrm = new Map<string, CompatibilityModelClaim[]>();
    for (const model of modelClaims) {
      if (!byOrm.has(model.orm)) {
        byOrm.set(model.orm, []);
      }
      byOrm.get(model.orm)!.push(model);
    }

    for (const [orm, models] of [...byOrm.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`## ${orm}`, "");
      for (const model of models.sort((left, right) => left.claim.subject.localeCompare(right.claim.subject))) {
        const modelRelations = relationClaims.filter((relation) => relation.model === model.claim.subject);
        const fieldCount = model.fieldCount ?? 0;
        const relationCount = model.relationCount ?? modelRelations.length;
        lines.push(`### ${model.claim.subject} ${toStatusBadge(model.claim)}`);
        lines.push("");
        lines.push(`- source: \`${model.sourcePath}\``);
        lines.push(`- fields: ${fieldCount}`);
        lines.push(`- relations: ${relationCount}`);
        if (modelRelations.length > 0) {
          lines.push(`- relation claims: ${modelRelations.map((relation) => `\`${relation.claim.subject}\``).join(", ")}`);
        }
        lines.push("");
      }
    }

    if (relationClaims.length > 0) {
      lines.push("## Relations", "");
      for (const relation of relationClaims) {
        const targetSuffix = relation.targets.length > 0 ? ` → ${relation.targets.join(", ")}` : "";
        lines.push(`- \`${relation.claim.subject}\` ${toStatusBadge(relation.claim)}${targetSuffix} — \`${relation.sourcePath}\``);
      }
      lines.push("");
    }

    const staleClaims = claims.filter((claim) => claim.status === "stale");
    if (staleClaims.length > 0) {
      lines.push("## Stale Claims", "");
      for (const claim of staleClaims.sort((left, right) => left.subject.localeCompare(right.subject))) {
        lines.push(`- \`${claim.subject}\` ${toStatusBadge(claim)}`);
      }
      lines.push("");
    }

    const quarantinedClaims = claims.filter((claim) => claim.status === "quarantined");
    if (quarantinedClaims.length > 0) {
      lines.push("## Quarantined Claims", "");
      for (const claim of quarantinedClaims.sort((left, right) => left.subject.localeCompare(right.subject))) {
        lines.push(`- \`${claim.subject}\` ${toStatusBadge(claim)}`);
      }
      lines.push("");
    }
  }

  const schemaSourceFiles = hotspotClaims.filter((entry) =>
    /\/(db|schema|model|drizzle|prisma|migrate)/.test(entry.sourcePath.toLowerCase()),
  );
  if (schemaSourceFiles.length > 0) {
    lines.push("## Schema Source Files", "");
    lines.push("Read and edit these files when adding columns, creating migrations, or changing relations:", "");
    for (const hotspotClaim of schemaSourceFiles) {
      lines.push(`- \`${hotspotClaim.sourcePath}\` — imported by **${hotspotClaim.importedBy}** files`);
    }
    lines.push("");
  }

  lines.push(...renderConflictSection(claims, conflicts, new Set<Claim["type"]>(["model", "relation"])));
  lines.push("---", `_Back to [overview.md](./overview.md)_`);

  return {
    path: CODEMAP_FILES.compatibilityWikiDatabase,
    title: "Database",
    markdown: lines.join("\n"),
    claimIds: claims.map((claim) => claim.id),
  };
}

function renderUiView(
  componentClaims: CompatibilityComponentClaim[],
): RenderedView {
  const claims = componentClaims.map((entry) => entry.claim);
  const lines = [
    "# UI",
    "",
    "> Compatibility wiki article derived from CodeMap component claims.",
    "",
    renderClaimIdComment(claims),
    "",
    `**${componentClaims.length} components** (${[...new Set(componentClaims.map((entry) => entry.framework))].sort().join(", ")})`,
    "",
  ];

  const groups = [
    ["server", "Server Components"],
    ["client", "Client Components"],
    ["shared", "Components"],
  ] as const;

  for (const [role, title] of groups) {
    const group = componentClaims.filter((entry) => entry.role === role);
    if (group.length === 0) {
      continue;
    }
    lines.push(`## ${title}`, "");
    for (const component of group) {
      const props = component.props.length > 0 ? ` — props: ${component.props.join(", ")}` : "";
      lines.push(`- **${component.claim.subject}**${props} ${toStatusBadge(component.claim)} — \`${component.sourcePath}\``);
    }
    lines.push("");
  }

  lines.push("---", `_Back to [overview.md](./overview.md)_`);

  return {
    path: CODEMAP_FILES.compatibilityWikiUi,
    title: "UI",
    markdown: lines.join("\n"),
    claimIds: claims.map((claim) => claim.id),
  };
}

function renderLibrariesView(
  libraryClaims: CompatibilityLibraryClaim[],
): RenderedView {
  const claims = libraryClaims.map((entry) => entry.claim);
  const lines = [
    "# Libraries",
    "",
    "> Compatibility wiki article derived from CodeMap library-module claims.",
    "",
    renderClaimIdComment(claims),
    "",
  ];

  const groups = new Map<string, CompatibilityLibraryClaim[]>();
  for (const libraryClaim of libraryClaims) {
    if (!groups.has(libraryClaim.group)) {
      groups.set(libraryClaim.group, []);
    }
    groups.get(libraryClaim.group)!.push(libraryClaim);
  }

  const sortedGroups = [...groups.entries()].sort(
    ([leftGroup, leftClaims], [rightGroup, rightClaims]) =>
      rightClaims.length - leftClaims.length || leftGroup.localeCompare(rightGroup),
  );

  lines.push(`**${libraryClaims.length} library files** across ${sortedGroups.length} module${sortedGroups.length === 1 ? "" : "s"}`, "");

  for (const [group, groupClaims] of sortedGroups) {
    const title = group.charAt(0).toUpperCase() + group.slice(1);
    lines.push(`## ${title} (${groupClaims.length} files)`, "");
    for (const libraryClaim of groupClaims.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))) {
      const exportText = libraryClaim.exports.length > 0
        ? ` — ${libraryClaim.exports.slice(0, 6).join(", ")}${libraryClaim.exports.length > 6 ? ", …" : ""}`
        : "";
      lines.push(`- \`${libraryClaim.sourcePath}\`${exportText}`);
    }
    lines.push("");
  }

  lines.push("---", `_Back to [overview.md](./overview.md)_`);

  return {
    path: CODEMAP_FILES.compatibilityWikiLibraries,
    title: "Libraries",
    markdown: lines.join("\n"),
    claimIds: claims.map((claim) => claim.id),
  };
}

function renderIndexView(
  projectName: string,
  generatedAt: string,
  claims: Claim[],
  envClaims: CompatibilityEnvClaim[],
  middlewareClaims: CompatibilityMiddlewareClaim[],
  conflicts: ConflictEdge[],
  articles: RenderedView[]
): RenderedView {
  const routeCount = claims.filter((claim) => claim.type === "route").length;
  const modelCount = claims.filter((claim) => claim.type === "model").length;
  const relationCount = claims.filter((claim) => claim.type === "relation").length;
  const requiredEnvCount = envClaims.filter((claim) => claim.required).length;
  const optionalEnvCount = envClaims.length - requiredEnvCount;
  const middlewareCount = middlewareClaims.length;
  const componentCount = claims.filter((claim) => claim.type === "component").length;
  const libraryCount = claims.filter((claim) => claim.type === "library_module").length;
  const lines = [
    `# ${projectName} — Compatibility Wiki`,
    "",
    `_Generated ${today(generatedAt)} from canonical CodeMap claims for legacy wiki consumers._`,
    "",
    renderClaimIdComment(claims),
    "",
    "## Articles",
    "",
    ...articles.map((article) => {
      const fileName = article.path.split("/").at(-1) ?? article.path;
      return `- [${article.title}](./${fileName})`;
    }),
    "",
    "## Quick Stats",
    "",
    `- Routes: **${routeCount}**`,
    `- Models: **${modelCount}**`,
    `- Relations: **${relationCount}**`,
    `- Env vars: **${requiredEnvCount}** required, **${optionalEnvCount}** with defaults or usage fallbacks`,
    `- Middleware: **${middlewareCount}**`,
    `- Components: **${componentCount}**`,
    `- Libraries: **${libraryCount}**`,
    `- Conflicts: **${conflicts.length}**`,
    "",
    "## Notes",
    "",
    "- This compatibility wiki is a derived view. Canonical data lives in `.codemap/claims`, `.codemap/evidence`, and `.codemap/verification`.",
    "- Use these articles for migration safety and legacy consumer support, not as the system of record.",
    "",
    "---",
    `_Backed by CodeMap claims · ${articles.length} articles_`,
  ];

  return {
    path: CODEMAP_FILES.compatibilityWikiIndex,
    title: "Index",
    markdown: lines.join("\n"),
    claimIds: claims.map((claim) => claim.id),
  };
}

export function renderCompatibilityWiki(input: CompatibilityWikiInput): RenderedView[] {
  const snapshotsById = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const routeClaims = buildRouteClaims(input.claims, snapshotsById);
  const modelClaims = buildModelClaims(input.claims, snapshotsById);
  const relationClaims = buildRelationClaims(input.claims, snapshotsById);
  const hotspotClaims = buildHotspotClaims(input.claims, snapshotsById);
  const envClaims = buildEnvClaims(input.claims, snapshotsById);
  const middlewareClaims = buildMiddlewareClaims(input.claims, snapshotsById);
  const componentClaims = buildComponentClaims(input.claims, snapshotsById);
  const libraryClaims = buildLibraryClaims(input.claims, snapshotsById);
  const domains = detectDomains(routeClaims);
  const usedSlugs = new Set<string>();
  const domainViews = domains.map((domain) => {
    const baseSlug = safeFilename(domain.name);
    let slug = baseSlug;
    let index = 2;
    while (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${index++}`;
    }
    usedSlugs.add(slug);
    return renderDomainView(domain, hotspotClaims, middlewareClaims, input.conflicts, slug);
  });
  const overviewView = renderOverviewView(
    input.projectName,
    input.generatedAt,
    routeClaims,
    modelClaims,
    relationClaims,
    hotspotClaims,
    envClaims,
    middlewareClaims,
    componentClaims,
    libraryClaims,
    input.conflicts,
    domains,
  );
  const otherViews = [overviewView];

  if (modelClaims.length > 0 || relationClaims.length > 0) {
    otherViews.push(renderDatabaseView(input.generatedAt, modelClaims, relationClaims, hotspotClaims, input.conflicts));
  }

  if (componentClaims.length > 0) {
    otherViews.push(renderUiView(componentClaims));
  }

  if (libraryClaims.length >= COMPATIBILITY_LIBRARY_THRESHOLD) {
    otherViews.push(renderLibrariesView(libraryClaims));
  }

  otherViews.push(...domainViews.sort((left, right) => left.path.localeCompare(right.path)));

  const allClaims = [
    ...routeClaims,
    ...modelClaims,
    ...relationClaims,
    ...hotspotClaims,
    ...envClaims,
    ...middlewareClaims,
    ...componentClaims,
    ...libraryClaims,
  ].map((entry) => entry.claim);
  const indexView = renderIndexView(
    input.projectName,
    input.generatedAt,
    allClaims,
    envClaims,
    middlewareClaims,
    input.conflicts,
    otherViews,
  );

  return [indexView, ...otherViews];
}
