# CodeMap Handoff

Date: 2026-04-30 (no code changes since 2026-04-26; this update adds an open verification task)
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

Latest verification (2026-04-26, after first beta-tester onboarding session):
- `corepack pnpm build` passed
- `corepack pnpm test` passed
- result: `146` passing, `0` failing
- last commit: `a8906e4` (beta-tester doc updated to recommend `--install-prompts`)
- global install of `codesight` is live on the maintainer's machine via `npm install -g .`; refresh after each rebuild

## Documentation

- [docs/codemap-architecture.md](codemap-architecture.md) — design rationale (the *why*).
- [docs/codemap-quickstart.md](codemap-quickstart.md) — adoption guide: install, hook policy modes, incident sources reference, AI adoption template (the *how*). **Read this if you are adopting CodeMap on a new project.**
- [docs/codemap-beta-tester-setup.md](codemap-beta-tester-setup.md) — onboarding doc for individual beta testers: install, telemetry env-var setup, first scan, what feedback the maintainer is looking for. Hand this to anyone you bring into the dogfood pool.
- This file — current state and what's next.

## Recent Cumulative Changes (2026-04-23 → 2026-04-26)

Grouped by phase, newest first.

### Multi-LLM prompt-install flag set (2026-04-26, commits `8718988` + `cea8c03` + `a8906e4`)
- Closes the highest-friction onboarding step — manually pasting a CodeMap adoption template into a CLAUDE.md / AGENTS.md / GEMINI.md — by turning it into a one-shot CLI command. The "project memory" section is now a versioned asset (`assets/claude-md-codemap-section.md`) wrapped in HTML-comment marker tags (`<!-- codemap-claude-md-section-begin -->` ... `-end -->`) so future installs can replace the section in place without disturbing surrounding content.
- New flags ([src/index.ts](../src/index.ts), [src/codemap/install/index.ts](../src/codemap/install/index.ts)):
  - `codesight --install-claude-md` → `~/.claude/CLAUDE.md` (Claude Code)
  - `codesight --install-codex-md` → `~/.codex/AGENTS.md` (OpenAI Codex CLI)
  - `codesight --install-gemini-md` → `~/.gemini/GEMINI.md` (Gemini CLI)
  - `codesight --install-prompts` → all three in one shot
  - `--force` modifier replaces an existing section between markers (idempotent without `--force`).
- Same asset content lands in all three files — no cross-references needed because each LLM tool reads only its own config and gets identical instructions. The section opens with "If `.codemap/` does not exist in this project, ignore this entire section" so it's a no-op on projects that haven't adopted CodeMap, making global install non-disruptive.
- Tests added (6 total across the install module): create-when-missing, append-preserves-prior-content, idempotent-skip, force-replaces-only-between-markers, `defaultPromptTargets()` surface check, multi-target identical-content verification.
- Maintainer's machine is now installed across all three globals (`~/.claude/CLAUDE.md` + `~/.codex/AGENTS.md` + `~/.gemini/GEMINI.md`).
- Beta tester doc updated to recommend `codesight --install-prompts` instead of manual paste.
- **Naming note:** internal helper renamed `installClaudeMdSection` → `installPromptSection` (the function never cared which file it wrote to). The asset filename and marker tags retain the `claude-md` prefix for back-compat — these are exposed in user files and renaming would orphan installs that have already run.

### Beta-tester onboarding doc + onboarding playbook (2026-04-26, commit `8f18f8d`)
- New [docs/codemap-beta-tester-setup.md](codemap-beta-tester-setup.md). Standalone setup guide separate from the quickstart: explicit privacy disclosure (what telemetry sends vs explicitly does not send, with a pointer to the regression-test leak audit), install via clone + `npm install -g .`, env-var setup across macOS/Linux/Windows shells, first scan, what to commit, AI adoption wiring, what feedback is wanted, opt-out instructions. Sized for a single beta tester to read in 10 minutes and a maintainer to walk through on a Zoom in 15.

### Opt-in telemetry firehose (2026-04-26, commit `073c778`)
- Phase 1 of the dashboard/telemetry candidate. Closes the "I can't see if CodeMap is earning its keep across my projects" visibility gap. New module [src/codemap/telemetry/index.ts](../src/codemap/telemetry/index.ts) (~190 lines):
  - `computeProjectHash`: `sha256(hostname:repoRoot)` first 12 chars — opaque, stable per (machine, project), not reversible without the absolute path.
  - `buildCodeTelemetryEvent` / `buildKnowledgeTelemetryEvent`: pure data extractors that turn a publish result into a `TelemetryEvent`. Knowledge variant uses `knowledgeClaims` / `knowledgeSnapshots` / `knowledgeEvidence` (NOT the inflated totals that include preserved code claims).
  - `formatSlackPayload`: renders a 3-line Slack text card with severity emoji (`:bar_chart:` for clean, `:large_yellow_circle:` for medium-incident runs, `:red_circle:` for high).
  - `postTelemetry`: env-var-gated (`CODEMAP_TELEMETRY_URL`) fire-and-forget POST with 3-second timeout. Detects Slack URLs and formats accordingly; sends raw JSON otherwise. Errors swallowed to stderr — telemetry never fails a build.
  - `countRecordedDecisions`: counts `.md` files under `.codemap/notes/decisions/recorded/` — the leading indicator that the AI adoption template is firing on real sessions.
- Wired into three publish-end points: `main()` one-shot CodeMap code pipeline, `runKnowledgeScan` (covers CLI default auto-run + watch-mode knowledge refresh), and `watchMode runCodeScan` (watch trigger).
- Architecture: data-extraction is separated from rendering and transport so the same payload can carry forward to a future multi-user aggregator without rewriting (per the candidate's stated requirement).
- Privacy: payload contains counts, opaque project hash, CLI version, trigger, timestamp, schema version. **Not sent:** paths, claim text, source code, view paths, project name. Regression test asserts the serialized payload contains none of: the repo path, the legacy output root, or the project name.
- **Decided transport: Slack incoming webhook** (out-of-band agreement: 1–3 testers, free-tier Slack workspace owned by the maintainer). Not Supabase — the maintainer's existing signalcraft-os Supabase project carries production app data and the schema-namespace separation, while workable, was deemed risk for trivial benefit. Discord considered and rejected on user-friction grounds (maintainer doesn't use Discord daily). Webhook URL is provisioned but not yet pasted into the maintainer's `~/.bashrc` / Windows env — pending VS Code restart at the maintainer's discretion. Until then, telemetry is a silent no-op (verified by regression test).
- Tests added (7): hash stability, payload shape + leak audit, knowledge-only count selection, Slack formatter with severity-emoji branching, env-unset no-op, recorded-decisions counter for missing-dir + `.md`-only filtering.

### `.codesightignore` parser fix: bare trailing slash now honored (2026-04-26, commit `6ee46a3`)
- Discovered while dogfooding CodeMap on `/d/AI_Lab/Apps/signalcraft-report-builder` ([src/scanner.ts](../src/scanner.ts)). A natural-looking `.codesightignore` line of `clients/` (gitignore convention for "the clients directory") silently no-op'd because the pattern normalizer only stripped `/*` or `/**` suffixes, never a bare trailing `/`. The dogfooder had to write `clients/**` to get the exclusion to fire.
- Fix: extracted a `normalizeIgnorePattern` helper used in both the extra-ignore set and the prefix check, with a broader regex (`\/(\*\*?)?$`) so `clients`, `clients/`, `clients/*`, and `clients/**` all collapse to `clients` and match equivalently.
- Regression test runs four pattern variants through `collectFiles` against a fixture with files under `clients/` to confirm none of them slip through. **Without this fix, every adopter who wrote a natural-looking ignore pattern would have hit the same silent no-op.** The dogfood session caught it immediately.

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

1. **Verify Codex CLI's actual global AGENTS.md path** — added 2026-04-30 after a parallel Claude Code session expressed (potentially valid) skepticism that Codex would actually read `~/.codex/AGENTS.md`. We shipped `--install-codex-md` writing to that location based on convention-matching with `~/.claude/CLAUDE.md`, but the assumption was not verified against current OpenAI Codex CLI documentation in our 2026-04-26 session, and `codex` is not installed on the maintainer's machine so end-to-end testing was not done. **Three possible outcomes:** (a) `~/.codex/AGENTS.md` is correct — no change needed, just confirm in docs; (b) Codex uses a different global path (e.g., `~/.codex/instructions.md`) — update `defaultCodexAgentsMdPath()` in [src/codemap/install/index.ts](../src/codemap/install/index.ts) and re-run `--install-codex-md`; (c) Codex only reads project-local AGENTS.md and has no global location — re-scope to candidate #3 (per-project install flag) and document that `--install-codex-md` is preemptive/dormant until Codex grows a global config. Resolution path: read https://github.com/openai/codex docs (or current location), confirm the schema, fix or document accordingly. ~30 minutes if docs are current; longer if they're sparse and need a working Codex install to verify by experiment.
2. **Local `--report` HTML dashboard** — phase 1 of the dashboard/telemetry candidate; phase 2 (telemetry firehose) shipped on 2026-04-26 (commit `073c778`). Still pending: a `--report` flag that emits `.codemap/views/dashboard.html` from the same `TelemetryEvent` data shape used by the telemetry POST (sparkline of `.codemap/history/` over time, incidents by severity, AI-recorded decision count, top stale/conflicting claims, recent decisions list). The data-extraction layer in `src/codemap/telemetry/index.ts` is already separated from rendering/transport per the architectural requirement, so the dashboard reuses `buildCodeTelemetryEvent` / `buildKnowledgeTelemetryEvent` directly. Half a day of work. Solves the "I want to see signal without scrolling Slack" complement to the firehose.
3. **Per-project `AGENTS.md` install flag** — `--install-prompt-here` (or similar) that drops the same CodeMap section into the *current project's* `AGENTS.md` (vs. the global `~/.codex/AGENTS.md` we already cover). Surfaced during the 2026-04-26 multi-LLM extension discussion: Cursor / Cline / Roo Cline / Aider all read project-level `AGENTS.md` (or equivalent), and a per-project install would cover them in one shot. Defer until a beta tester reports actually using one of those wrappers — speculative builds add flag noise. **Promote to higher priority if candidate #1 reveals that Codex only reads project-local AGENTS.md (outcome c above).**
3. **Continue.dev install flag** — Continue uses `~/.continue/config.json` + `.continuerules` rather than a flat markdown file, so a `--install-continue` flag would need a different schema serializer. Defer until a beta tester reports using Continue.dev with a local model and asks for it.
4. **`codemap_record_question` (symmetric recording for open questions)** — natural extension of `codemap_record_decision`. Still defer until the decision tool is proven in real use; the 2026-04-26 sessions still produced 0 real recorded decisions (telemetry hasn't fired in a real session yet because the maintainer hasn't restarted VS Code to pick up the env var).
5. **Extend `conflictCount` to non-search formatters** — `formatCodemapKnowledgeOverview`, `formatCodemapSnapshotDiff`, etc. carry the data field but don't print it. Held back from the conflict-surfacing session as scope creep; revisit if AI sessions report missing the signal in those tools.
6. **`severityCounts` ordering on publish status** — currently alpha-sorted (`high, low, medium`); `bySource` uses severity rank. Align both for consistency, or document the divergence. Cosmetic; not blocking.
7. **Opportunistic legacy-bundle migration** — rewrite existing combined-bundle snapshot archives as shards on next sync. Polish for repos that accumulated bundles before the sharding change.
8. **Retention / deletion policy for archived snapshots** — explicit "keep last N runs" or "delete after age X" policy. Discussed and **deferred** because retention is the default-correct stance for a verified-claim system; deletion is a disk-pressure escape valve, not a feature. Revisit only when a real repo hits a real disk constraint.
9. **Fold `watchKnowledgeMode` into `watchMode`** — now structurally redundant after the 2026-04-26 watch-parity fix; would simplify but risks behavior drift. Defer until there's a real reason to touch the file.

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
