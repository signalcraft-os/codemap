# CodeMap Handoff

Date: 2026-04-26
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

Latest verification (2026-04-26, after watch parity fix):
- `corepack pnpm build` passed
- `corepack pnpm test` passed
- result: `129` passing, `0` failing
- last commit: `26d2a3a` (`--watch --codemap` parity with the G2 unified default)

## Documentation

- [docs/codemap-architecture.md](codemap-architecture.md) — design rationale (the *why*).
- [docs/codemap-quickstart.md](codemap-quickstart.md) — adoption guide: install, hook policy modes, incident sources reference, AI adoption template (the *how*). **Read this if you are adopting CodeMap on a new project.**
- This file — current state and what's next.

## Recent Cumulative Changes (2026-04-23 → 2026-04-26)

Grouped by phase, newest first.

### Watch-mode parity with the G2 unified default (2026-04-26, commit `26d2a3a`)
- Symmetric follow-up to commit `f0a5d41`. Bare `--watch --codemap` (no explicit `--mode`) now refreshes both pipelines: code on code-file changes, knowledge on `*.md` / `*.mdx` changes. The escape hatches `--watch --mode code --codemap` and `--watch --mode knowledge --codemap` keep their scoped behavior (the latter still routes to `watchKnowledgeMode` upstream).
- Pure `classifyWatchChange(filename, { ignoreDirs, pipelines })` helper added to [src/codemap/runtime/index.ts](../src/codemap/runtime/index.ts) along with `CODE_WATCH_EXTENSIONS` / `KNOWLEDGE_WATCH_EXTENSIONS`. The `watchMode` loop in [src/index.ts](../src/index.ts) now consults the classifier on each `fs.watch` event and routes to one of two debounce timers (500ms each) — code-file saves never trigger spurious knowledge work, and knowledge changes don't kick off a code rescan. `runKnowledgePipelineInWatch = doCodemap && !modeExplicit` is the single dispatch flag derived in `main()`.
- Regression test exercises the classifier as a unit ([tests/codemap.test.ts](../tests/codemap.test.ts)): asserts md → knowledge, code extensions → code, ignored dirs / pipeline gating / Windows backslash / null inputs all classify correctly. Subprocess-driven watch tests are flaky on Windows, so the building-block path is tested directly per Codex's "if a feature is hard to test, simplify the feature until it becomes testable" rule.
- `watchKnowledgeMode` is now structurally redundant with `watchMode(.., runCode=false, runKnowledge=true)`; left untouched to keep the diff minimal. Worth folding in only if it starts drifting.

### First dogfood audit + adoption-blocker fixes (2026-04-25, commit `f0a5d41`)
- Ran `node dist/index.js --codemap` against this repo and inspected what CodeMap says about itself. Invariants #1, #3, #5, #6 were all observably enforced; the audit surfaced three real gaps that would degrade the AI adoption story before it started.
- **G1 — knowledge extractor hygiene** ([src/detectors/knowledge.ts](../src/detectors/knowledge.ts)): `extractDecisions` now runs against `stripExampleSections(stripBlockquoteLines(stripCodeBlocks(content)))` instead of raw markdown. Two new helpers drop `>` blockquotes and content under `## Example` / `## Bad` / `## Good` / `## Don't` / `## Anti-pattern` / `## Counter-example` headings. Without this, README fenced-code demos and architecture-doc teaching examples (the "Polar over Stripe Connect" / "use Polar globally" example block in `docs/codemap-architecture.md` §10, the KNOWLEDGE.md sample output in `README.md` §122-123) emitted real `[verified]` `knowledge_decision` claims — direct invariant #2 risk. Decision count on this repo went from 3 phantom decisions to 0.
- **G3 — knowledge incidents scoped to knowledge claims** ([src/codemap/publish/claim-health-incidents.ts](../src/codemap/publish/claim-health-incidents.ts), [src/codemap/publish/knowledge-pipeline.ts](../src/codemap/publish/knowledge-pipeline.ts)): `buildClaimHealthIncidents` now skips conflict edges whose endpoints are not both in the caller's claim set. The knowledge pipeline passes `finalKnowledgeClaims` (knowledge-only) instead of `rawState.claims` (the full canonical store including code claims preserved across runs). Stops code-domain middleware conflicts from being re-emitted into `knowledge-incidents.ndjson` and double-counted by `codemap_get_publish_status`. On this repo: incident `total` went from `5` (inflated) to `3` (correct: 1 compatibility-missing + 2 unique conflicts).
- **G2 — default `--codemap` runs both pipelines** ([src/index.ts](../src/index.ts)): adoption-quickstart §1 said `npx codesight --codemap` produces `.codemap/views/knowledge/overview.md` and `.codemap/publish/knowledge-incidents.ndjson`, but the CLI only ran the code pipeline. Now tracks `modeExplicit` and auto-runs `runKnowledgeScan` (with `quiet: true`) when `doCodemap && !modeExplicit && !doWatch`. `--mode code --codemap` and `--mode knowledge --codemap` remain as scoped escape hatches. [docs/codemap-quickstart.md](codemap-quickstart.md) §1 updated to mention the unified default.
- Three regression tests added ([tests/codemap.test.ts](../tests/codemap.test.ts)): one fixture-based test for G1 (asserts demonstration phrases inside fenced code, blockquotes, and Example sections do not become decisions while real ADR `## Decision` content still does), one unit test for G3 (`buildClaimHealthIncidents` skips conflicts whose endpoints aren't in the caller's claim set), one CLI-subprocess test for G2 with two subtests (default `--codemap` produces `views/knowledge/overview.md` + `knowledge-incidents.ndjson`; `--mode code --codemap` does not).
- One-off MCP harness `scripts/dogfood-mcp.mjs` left on disk (untracked) — exercises `codemap_get_overview` / `_publish_status` / `_conflicts` / `_search_claims` / `_get_knowledge_overview` end-to-end through the formatters. Useful for future audits; delete if you don't want it.

### Inferred provenance survives status flips (2026-04-25)
- `knowledge.ts toSummaryLine` and `compatibility-wiki.ts toStatusBadge` now append a defensive `[inferred]` label when `tags.includes("inferred") && status !== "inferred"`, mirroring what `code.ts` and `routes.ts` already did ([src/codemap/render/views/knowledge.ts](../src/codemap/render/views/knowledge.ts), [src/codemap/render/views/compatibility-wiki.ts](../src/codemap/render/views/compatibility-wiki.ts))
- Closes the invariant #5 audit. Failure case: a regex-extracted decision/route that goes stale used to render as `[stale]` only — readers couldn't distinguish a formerly-rock-solid AST claim from a formerly-low-confidence regex claim. Now both render `[stale] [inferred]` so triage gets the right priority signal.
- The compatibility wiki single-point fix in `toStatusBadge` propagates through routes, models, relations, components, hotspots, env, middleware, and library renderers since they all funnel through that helper.

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

1. **Local `--report` HTML dashboard + opt-in telemetry firehose** — surfaced during the 2026-04-26 dogfood-on-signalcraft-report-builder session. CodeMap's design is "data files in a repo," with no human-facing visibility surface; users have no way to tell if the system is earning its keep without manually reading `.codemap/views/index.md` and the incident NDJSON files. Phase 1: a `--report` flag that emits `.codemap/views/dashboard.html` from existing publish data (claim counts, sparkline of `.codemap/history/` over time, incidents by severity, AI-recorded decision count, top stale/conflicting claims, recent decisions list). **Architectural requirement:** keep the data-extraction layer (`buildDashboardPayload(codemap) → DashboardPayload`) separate from the renderer (`renderDashboardHtml(payload) → string`) so the same payload can later carry forward to multi-user telemetry without a rewrite. Phase 2 (deferred until real demand): an opt-in `CODEMAP_TELEMETRY_URL` env var triggers a fire-and-forget POST of the same payload after each publish — opaque project ID = `sha256(hostname, project_root)`, counts only, no file paths or claim text. Smallest viable transport at 1–3 beta testers is a shared Discord/Slack webhook; the channel is the dashboard. Phase 2 considerations: the data shape can fingerprint a project to someone who knows the tester pool, so "anonymized" needs explicit consent language before broader distribution. Estimated effort: half a day for phase 1, another half day for phase 2.
2. **`codemap_record_question` (symmetric recording for open questions)** — natural extension of `codemap_record_decision`. Still defer until the decision tool is proven in real use; the dogfood session didn't generate any real recorded decisions yet (the example "Adopt Polar for marketplace payouts" was test-fixture text), so the AI-recording path is unproven on a real session.
3. **Extend `conflictCount` to non-search formatters** — `formatCodemapKnowledgeOverview`, `formatCodemapSnapshotDiff`, etc. carry the data field but don't print it. Held back from the conflict-surfacing session as scope creep; revisit if AI sessions report missing the signal in those tools.
4. **`severityCounts` ordering on publish status** — currently alpha-sorted (`high, low, medium`); `bySource` uses severity rank. Align both for consistency, or document the divergence. Cosmetic; not blocking.
5. **Opportunistic legacy-bundle migration** — rewrite existing combined-bundle snapshot archives as shards on next sync. Polish for repos that accumulated bundles before the sharding change.
6. **Retention / deletion policy for archived snapshots** — explicit "keep last N runs" or "delete after age X" policy. Discussed and **deferred** because retention is the default-correct stance for a verified-claim system; deletion is a disk-pressure escape valve, not a feature. Revisit only when a real repo hits a real disk constraint.
7. **Fold `watchKnowledgeMode` into `watchMode`** — now structurally redundant after the 2026-04-26 watch-parity fix; would simplify but risks behavior drift. Defer until there's a real reason to touch the file.

### Audited but not fixed (configuration, not bugs)

- **G4 — test-fixture markdown polluting knowledge summaries.** `tests/fixtures/monorepo-init*/AGENTS.md` etc. show up as `[inferred]` Note Summaries on this repo. Real fix is a `.codesightignore` entry (`tests/fixtures/**`) — knowledge mode already honors that file. Hardcoding the path into the tool is opinionated and helps no one but us. Add the ignore entry if/when self-dogfood output noise actually bothers someone.
- **G5 — self-referential routes/middleware on detector source.** `src/detectors/routes.ts` etc. get scanned for routes; `src/codemap/extract/code/middleware.ts` etc. get classified as middleware. All correctly labeled `[inferred]`, and the resulting conflicts surface (invariants #5 + #6 hold). Only relevant on this exact repo. Same disposition as G4: configuration, not a code bug.

## Scheduled Follow-Ups

- **One-time agent — 2026-05-08 17:00 UTC** — re-audits watch/hook completeness against any accumulated shadow-mode usage data and re-checks the Phase 6 punch list. Manage at https://claude.ai/code/routines/trig_01LoAKmHX5nqxa9BVkWdFpds
- **Recurring agent — Mondays 16:00 UTC (created 2026-04-26)** — CodeMap dogfood audit on `bootstrap-from-codesight`. Self-throttles via a "skip if 3+ commits in last 4 days" rule to approximate biweekly. Emits a structured markdown report (build/test status, incident counts, claim drift, AI-recorded decision count, verdict line) to the routine session log. Manage at https://claude.ai/code/routines/trig_01MRBo1Qy4Myfwhv9VyX4Mn7

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
