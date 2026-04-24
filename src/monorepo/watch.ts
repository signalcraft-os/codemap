import { watch } from "node:fs";
import { extname } from "node:path";
import { getWatchIgnoreDirs } from "../codemap/runtime/index.js";
import type { CodesightConfig } from "../types.js";
import { runMonorepoScan, type MonorepoScanOptions } from "./orchestrator.js";

const WATCH_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".vue", ".svelte", ".rb",
  ".json", ".yaml", ".yml", ".toml", ".env",
  ".prisma", ".graphql", ".gql",
]);

const DEBOUNCE_MS = 500;

function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Start a single monorepo-root watcher that dispatches file-change events
 * to impact-aware package rebuilds. Runs until SIGINT (Ctrl+C).
 */
export async function watchMonorepo(
  root: string,
  userConfig: CodesightConfig,
  options: MonorepoScanOptions = {},
): Promise<void> {
  const outputDirName = userConfig.outputDir ?? ".codesight";
  const ignoreDirs = new Set(getWatchIgnoreDirs(outputDirName));

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let changedFiles: string[] = [];
  let isScanning = false;

  console.log("  codesight monorepo watch — watching packages (Ctrl+C to stop)\n");

  const flushChanges = async () => {
    if (isScanning) {
      debounceTimer = setTimeout(() => {
        void flushChanges();
      }, DEBOUNCE_MS);
      return;
    }

    isScanning = true;
    const pendingFiles = [...new Set(changedFiles.map(normalizeSourcePath).filter(Boolean))].sort();
    changedFiles = [];

    try {
      await runMonorepoScan(root, userConfig, undefined, {
        ...options,
        changedFiles: pendingFiles,
        trigger: "watch",
      });
    } catch (err: any) {
      console.error(`  watch ERROR: ${err.message}`);
    }

    isScanning = false;
    if (changedFiles.length > 0) {
      debounceTimer = setTimeout(() => {
        void flushChanges();
      }, DEBOUNCE_MS);
    }
  };

  const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
    if (!filename) {
      return;
    }

    const normalizedFilename = normalizeSourcePath(filename);
    const parts = normalizedFilename.split("/");
    if (parts.some((part) => ignoreDirs.has(part) || (part.startsWith(".") && part !== ".env"))) {
      return;
    }

    const extension = extname(normalizedFilename);
    if (!WATCH_EXTENSIONS.has(extension)) {
      return;
    }

    changedFiles.push(normalizedFilename);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      void flushChanges();
    }, DEBOUNCE_MS);
  });

  process.on("SIGINT", () => {
    watcher.close();
    console.log("\n  codesight watch stopped.");
    process.exit(0);
  });

  await new Promise<void>(() => {});
}
