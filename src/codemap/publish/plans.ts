import { CODEMAP_FILES } from "../model/layout.js";
import type { CombinedPublishPlan, PublishPlan } from "../model/types.js";
import { readJsonFile, resolveCodemapPath, writeJsonFile } from "../store/fs.js";

function compareGeneratedAt(
  left: { generatedAt: string; domain: "code" | "knowledge" },
  right: { generatedAt: string; domain: "code" | "knowledge" },
): number {
  return left.generatedAt.localeCompare(right.generatedAt) || left.domain.localeCompare(right.domain);
}

function getPublishPlanFileForDomain(domain: "code" | "knowledge"): string {
  return domain === "knowledge" ? CODEMAP_FILES.knowledgePublishPlan : CODEMAP_FILES.codePublishPlan;
}

export function normalizeCombinedPublishPlan(
  plan: CombinedPublishPlan | PublishPlan | null,
): CombinedPublishPlan | null {
  if (!plan) {
    return null;
  }
  if ("domains" in plan && plan.domains) {
    return plan;
  }
  return {
    ...plan,
    currentDomain: plan.domain,
    domains: {
      [plan.domain]: plan,
    },
  };
}

export function buildCombinedPublishPlan(
  domains: Partial<Record<"code" | "knowledge", PublishPlan>>,
): CombinedPublishPlan | null {
  const entries = Object.values(domains)
    .filter((plan): plan is PublishPlan => Boolean(plan))
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

export async function writeCodemapPublishPlan(
  repoRoot: string,
  plan: PublishPlan,
): Promise<CombinedPublishPlan> {
  await writeJsonFile(resolveCodemapPath(repoRoot, getPublishPlanFileForDomain(plan.domain)), plan);
  const [codePlan, knowledgePlan] = await Promise.all([
    readJsonFile<PublishPlan>(resolveCodemapPath(repoRoot, CODEMAP_FILES.codePublishPlan)),
    readJsonFile<PublishPlan>(resolveCodemapPath(repoRoot, CODEMAP_FILES.knowledgePublishPlan)),
  ]);
  const combined = buildCombinedPublishPlan({
    code: codePlan ?? undefined,
    knowledge: knowledgePlan ?? undefined,
  }) ?? {
    ...plan,
    currentDomain: plan.domain,
    domains: {
      [plan.domain]: plan,
    },
  };
  await writeJsonFile(resolveCodemapPath(repoRoot, CODEMAP_FILES.publishPlan), combined);
  return combined;
}
