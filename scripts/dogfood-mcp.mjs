// One-off dogfood script: exercises the MCP-layer tools through their formatters.
// Run with `node scripts/dogfood-mcp.mjs` after `corepack pnpm build`.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getCodemapOverview,
  getCodemapKnowledgeOverview,
  searchCodemapClaims,
  getCodemapConflicts,
  getCodemapPublishStatus,
  formatCodemapOverview,
  formatCodemapKnowledgeOverview,
  formatCodemapSearchClaims,
  formatCodemapConflicts,
  formatCodemapPublishStatus,
} from "../dist/codemap/mcp/index.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function banner(title) {
  const bar = "=".repeat(title.length + 4);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

banner("codemap_get_overview");
const overview = await getCodemapOverview(repoRoot);
console.log(formatCodemapOverview(overview));

banner("codemap_get_publish_status");
const status = await getCodemapPublishStatus(repoRoot);
console.log(formatCodemapPublishStatus(status));

banner("codemap_get_conflicts");
const conflicts = await getCodemapConflicts(repoRoot, { limit: 50 });
console.log(formatCodemapConflicts(conflicts));

banner("codemap_search_claims (type=middleware)");
const middleware = await searchCodemapClaims(repoRoot, { type: "middleware", limit: 20 });
console.log(formatCodemapSearchClaims(middleware));

banner("codemap_search_claims (query=middleware)");
const middlewareQ = await searchCodemapClaims(repoRoot, { query: "middleware", limit: 10 });
console.log(formatCodemapSearchClaims(middlewareQ));

banner("codemap_search_claims (type=route)");
const routes = await searchCodemapClaims(repoRoot, { type: "route", limit: 20 });
console.log(formatCodemapSearchClaims(routes));

banner("codemap_search_claims (no filter, limit 5)");
const any = await searchCodemapClaims(repoRoot, { limit: 5 });
console.log(formatCodemapSearchClaims(any));

banner("codemap_get_knowledge_overview");
const knowledge = await getCodemapKnowledgeOverview(repoRoot);
console.log(formatCodemapKnowledgeOverview(knowledge));
