<!-- codemap-claude-md-section-begin -->
## CodeMap (project memory)

This section applies whenever the current project has a `.codemap/` directory at its root. If `.codemap/` does not exist, ignore this entire section — the project hasn't adopted CodeMap.

When `.codemap/` exists, treat it as the canonical truth for what the codebase contains and what engineering decisions have been made — not your own re-reading of source files.

**At the start of every engineering session:**
1. Call the `codemap_get_overview` MCP tool — orients you to the current claim graph.
2. Call `codemap_get_knowledge_overview` — surfaces decisions, open questions, themes.
3. If MCP tools aren't available, read `.codemap/views/index.md` and `.codemap/views/knowledge/overview.md` directly.

**When the user makes an engineering decision** (picks a tool, library, architecture, scope cut, name, deprecation, etc.):
- Call `codemap_record_decision` with `subject`, `decision`, optional `rationale`, optional `related_source_paths`, optional `supersedes`.
- Use the user's near-verbatim words for `decision`. You are transcribing, not synthesizing.
- Confirm to the user with the file path the tool returned, so they can edit if you got it wrong.

**When proposing engineering changes:**
- Use `codemap_search_claims` (code) and `codemap_search_knowledge` (decisions/questions/themes) instead of grepping source.
- Cite claim IDs in your reasoning when relying on an existing claim. e.g. "per `claim:xxxxx`, the auth middleware is JWT-based."
- If `codemap_get_publish_status` reports incidents, look at them before proposing changes that touch the affected claims.

**When you encounter conflicting or stale information:**
- Surface the conflict to the user. Don't pick a winner silently.
- `codemap_get_conflicts` returns the unresolved conflict edges with both sides and a rationale.

**Never:**
- Trust a rendered summary as evidence for a new claim. Re-ground on raw source via `codemap_get_claim_evidence`.
- Skip recording a decision because "it's small." If the user changed direction on engineering, record it.

**Refresh:** if `.codemap/` data looks stale, run `codesight --codemap` from the project root to re-publish claims. Project owners can also install a pre-commit hook (`codesight --hook --codemap`) to keep it fresh automatically.
<!-- codemap-claude-md-section-end -->
