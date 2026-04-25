# CodeMap Handoff

Date: 2026-04-25
Branch: `bootstrap-from-codesight`

## Current State

CodeMap is a parallel, hardened successor path to Codesight under `.codemap/`, with legacy behavior preserved.

Implemented and green:
- canonical snapshots, claims, evidence, verification, conflicts
- derived code and knowledge views
- compatibility wiki and `KNOWLEDGE.md` rendering
- dual-write migration and parity reporting
- MCP claim/query/status tools
- incremental refresh planning and lane/file narrowing
- history, archive, compaction, and audit trails
- historical snapshot content storage
- snapshot archive indexing and tiering
- per-snapshot archive sharding (metadata + content shards) with backward-compat bundle reads
- claim-health incidents (stale critical claims, conflicts, conflicting/quarantined claims) flowing into `incidents.ndjson` alongside parity drift
- traceable incidents (`source` + `sourceRecordId` fields point back to the verification record or conflict edge that produced each one)
- severity-aware git-hook gating: `block` blocks only on `high`-severity incidents; `warn` warns on `high` + `medium`; `shadow` reports per-severity counts without exiting non-zero
- `codemap_record_decision` MCP tool: AI sessions persist in-conversation decisions to `notes/decisions/recorded/<timestamp>-<slug>.md`; resulting `knowledge_decision` claims are tagged `recorded` with lower default confidence (0.5 / 0.6) so a human can review and promote
- `[recorded]` marker in `.codemap/views/knowledge/overview.md` for AI-recorded decisions

Latest verification (2026-04-25):
- `corepack pnpm build` passed
- `corepack pnpm test` passed
- result: `121` passing, `0` failing

## Documentation

- [docs/codemap-architecture.md](codemap-architecture.md) — design rationale (the *why*).
- [docs/codemap-quickstart.md](codemap-quickstart.md) — adoption guide: install, hook policy modes, incident sources reference, AI adoption template (the *how*). **Read this if you are adopting CodeMap on a new project.**
- This file — current state and what's next.

## Recent Cumulative Changes (2026-04-23 → 2026-04-25)

Grouped by phase, newest first.

### Conflict surfacing in MCP responses (2026-04-25)
- `codemap_search_claims` / `codemap_search_knowledge` now expose `conflictCount` per claim summary; the search formatter prints `| conflicts: N` so AI sessions see conflict membership at search time without a per-claim drill-in ([src/codemap/mcp/index.ts](../src/codemap/mcp/index.ts))
- `codemap_get_publish_status` incident summary gains a `bySource` breakdown grouping by `(source, severity)` so AI sessions can tell whether a high-severity count means conflicts vs. stale critical claims and pick the right drill-in tool ([src/codemap/mcp/index.ts](../src/codemap/mcp/index.ts))
- `codemap_get_conflicts` orders results by severity rank (high → medium → low) before slicing to `limit`, so a truncated list keeps high-severity edges instead of whichever conflicts had alphabetically-early IDs ([src/codemap/mcp/index.ts](../src/codemap/mcp/index.ts))
- Closes the conflict-surfacing audit punch-list item; architecture invariant #6 ("conflicts must be visible") is now end-to-end enforced at the per-claim, per-status, and per-drill-in surfaces

### Adoption-facing (2026-04-25)
- New `docs/codemap-quickstart.md` — install + modes + incidents reference + AI adoption template

### Knowledge / decision capture (2026-04-25)
- New `codemap_record_decision` MCP tool ([src/codemap/notes/record-decision.ts](../src/codemap/notes/record-decision.ts), wired in [src/mcp-server.ts](../src/mcp-server.ts))
- Knowledge extractor lowers confidence and adds `recorded` + `ai-recorded` tags when a note carries the `ai-recorded` frontmatter tag ([src/codemap/extract/knowledge/notes.ts](../src/codemap/extract/knowledge/notes.ts))
- Knowledge view renderer prepends `[recorded]` to summary lines for AI-recorded decisions ([src/codemap/render/views/knowledge.ts](../src/codemap/render/views/knowledge.ts))

### Hook gating (2026-04-25, 2026-04-24)
- Hook now reads both `incidents.ndjson` and `knowledge-incidents.ndjson` and sums severity counts before gating, so stale critical knowledge decisions block commits the same way stale routes do ([src/codemap/runtime/index.ts](../src/codemap/runtime/index.ts))
- Latent stderr-noise bug fixed: previous `grep -c ... || echo 0` produced double output when grep found 0 matches; replaced with `[ -z "$VAR" ] && VAR=0` guard
- `--codemap-policy <mode>` CLI flag: bakes `shadow` / `warn` / `block` as the env-var fallback default in the installed hook script. Env var still wins at commit time. ([src/index.ts](../src/index.ts))
- Severity-aware hook script: `block` only on `high`, `warn` on `high` + `medium`, `shadow` always allows + reports per-severity counts
- `shadow` policy mode wired into the hook script template

### Incident signal (2026-04-24)
- New claim-health incident generator ([src/codemap/publish/claim-health-incidents.ts](../src/codemap/publish/claim-health-incidents.ts))
- `PublishIncident` extended with `source` and `sourceRecordId` for traceability ([src/codemap/model/types.ts](../src/codemap/model/types.ts))
- Stable incident ids across runs (no longer hashed with `createdAt`)
- Wired into both code and knowledge pipelines ([code-pipeline.ts](../src/codemap/publish/code-pipeline.ts), [knowledge-pipeline.ts](../src/codemap/publish/knowledge-pipeline.ts))

### Snapshot archive sharding (2026-04-24)
- Each archived snapshot now writes a metadata JSON shard + an optional content `.txt.gz` shard at `.codemap/archive/snapshots/files/` and `.codemap/archive/snapshots/content/`
- Reads prefer shards; legacy bundle-based archives still work as a fallback ([src/codemap/history/policy.ts](../src/codemap/history/policy.ts), [src/codemap/store/snapshots-store.ts](../src/codemap/store/snapshots-store.ts))

### Snapshot store / Windows-safe basenames (2026-04-23)
- Snapshot metadata files use hashed basenames instead of raw `snapshot:<id>` filenames; fixed Windows alternate-data-stream interpretation of `:`

## Next-Step Candidates

In rough priority order, with short rationale:

1. **`codemap_record_question` (symmetric recording for open questions)** — natural extension of the recording tool, but defer until the decision tool is proven in real use. Don't build symmetry for its own sake.
2. **Opportunistic legacy-bundle migration** — rewrite existing combined-bundle snapshot archives as shards on next sync. Polish for repos that accumulated bundles before the sharding change.
3. **Retention / deletion policy for archived snapshots** — explicit "keep last N runs" or "delete after age X" policy. Discussed and **deferred** because retention is the default-correct stance for a verified-claim system; deletion is a disk-pressure escape valve, not a feature. Revisit only when a real repo hits a real disk constraint.
4. **Extend `conflictCount` to non-search formatters** — `formatCodemapKnowledgeOverview`, `formatCodemapSnapshotDiff`, etc. carry the data field but don't print it. Held back this session as scope creep; revisit if AI sessions report missing the signal in those tools.
5. **`severityCounts` ordering on publish status** — currently alpha-sorted (`high, low, medium`); `bySource` uses severity rank. Align both for consistency, or document the divergence. Cosmetic; not blocking.

## Scheduled Follow-Ups

A one-time remote agent is scheduled to fire on **2026-05-08 17:00 UTC** to re-audit watch/hook completeness against any accumulated shadow-mode usage data and re-check the Phase 6 punch list. Manage at https://claude.ai/code/routines/trig_01LoAKmHX5nqxa9BVkWdFpds

## Constraints To Preserve

- keep legacy Codesight behavior working
- no big-bang rewrite
- markdown remains a derived view, not the source of truth
- maintain compatibility with repos that already have Codesight and repos that do not
- archive shard fallback stays backward compatible with existing bundle-based snapshot archives

## Resume Checklist

1. Read [AGENTS.md](../AGENTS.md), [docs/codemap-architecture.md](codemap-architecture.md), and [docs/codemap-quickstart.md](codemap-quickstart.md).
2. Read this file.
3. Pick a next-step candidate from the list above (or one driven by user need).
4. Run:
   - `corepack pnpm build`
   - `corepack pnpm test`
5. Report changed files, test results, and remaining risks before moving on.
