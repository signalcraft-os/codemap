import type { RenderedView } from "../model/types.js";

export type CodemapMigrationMode = "shadow" | "dual-write" | "compatibility";

export interface CompatibilityArtifact {
  sourceViewPath: string;
  targetPath: string;
  content: string;
}

export interface CompatibilityRenderer {
  renderCompatibility(views: RenderedView[]): Promise<CompatibilityArtifact[]>;
}

export * from "./compatibility-parity.js";
