import { writeFile, mkdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { scan } from "../core.js";
import { CODEMAP_FILES } from "../codemap/model/layout.js";
import {
  buildCodemapImpactIndex,
  collectImpactedWorkspaces,
  type CodemapImpactIndex,
  type CodemapTrigger,
} from "../codemap/runtime/index.js";
import { readJsonFile, resolveCodemapPath, writeJsonFile } from "../codemap/store/fs.js";
import { discoverPackages, type PackageInfo } from "./discover.js";
import { extractCrossPackageDeps, writeDepsFile } from "./deps.js";
import type { CodesightConfig } from "../types.js";

const GLOBAL_INDEX_FILENAME = "CODESIGHT.md";

export interface MonorepoScanOptions {
  changedFiles?: string[];
  includeCodemap?: boolean;
  trigger?: CodemapTrigger;
}

function toPortablePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalizeSourcePath(path: string): string {
  return toPortablePath(path).replace(/^\.\//, "");
}

function packageDirFromRoot(root: string, packageDir: string): string {
  return normalizeSourcePath(relative(root, packageDir));
}

function getPackageChangedFiles(root: string, packageDir: string, changedFiles: string[] = []): string[] {
  const packagePath = packageDirFromRoot(root, packageDir);
  if (!packagePath) {
    return [];
  }

  return [...new Set(
    changedFiles
      .map(normalizeSourcePath)
      .filter((changedFile) => changedFile === packagePath || changedFile.startsWith(`${packagePath}/`))
      .map((changedFile) => changedFile.slice(packagePath.length + 1))
      .filter(Boolean),
  )].sort();
}

function buildWorkspaceEntries(root: string, packages: PackageInfo[], depsByName: Map<string, string[]>) {
  return packages.map((pkg) => ({
    name: pkg.name,
    dir: packageDirFromRoot(root, pkg.dir),
    dependsOn: depsByName.get(pkg.name) ?? [],
  }));
}

function packageDependencyMapFromIndex(index: CodemapImpactIndex | null): Map<string, string[]> {
  return new Map(
    (index?.workspaces ?? []).map((workspace) => [workspace.name, [...workspace.dependsOn].sort()] as const),
  );
}

function impactIndexMatchesPackages(root: string, packages: PackageInfo[], index: CodemapImpactIndex | null): boolean {
  if (!index) {
    return false;
  }

  const expected = packages
    .map((pkg) => ({ name: pkg.name, dir: packageDirFromRoot(root, pkg.dir) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const actual = index.workspaces
    .map((workspace) => ({ name: workspace.name, dir: normalizeSourcePath(workspace.dir) }))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (expected.length !== actual.length) {
    return false;
  }

  return expected.every((workspace, indexPosition) =>
    workspace.name === actual[indexPosition]?.name
    && workspace.dir === actual[indexPosition]?.dir,
  );
}

async function readMonorepoImpactIndex(root: string): Promise<CodemapImpactIndex | null> {
  return readJsonFile<CodemapImpactIndex>(resolveCodemapPath(root, CODEMAP_FILES.impactIndex));
}

async function buildPackageDependencyMap(
  packages: PackageInfo[],
  allPackageNames: string[],
): Promise<Map<string, string[]>> {
  const depsByName = new Map<string, string[]>();
  for (const pkg of packages) {
    depsByName.set(pkg.name, await extractCrossPackageDeps(pkg.dir, allPackageNames));
  }
  return depsByName;
}

async function ensureMonorepoImpactIndex(
  root: string,
  packages: PackageInfo[],
  allPackageNames: string[],
): Promise<CodemapImpactIndex> {
  const existing = await readMonorepoImpactIndex(root);
  if (impactIndexMatchesPackages(root, packages, existing)) {
    return existing!;
  }

  const depsByName = await buildPackageDependencyMap(packages, allPackageNames);
  const impactIndex = buildCodemapImpactIndex({
    generatedAt: new Date().toISOString(),
    workspaces: buildWorkspaceEntries(root, packages, depsByName),
  });
  await writeJsonFile(resolveCodemapPath(root, CODEMAP_FILES.impactIndex), impactIndex);
  return impactIndex;
}

async function writeMonorepoImpactIndex(
  root: string,
  packages: PackageInfo[],
  depsByName: Map<string, string[]>,
  generatedAt: string,
): Promise<CodemapImpactIndex> {
  const impactIndex = buildCodemapImpactIndex({
    generatedAt,
    workspaces: buildWorkspaceEntries(root, packages, depsByName),
  });
  await writeJsonFile(resolveCodemapPath(root, CODEMAP_FILES.impactIndex), impactIndex);
  return impactIndex;
}

async function scanPackage(
  root: string,
  pkg: PackageInfo,
  allPackageNames: string[],
  outputDirName: string,
  maxDepth: number,
  userConfig: CodesightConfig,
  options: MonorepoScanOptions,
): Promise<string[]> {
  const result = await scan(pkg.dir, outputDirName, maxDepth, userConfig, true /* quiet */);
  const deps = await extractCrossPackageDeps(pkg.dir, allPackageNames);
  await writeDepsFile(pkg.dir, deps, outputDirName);

  if (options.includeCodemap) {
    const { publishCodeCodemap } = await import("../codemap/publish/code-pipeline.js");
    await publishCodeCodemap(result, {
      changedFiles: getPackageChangedFiles(root, pkg.dir, options.changedFiles),
      outputDirName,
      trigger: options.trigger ?? (options.changedFiles?.length ? "watch" : "cli"),
    });
  }

  return deps;
}

/**
 * Run the full monorepo scan or refresh a single named package.
 * When targetPackage is provided, only that package is (re)scanned.
 */
export async function runMonorepoScan(
  root: string,
  userConfig: CodesightConfig,
  targetPackage?: string,
  options: MonorepoScanOptions = {},
): Promise<PackageInfo[]> {
  const monorepoConfig = userConfig.monorepo ?? {};
  const outputDirName = userConfig.outputDir ?? ".codesight";
  const maxDepth = userConfig.maxDepth ?? 10;

  const allPackages = await discoverPackages(root, monorepoConfig);
  const allPackageNames = allPackages.map((pkg) => pkg.name);
  let packages = [...allPackages];
  let depsByName = new Map<string, string[]>();

  if (targetPackage) {
    const match = packages.find((pkg) => pkg.name === targetPackage);
    if (!match) {
      console.warn(`  codesight --refresh: package "${targetPackage}" not found or filtered out.`);
      return [];
    }
    packages = [match];
    depsByName = packageDependencyMapFromIndex(await ensureMonorepoImpactIndex(root, allPackages, allPackageNames));
  } else if ((options.changedFiles?.length ?? 0) > 0) {
    const impactIndex = await ensureMonorepoImpactIndex(root, allPackages, allPackageNames);
    depsByName = packageDependencyMapFromIndex(impactIndex);
    const impactedWorkspaceNames = new Set(collectImpactedWorkspaces(impactIndex, options.changedFiles ?? []));
    if (impactedWorkspaceNames.size > 0) {
      packages = packages.filter((pkg) => impactedWorkspaceNames.has(pkg.name));
    }
  }

  console.log(`\n  codesight monorepo — scanning ${packages.length} package(s)\n`);

  for (const pkg of packages) {
    process.stdout.write(`  [${pkg.name}]...`);
    try {
      const deps = await scanPackage(root, pkg, allPackageNames, outputDirName, maxDepth, userConfig, options);
      depsByName.set(pkg.name, deps);
      console.log(" done");
    } catch (err: any) {
      console.error(` ERROR: ${err.message}`);
    }
  }

  if (depsByName.size === 0 && allPackages.length > 0) {
    depsByName = await buildPackageDependencyMap(allPackages, allPackageNames);
  }

  const generatedAt = new Date().toISOString();
  await writeMonorepoImpactIndex(root, allPackages, depsByName, generatedAt);

  await writeGlobalIndex(root, allPackages.map((pkg) => pkg.dir), outputDirName);
  console.log(`\n  Global index updated: ${GLOBAL_INDEX_FILENAME}\n`);

  return packages;
}

async function writeGlobalIndex(
  root: string,
  qualifyingPackageDirs: string[],
  outputDirName: string,
): Promise<void> {
  const confirmed: string[] = [];
  for (const dir of qualifyingPackageDirs) {
    try {
      await stat(join(dir, outputDirName));
      confirmed.push(toPortablePath(relative(root, dir)));
    } catch {}
  }

  confirmed.sort();

  const lines = [
    "# CodeSight — Monorepo Index",
    "",
    "This project uses per-package CodeSight context files. Before using grep/find",
    "to explore a package, check if `.codesight/CODESIGHT.md` exists in that",
    "package's directory — it will be faster and cheaper.",
    "",
    "## Packages with CodeSight context",
    "",
    ...confirmed,
    "",
  ];

  const outDir = join(root, outputDirName);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, GLOBAL_INDEX_FILENAME), lines.join("\n"), "utf-8");
}
