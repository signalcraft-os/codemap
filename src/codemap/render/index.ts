import type { Claim, ConflictEdge, RenderedView } from "../model/types.js";

export interface ViewRendererInput {
  title: string;
  claims: Claim[];
  conflicts: ConflictEdge[];
}

export interface ViewRenderer {
  render(input: ViewRendererInput): Promise<RenderedView>;
}

export * from "./views/index.js";
