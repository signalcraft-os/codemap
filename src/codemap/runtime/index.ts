import { basename, extname } from "node:path";
import type { ImportEdge } from "../../types.js";
import { CODEMAP_FILES, CODEMAP_ROOT_DIR } from "../model/layout.js";
import type { Claim, ClaimType, SourceSnapshot } from "../model/types.js";
import { readJsonFile, resolveCodemapPath, writeJsonFile } from "../store/fs.js";

export type CodemapTrigger = "cli" | "watch" | "mcp" | "hook";
export type CodemapHookPolicy = "shadow" | "warn" | "block";
export type CodemapRefreshMode = "full" | "targeted";
export type CodemapStatusDomain = "code" | "knowledge";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".java", ".kt", ".rs", ".php", ".rb", ".ex", ".exs",
  ".vue", ".svelte",
]);

const UI_EXTENSIONS = new Set([".tsx", ".jsx", ".vue", ".svelte"]);
const KNOWLEDGE_EXTENSIONS = new Set([".md", ".mdx"]);

const FULL_REFRESH_CHANGE_THRESHOLD = 25;
const GLOBAL_WORKSPACE_IMPACT_FILES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "rush.json",
]);

export interface CodemapScanState {
  version: 1;
  domain: CodemapStatusDomain;
  generatedAt: string;
  trigger: CodemapTrigger;
  outputDirName: string;
  changedFiles: string[];
  claims: number;
  snapshots: number;
  evidence: number;
  verificationRecords: number;
  conflicts: number;
  incidents: number;
  views: string[];
  compatibilityViews: string[];
  compatibilityParity: {
    legacyWikiPresent: boolean;
    matched: number;
    drifted: number;
    missingCompatibility: number;
    extraCompatibility: number;
  };
  refresh: {
    mode: CodemapRefreshMode;
    impactedClaimTypes: ClaimType[];
    targetedClaimCount: number;
    targetedSourceCount: number;
  };
}

export interface CodemapScanStateInput {
  domain?: CodemapStatusDomain;
  generatedAt: string;
  trigger?: CodemapTrigger;
  outputDirName?: string;
  changedFiles?: string[];
  claims: number;
  snapshots: number;
  evidence: number;
  verificationRecords: number;
  conflicts: number;
  incidents: number;
  views: string[];
  compatibilityViews: string[];
  compatibilityParity: {
    legacyWikiPresent: boolean;
    matched: number;
    drifted: number;
    missingCompatibility: number;
    extraCompatibility: number;
  };
  refresh: {
    mode: CodemapRefreshMode;
    impactedClaimTypes: ClaimType[];
    targetedClaimCount: number;
    targetedSourceCount: number;
  };
}

export interface CodemapCombinedScanState extends CodemapScanState {
  currentDomain: CodemapStatusDomain;
  domains: Partial<Record<CodemapStatusDomain, CodemapScanState>>;
}

export interface CodemapRefreshReason {
  sourcePath: string;
  impactedClaimTypes: ClaimType[];
  globalImpact: boolean;
  rationale: string;
}

export interface CodemapRefreshPlan {
  version: 1;
  domain: CodemapStatusDomain;
  generatedAt: string;
  trigger: CodemapTrigger;
  mode: CodemapRefreshMode;
  changedFiles: string[];
  impactedClaimTypes: ClaimType[];
  targetedClaimCount: number;
  targetedClaimIds: string[];
  targetedSourceCount: number;
  targetedSourcePaths: string[];
  reasons: CodemapRefreshReason[];
}

export interface CodemapRefreshPlanInput {
  domain?: CodemapStatusDomain;
  generatedAt: string;
  trigger?: CodemapTrigger;
  changedFiles?: string[];
  claims: Claim[];
  snapshots: SourceSnapshot[];
}

export interface CodemapCombinedRefreshPlan extends CodemapRefreshPlan {
  currentDomain: CodemapStatusDomain;
  domains: Partial<Record<CodemapStatusDomain, CodemapRefreshPlan>>;
}

export interface CodemapImpactWorkspace {
  name: string;
  dir: string;
  dependsOn: string[];
}

export interface CodemapImpactIndex {
  version: 1;
  generatedAt: string;
  sourceEdges: ImportEdge[];
  workspaces: CodemapImpactWorkspace[];
}

export interface CodemapImpactIndexInput {
  generatedAt: string;
  sourceEdges?: ImportEdge[];
  workspaces?: CodemapImpactWorkspace[];
}

export interface CodemapSourceImpactOptions {
  maxDepth?: number;
}

interface ClassifiedRefreshPath {
  sourcePath: string;
  impactedClaimTypes: ClaimType[];
  globalImpact: boolean;
  rationale: string;
}

export interface CodemapHookScriptOptions {
  outputDirName: string;
  includeWiki?: boolean;
  includeCodemap?: boolean;
  defaultPolicy?: CodemapHookPolicy;
}

function sanitizeOutputDir(outputDirName: string): string {
  return outputDirName.replace(/[^a-zA-Z0-9._/-]/g, "");
}

function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeImportEdge(edge: ImportEdge): ImportEdge {
  return {
    from: normalizeSourcePath(edge.from),
    to: normalizeSourcePath(edge.to),
  };
}

function normalizeWorkspace(workspace: CodemapImpactWorkspace): CodemapImpactWorkspace {
  return {
    name: workspace.name,
    dir: normalizeSourcePath(workspace.dir),
    dependsOn: [...new Set((workspace.dependsOn ?? []).filter(Boolean))].sort(),
  };
}

function uniqueClaimTypes(types: ClaimType[]): ClaimType[] {
  return [...new Set(types)].sort();
}

function compareGeneratedAt(
  left: { generatedAt: string; domain: CodemapStatusDomain },
  right: { generatedAt: string; domain: CodemapStatusDomain },
): number {
  return left.generatedAt.localeCompare(right.generatedAt) || left.domain.localeCompare(right.domain);
}

function getScanStateFileForDomain(domain: CodemapStatusDomain): string {
  return domain === "knowledge" ? CODEMAP_FILES.knowledgeScanState : CODEMAP_FILES.codeScanState;
}

function getRefreshPlanFileForDomain(domain: CodemapStatusDomain): string {
  return domain === "knowledge" ? CODEMAP_FILES.knowledgeRefreshPlan : CODEMAP_FILES.codeRefreshPlan;
}

function buildCombinedCodemapScanState(
  domains: Partial<Record<CodemapStatusDomain, CodemapScanState>>,
): CodemapCombinedScanState | null {
  const entries = Object.values(domains)
    .filter((state): state is CodemapScanState => Boolean(state))
    .sort(compareGeneratedAt);
  const current = entries.at(-1);
  if (!current) {
    return null;
  }

  return {
    ...current,
    currentDomain: current.domain,
    domains,
  };
}

function buildCombinedCodemapRefreshPlan(
  domains: Partial<Record<CodemapStatusDomain, CodemapRefreshPlan>>,
): CodemapCombinedRefreshPlan | null {
  const entries = Object.values(domains)
    .filter((plan): plan is CodemapRefreshPlan => Boolean(plan))
    .sort(compareGeneratedAt);
  const current = entries.at(-1);
  if (!current) {
    return null;
  }

  return {
    ...current,
    currentDomain: current.domain,
    domains,
  };
}

function classifyChangedPath(sourcePath: string): ClassifiedRefreshPath {
  const normalized = normalizeSourcePath(sourcePath);
  const lowerPath = normalized.toLowerCase();
  const fileName = basename(lowerPath);
  const extension = extname(lowerPath);
  const impactedClaimTypes = new Set<ClaimType>();
  let globalImpact = false;
  const rationaleParts: string[] = [];

  if (CODE_EXTENSIONS.has(extension)) {
    impactedClaimTypes.add("route");
    impactedClaimTypes.add("library_module");
    impactedClaimTypes.add("env_var");
    impactedClaimTypes.add("dependency_hotspot");
    rationaleParts.push("code file changed");
    rationaleParts.push("environment usage may have changed");
  }

  if (UI_EXTENSIONS.has(extension)) {
    impactedClaimTypes.add("component");
    rationaleParts.push("UI component source changed");
  }

  if (KNOWLEDGE_EXTENSIONS.has(extension)) {
    impactedClaimTypes.add("knowledge_decision");
    impactedClaimTypes.add("knowledge_question");
    impactedClaimTypes.add("knowledge_person");
    impactedClaimTypes.add("knowledge_theme");
    impactedClaimTypes.add("knowledge_summary");
    rationaleParts.push("knowledge note changed");
  }

  if (
    extension === ".prisma"
    || lowerPath.includes("/schema/")
    || lowerPath.includes("schema.")
    || lowerPath.includes("openapi")
    || lowerPath.includes("swagger")
    || lowerPath.includes("drizzle")
  ) {
    impactedClaimTypes.add("model");
    impactedClaimTypes.add("relation");
    rationaleParts.push("schema or contract source changed");
  }

  if (lowerPath.includes("/middleware/") || fileName.includes("middleware")) {
    impactedClaimTypes.add("middleware");
    rationaleParts.push("middleware source changed");
  }

  if (fileName === "package.json") {
    impactedClaimTypes.add("config_file");
    impactedClaimTypes.add("package_dependency");
    globalImpact = true;
    rationaleParts.push("package manifest changed");
  }

  if (
    fileName.startsWith(".env")
    || fileName === ".env"
    || fileName === ".env.example"
  ) {
    impactedClaimTypes.add("env_var");
    impactedClaimTypes.add("config_file");
    globalImpact = true;
    rationaleParts.push("environment configuration changed");
  }

  if (
    fileName.startsWith("tsconfig")
    || fileName.endsWith(".config.ts")
    || fileName.endsWith(".config.js")
    || fileName.endsWith(".config.mjs")
    || fileName.endsWith(".config.cjs")
    || fileName.endsWith(".config.json")
    || fileName.endsWith(".yaml")
    || fileName.endsWith(".yml")
    || fileName.endsWith(".toml")
  ) {
    impactedClaimTypes.add("config_file");
    rationaleParts.push("configuration source changed");
  }

  return {
    sourcePath: normalized,
    impactedClaimTypes: uniqueClaimTypes([...impactedClaimTypes]),
    globalImpact,
    rationale: rationaleParts.join("; ") || "changed file requires conservative refresh",
  };
}

export function buildHotspotRefreshSourcePaths(
  changedFiles: string[],
  currentEdges: ImportEdge[] = [],
  previousEdges: ImportEdge[] = [],
): string[] {
  return collectImpactedSourcePaths(
    buildCodemapImpactIndex({
      generatedAt: "",
      sourceEdges: [...currentEdges, ...previousEdges],
    }),
    changedFiles,
    { maxDepth: 1 },
  );
}

export function buildCodemapImpactIndex(input: CodemapImpactIndexInput): CodemapImpactIndex {
  const sourceEdges = [...new Map(
    (input.sourceEdges ?? [])
      .map(normalizeImportEdge)
      .filter((edge) => edge.from.length > 0 && edge.to.length > 0)
      .map((edge) => [`${edge.from}->${edge.to}`, edge] as const),
  ).values()].sort((left, right) =>
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
  const workspaces = [...new Map(
    (input.workspaces ?? [])
      .map(normalizeWorkspace)
      .map((workspace) => [workspace.name, workspace] as const),
  ).values()].sort((left, right) => left.name.localeCompare(right.name));

  return {
    version: 1,
    generatedAt: input.generatedAt,
    sourceEdges,
    workspaces,
  };
}

export function collectImpactedSourcePaths(
  index: CodemapImpactIndex,
  changedFiles: string[],
  options: CodemapSourceImpactOptions = {},
): string[] {
  const normalizedChangedFiles = [...new Set(changedFiles.map(normalizeSourcePath).filter(Boolean))].sort();
  if (normalizedChangedFiles.length === 0) {
    return [];
  }

  const maxDepth = Math.max(options.maxDepth ?? 1, 0);
  const adjacency = new Map<string, Set<string>>();
  for (const edge of index.sourceEdges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, new Set());
    }
    if (!adjacency.has(edge.to)) {
      adjacency.set(edge.to, new Set());
    }
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
  }

  const visited = new Set(normalizedChangedFiles);
  const queue = normalizedChangedFiles.map((sourcePath) => ({ sourcePath, depth: 0 }));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) {
      continue;
    }

    for (const neighbor of adjacency.get(current.sourcePath) ?? []) {
      if (visited.has(neighbor)) {
        continue;
      }
      visited.add(neighbor);
      queue.push({ sourcePath: neighbor, depth: current.depth + 1 });
    }
  }

  return [...visited].sort();
}

function findOwningWorkspace(
  sourcePath: string,
  workspaces: CodemapImpactWorkspace[],
): CodemapImpactWorkspace | null {
  const normalized = normalizeSourcePath(sourcePath);
  const matches = workspaces.filter((workspace) => {
    if (!workspace.dir || workspace.dir === ".") {
      return false;
    }
    return normalized === workspace.dir || normalized.startsWith(`${workspace.dir}/`);
  });

  if (matches.length === 0) {
    return null;
  }

  return matches.sort((left, right) => right.dir.length - left.dir.length)[0];
}

function isGlobalWorkspaceImpactPath(sourcePath: string): boolean {
  const normalized = normalizeSourcePath(sourcePath);
  const fileName = basename(normalized).toLowerCase();
  if (normalized.includes("/")) {
    return false;
  }

  return GLOBAL_WORKSPACE_IMPACT_FILES.has(fileName)
    || fileName.startsWith("tsconfig")
    || fileName.endsWith(".config.ts")
    || fileName.endsWith(".config.js")
    || fileName.endsWith(".config.mjs")
    || fileName.endsWith(".config.cjs")
    || fileName.endsWith(".config.json");
}

export function collectImpactedWorkspaces(
  index: CodemapImpactIndex,
  changedFiles: string[],
): string[] {
  const normalizedChangedFiles = [...new Set(changedFiles.map(normalizeSourcePath).filter(Boolean))].sort();
  if (normalizedChangedFiles.length === 0 || index.workspaces.length === 0) {
    return [];
  }

  if (normalizedChangedFiles.some(isGlobalWorkspaceImpactPath)) {
    return index.workspaces.map((workspace) => workspace.name).sort();
  }

  const owners = new Set<string>();
  for (const changedFile of normalizedChangedFiles) {
    const owner = findOwningWorkspace(changedFile, index.workspaces);
    if (!owner) {
      return index.workspaces.map((workspace) => workspace.name).sort();
    }
    owners.add(owner.name);
  }

  const reverseDependencies = new Map<string, Set<string>>();
  for (const workspace of index.workspaces) {
    for (const dependency of workspace.dependsOn) {
      if (!reverseDependencies.has(dependency)) {
        reverseDependencies.set(dependency, new Set());
      }
      reverseDependencies.get(dependency)!.add(workspace.name);
    }
  }

  const impacted = new Set<string>(owners);
  const queue = [...owners];
  while (queue.length > 0) {
    const workspaceName = queue.shift()!;
    for (const dependent of reverseDependencies.get(workspaceName) ?? []) {
      if (impacted.has(dependent)) {
        continue;
      }
      impacted.add(dependent);
      queue.push(dependent);
    }
  }

  return [...impacted].sort();
}

export function buildCodemapScanState(input: CodemapScanStateInput): CodemapScanState {
  return {
    version: 1,
    domain: input.domain ?? "code",
    generatedAt: input.generatedAt,
    trigger: input.trigger ?? "cli",
    outputDirName: input.outputDirName ?? ".codesight",
    changedFiles: [...new Set(input.changedFiles ?? [])].sort(),
    claims: input.claims,
    snapshots: input.snapshots,
    evidence: input.evidence,
    verificationRecords: input.verificationRecords,
    conflicts: input.conflicts,
    incidents: input.incidents,
    views: [...new Set(input.views)].sort(),
    compatibilityViews: [...new Set(input.compatibilityViews)].sort(),
    compatibilityParity: {
      legacyWikiPresent: input.compatibilityParity.legacyWikiPresent,
      matched: input.compatibilityParity.matched,
      drifted: input.compatibilityParity.drifted,
      missingCompatibility: input.compatibilityParity.missingCompatibility,
      extraCompatibility: input.compatibilityParity.extraCompatibility,
    },
    refresh: {
      mode: input.refresh.mode,
      impactedClaimTypes: uniqueClaimTypes(input.refresh.impactedClaimTypes),
      targetedClaimCount: input.refresh.targetedClaimCount,
      targetedSourceCount: input.refresh.targetedSourceCount,
    },
  };
}

export async function writeCodemapScanState(
  repoRoot: string,
  state: CodemapScanState,
): Promise<CodemapCombinedScanState> {
  await writeJsonFile(resolveCodemapPath(repoRoot, getScanStateFileForDomain(state.domain)), state);
  const [codeState, knowledgeState] = await Promise.all([
    readJsonFile<CodemapScanState>(resolveCodemapPath(repoRoot, CODEMAP_FILES.codeScanState)),
    readJsonFile<CodemapScanState>(resolveCodemapPath(repoRoot, CODEMAP_FILES.knowledgeScanState)),
  ]);
  const combined = buildCombinedCodemapScanState({
    code: codeState ?? undefined,
    knowledge: knowledgeState ?? undefined,
  }) ?? {
    ...state,
    currentDomain: state.domain,
    domains: { [state.domain]: state },
  };
  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.scanState), combined);
  return combined;
}

export function buildCodemapRefreshPlan(input: CodemapRefreshPlanInput): CodemapRefreshPlan {
  const claims = [...input.claims];
  const changedFiles = [...new Set((input.changedFiles ?? []).map(normalizeSourcePath))].sort();
  const mode: CodemapRefreshMode = changedFiles.length === 0 || changedFiles.length > FULL_REFRESH_CHANGE_THRESHOLD
    ? "full"
    : "targeted";

  const snapshotsById = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const reasonEntries = changedFiles.map(classifyChangedPath);
  const impactedClaimTypes = new Set<ClaimType>();
  const targetedClaimIds = new Set<string>();
  const targetedSourcePaths = new Set<string>();

  if (mode === "full") {
    for (const claim of claims) {
      impactedClaimTypes.add(claim.type);
      targetedClaimIds.add(claim.id);
    }
    for (const snapshot of input.snapshots) {
      targetedSourcePaths.add(normalizeSourcePath(snapshot.sourcePath));
    }
  } else {
    const globallyImpactedTypes = new Set<ClaimType>();

    for (const reason of reasonEntries) {
      targetedSourcePaths.add(reason.sourcePath);
      for (const type of reason.impactedClaimTypes) {
        impactedClaimTypes.add(type);
        if (reason.globalImpact) {
          globallyImpactedTypes.add(type);
        }
      }
    }

    for (const claim of claims) {
      const claimSnapshots = claim.sourceSnapshotIds
        .map((snapshotId) => snapshotsById.get(snapshotId))
        .filter((snapshot): snapshot is SourceSnapshot => Boolean(snapshot));
      const claimSourcePaths = claimSnapshots.map((snapshot) => normalizeSourcePath(snapshot.sourcePath));
      const directMatch = claimSourcePaths.some((sourcePath) => changedFiles.includes(sourcePath));
      const typeMatch = globallyImpactedTypes.has(claim.type);

      if (directMatch || typeMatch) {
        targetedClaimIds.add(claim.id);
        impactedClaimTypes.add(claim.type);
        for (const sourcePath of claimSourcePaths) {
          targetedSourcePaths.add(sourcePath);
        }
      }
    }
  }

  return {
    version: 1,
    domain: input.domain ?? "code",
    generatedAt: input.generatedAt,
    trigger: input.trigger ?? "cli",
    mode,
    changedFiles,
    impactedClaimTypes: uniqueClaimTypes([...impactedClaimTypes]),
    targetedClaimCount: targetedClaimIds.size,
    targetedClaimIds: [...targetedClaimIds].sort().slice(0, 50),
    targetedSourceCount: targetedSourcePaths.size,
    targetedSourcePaths: [...targetedSourcePaths].sort().slice(0, 50),
    reasons: reasonEntries.map((reason) => ({
      sourcePath: reason.sourcePath,
      impactedClaimTypes: uniqueClaimTypes(reason.impactedClaimTypes),
      globalImpact: reason.globalImpact,
      rationale: reason.rationale,
    })),
  };
}

export async function writeCodemapRefreshPlan(
  repoRoot: string,
  plan: CodemapRefreshPlan,
): Promise<CodemapCombinedRefreshPlan> {
  await writeJsonFile(resolveCodemapPath(repoRoot, getRefreshPlanFileForDomain(plan.domain)), plan);
  const [codePlan, knowledgePlan] = await Promise.all([
    readJsonFile<CodemapRefreshPlan>(resolveCodemapPath(repoRoot, CODEMAP_FILES.codeRefreshPlan)),
    readJsonFile<CodemapRefreshPlan>(resolveCodemapPath(repoRoot, CODEMAP_FILES.knowledgeRefreshPlan)),
  ]);
  const combined = buildCombinedCodemapRefreshPlan({
    code: codePlan ?? undefined,
    knowledge: knowledgePlan ?? undefined,
  }) ?? {
    ...plan,
    currentDomain: plan.domain,
    domains: { [plan.domain]: plan },
  };
  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.refreshPlan), combined);
  return combined;
}

export function summarizeCodemapRefreshPlan(plan: CodemapRefreshPlan): string {
  const types = plan.impactedClaimTypes.length > 0 ? plan.impactedClaimTypes.join(", ") : "none";
  return `${plan.mode} refresh: ${plan.targetedClaimCount} targeted claims across ${plan.targetedSourceCount} source files (${types})`;
}

export function buildGitHookScript(options: CodemapHookScriptOptions): string {
  const safeOutputDir = sanitizeOutputDir(options.outputDirName);
  const includeWiki = options.includeWiki ?? true;
  const includeCodemap = options.includeCodemap ?? false;
  const defaultPolicy = options.defaultPolicy ?? "warn";

  const commandParts = ["npx", "codesight"];
  if (includeWiki) {
    commandParts.push("--wiki");
  }
  if (includeCodemap) {
    commandParts.push("--codemap", "--hook-run");
  }
  commandParts.push("-o", safeOutputDir);

  const addTargets = includeCodemap ? `${safeOutputDir}/ ${CODEMAP_ROOT_DIR}/` : `${safeOutputDir}/`;
  const lines = [
    "",
    "# codesight: begin",
    "# codesight: regenerate AI context",
    commandParts.join(" "),
    `git add ${addTargets}`,
  ];

  if (includeCodemap) {
    const incidentsPath = `${CODEMAP_ROOT_DIR}/publish/incidents.ndjson`;
    const knowledgeIncidentsPath = `${CODEMAP_ROOT_DIR}/publish/knowledge-incidents.ndjson`;
    const dollar = "$";
    lines.push(
      `CODEMAP_POLICY=\"\${CODESIGHT_CODEMAP_POLICY:-${defaultPolicy}}\"`,
      "CODEMAP_HIGH=0",
      "CODEMAP_MEDIUM=0",
      "CODEMAP_LOW=0",
      `for CODEMAP_FILE in "${incidentsPath}" "${knowledgeIncidentsPath}"; do`,
      `  if [ -f "${dollar}CODEMAP_FILE" ] && [ -s "${dollar}CODEMAP_FILE" ]; then`,
      `    CODEMAP_FILE_HIGH=$(grep -c '"severity":"high"' "${dollar}CODEMAP_FILE" 2>/dev/null)`,
      `    CODEMAP_FILE_MEDIUM=$(grep -c '"severity":"medium"' "${dollar}CODEMAP_FILE" 2>/dev/null)`,
      `    CODEMAP_FILE_LOW=$(grep -c '"severity":"low"' "${dollar}CODEMAP_FILE" 2>/dev/null)`,
      `    [ -z "${dollar}CODEMAP_FILE_HIGH" ] && CODEMAP_FILE_HIGH=0`,
      `    [ -z "${dollar}CODEMAP_FILE_MEDIUM" ] && CODEMAP_FILE_MEDIUM=0`,
      `    [ -z "${dollar}CODEMAP_FILE_LOW" ] && CODEMAP_FILE_LOW=0`,
      "    CODEMAP_HIGH=$((CODEMAP_HIGH + CODEMAP_FILE_HIGH))",
      "    CODEMAP_MEDIUM=$((CODEMAP_MEDIUM + CODEMAP_FILE_MEDIUM))",
      "    CODEMAP_LOW=$((CODEMAP_LOW + CODEMAP_FILE_LOW))",
      "  fi",
      "done",
      `if [ "${dollar}CODEMAP_HIGH" -gt 0 ] || [ "${dollar}CODEMAP_MEDIUM" -gt 0 ] || [ "${dollar}CODEMAP_LOW" -gt 0 ]; then`,
      `  if [ "$CODEMAP_POLICY" = "block" ] && [ "${dollar}CODEMAP_HIGH" -gt 0 ]; then`,
      `    echo "codesight: blocking commit due to ${dollar}CODEMAP_HIGH high-severity CodeMap incident(s). Run codesight --codemap to inspect."`,
      "    exit 1",
      "  fi",
      `  if [ "$CODEMAP_POLICY" = "warn" ] && [ "${dollar}CODEMAP_HIGH" -gt 0 ]; then`,
      `    echo "codesight: warning ${dollar}CODEMAP_HIGH high-severity CodeMap incident(s). Set CODESIGHT_CODEMAP_POLICY=block to enforce."`,
      "  fi",
      `  if [ "$CODEMAP_POLICY" = "warn" ] && [ "${dollar}CODEMAP_MEDIUM" -gt 0 ]; then`,
      `    echo "codesight: warning ${dollar}CODEMAP_MEDIUM medium-severity CodeMap incident(s)."`,
      "  fi",
      `  if [ "$CODEMAP_POLICY" = "shadow" ]; then`,
      `    echo "codesight: shadow mode observed CodeMap incidents (high=${dollar}CODEMAP_HIGH medium=${dollar}CODEMAP_MEDIUM low=${dollar}CODEMAP_LOW); commit allowed."`,
      "  fi",
      "fi",
    );
  }

  lines.push("# codesight: end");

  return `${lines.join("\n")}\n`;
}

export function getWatchIgnoreDirs(outputDirName: string): string[] {
  return [...new Set([
    "node_modules",
    ".git",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "out",
    ".output",
    "coverage",
    ".turbo",
    ".vercel",
    ".cache",
    outputDirName,
    CODEMAP_ROOT_DIR,
  ])];
}

export function summarizeChangedFiles(changedFiles: string[]): string {
  const normalized = [...new Set(changedFiles)].sort();
  if (normalized.length === 0) {
    return "no tracked changes";
  }
  if (normalized.length <= 5) {
    return normalized.join(", ");
  }
  return `${normalized.length} files`;
}
