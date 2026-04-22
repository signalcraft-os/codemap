# AGENTS.md — CodeMap build instructions for Codex

You are implementing **CodeMap**, a hardened successor to Codesight.

Read `docs/codemap-architecture.md` first. That document is the source of truth for the desired system shape.

Your mission is to preserve Codesight's ergonomic strengths while changing the canonical substrate from rendered markdown to verified claims with evidence.

---

## 1) Operating mode

Assume one of two contexts:

### A. Legacy repository mode
You are working inside the existing `codesight` repository and must introduce CodeMap without breaking the current CLI or `.codesight/` consumers.

### B. Fresh repository mode
You are working in a new `codemap` repository and may build the hardened system directly, but you should still preserve migration compatibility where practical.

When uncertain, default to **legacy repository mode**.

---

## 2) Architectural invariants

These rules are mandatory:

1. **Rendered markdown is not the source of truth.**  
   Canonical truth must live in structured claim/evidence data under `.codemap/`.

2. **No recursive summarization.**  
   A generated page may be used for navigation, but not as sole evidence for new claims.

3. **Every publishable claim needs evidence.**  
   Claims without evidence spans must not be marked `verified`.

4. **Freshness is snapshot-based.**  
   Use source hashes and verification records, not only page timestamps.

5. **Inferred content must stay labeled.**  
   Preserve or strengthen existing inferred / regex labeling behavior.

6. **Conflicts must be visible.**  
   Do not flatten disagreement into one clean answer.

7. **Migration must be safe.**  
   Do not silently replace legacy `.codesight/wiki/` behavior. Use shadow mode or dual-write first.

8. **Tests are part of the feature.**  
   Any new behavior that affects publication, verification, hooks, watch mode, or MCP must include tests.

---

## 3) Immediate tasks

Before changing code:

1. Read:
   - `docs/codemap-architecture.md`
   - current CLI entrypoints
   - wiki generation code
   - knowledge mode code
   - MCP server code
   - test suite

2. Produce a short implementation plan with phases.

3. Start with scaffolding and types before deep behavioral changes.

---

## 4) Implementation order

Work in this order unless a clear dependency requires adjustment.

### Phase 1 — scaffold
Create the CodeMap module structure and core types.

Target additions:
- `src/codemap/model/types.ts`
- `src/codemap/snapshot/`
- `src/codemap/store/`
- `src/codemap/verify/`
- `src/codemap/render/`
- `src/codemap/publish/`
- `src/codemap/migration/`

Expected outcome:
- Types compile
- No user-visible behavior changes yet

### Phase 2 — snapshot + stores
Implement:
- immutable source snapshots
- claim store
- evidence store
- verification store
- conflict store

Expected outcome:
- `.codemap/` can be created deterministically
- a minimal pipeline can persist snapshots and candidate claims

### Phase 3 — first end-to-end detector path
Pick one strong path first, preferably code-derived.

Recommended first path:
- routes or schema claims from existing detectors

Expected outcome:
- source -> claim -> verify -> render works for one feature end to end

### Phase 4 — rendering
Add:
- `.codemap/views/index.md`
- `.codemap/views/overview.md`
- at least one topic page
- hidden or footnoted claim references in rendered output

Expected outcome:
- rendered views are clearly derived from claims

### Phase 5 — knowledge hardening
Replace direct summary-first knowledge behavior with:
- knowledge claims
- evidence spans from markdown notes
- explicit `decision`, `question`, `theme`, `person` claim types
- conflict-aware rendering

Expected outcome:
- no uncited “truth” output in knowledge mode

### Phase 6 — MCP
Add new claim-aware tools and keep compatibility tools where feasible.

Expected tools:
- `codemap_get_overview`
- `codemap_search_claims`
- `codemap_get_claim`
- `codemap_get_claim_evidence`
- `codemap_get_conflicts`
- `codemap_verify_claim`
- `codemap_diff_since_snapshot`
- `codemap_get_publish_status`

### Phase 7 — dual-write migration
Implement:
- compatibility renderer
- optional sync into legacy `.codesight/` outputs
- shadow comparison support

Expected outcome:
- existing users can validate CodeMap without immediate cutover

### Phase 8 — watch mode and git hook hardening
Change automation from blind rewrite to:
- snapshot
- impact analysis
- re-verification
- publish planning
- controlled render

Expected outcome:
- watch mode and hooks are safer without losing convenience

---

## 5) CLI strategy

Do **not** break current commands during early phases.

Preferred introduction patterns:
- `--engine codemap`
- `--codemap`
- new subcommands
- new output namespace `.codemap/`

Acceptable compatibility behavior:
- legacy `--wiki` continues to work
- CodeMap may optionally render compatibility output for `.codesight/wiki/`

Avoid:
- silently changing the semantics of `--wiki`
- deleting or replacing old outputs without an explicit migration flag

---

## 6) Required file layout

If working in the legacy repo, add or align to this structure:

```text
docs/
  codemap-architecture.md

src/
  codemap/
    model/
    snapshot/
    extract/
    verify/
    store/
    render/
    publish/
    mcp/
    migration/
```

If a fresh repo is used, keep the same internal structure unless there is a strong reason to simplify.

---

## 7) Coding rules

1. Prefer explicit types.
2. Keep functions small and testable.
3. Separate pure transformation logic from file IO.
4. Keep renderer logic isolated from verification logic.
5. Do not mix compatibility rendering with canonical storage.
6. Make policy decisions explicit in code, not hidden in prose templates.
7. Reuse existing Codesight detectors where possible, but normalize their outputs into claims.

---

## 8) Verification rules

A claim may only be marked `verified` if:
- it has at least one valid evidence span
- the source snapshot exists
- the verification checks pass
- no unresolved blocking conflict applies

A claim must be downgraded to `stale`, `conflicting`, or `quarantined` when the evidence no longer supports safe publication.

Never upgrade confidence merely because prose is fluent.

---

## 9) Knowledge-mode rules

These rules are especially strict:

- Do not publish a decision unless it maps to explicit supporting note text or a clearly reviewable heuristic.
- Themes are lower-confidence by default.
- Open questions must remain open unless a later source explicitly resolves them.
- If two notes disagree, render that disagreement instead of choosing a winner silently.
- Do not let old generated summaries become the evidence source for new knowledge claims.

---

## 10) Watch mode and git hook rules

Do not keep the legacy “rewrite output and stage it” behavior as the only path.

New automation should:
- compute changed snapshots
- find impacted claims
- re-verify those claims
- update publish plan
- render draft or final output according to policy

Support at least these policy modes:
- `warn`
- `block`
- `shadow`

---

## 11) MCP rules

MCP responses should expose structure, not just prose.

Whenever possible, include:
- claim id
- claim status
- confidence
- evidence references
- freshness / last verified time
- conflict information

If data is stale or conflicting, say that directly.

---

## 12) Testing requirements

After each milestone:
1. run build
2. run tests
3. add or update tests for new behavior

Minimum required tests:
- source hash changes invalidate affected claims
- deleted files invalidate evidence spans
- inferred/regex outputs remain labeled
- conflicting knowledge notes surface as conflicts
- stale claims do not silently republish as verified
- compatibility output never references missing claim ids
- MCP refresh invalidates stale cached state
- watch mode only republishes affected scope when possible

If a feature is hard to test, simplify the feature until it becomes testable.

---

## 13) Commit discipline

Use small, reviewable commits.

After each milestone, summarize:
- files changed
- behavior added
- tests run
- open risks

Do not combine architecture scaffolding, MCP changes, compatibility rendering, and hook policy changes in one giant commit.

---

## 14) What success looks like

You are done when all of the following are true:

- `.codemap/` contains canonical structured data
- rendered views are derived from claim/evidence data
- legacy `.codesight/` behavior still works or has a safe compatibility path
- knowledge mode is no longer summary-first
- conflicts and stale states are visible
- tests cover the new claim lifecycle
- the system is safer against fact/context drift than the original wiki-first pipeline

---

## 15) First response template

Your first response in the coding session should:

1. briefly restate the mission
2. list the implementation phases you will follow
3. identify the first files you will inspect
4. begin Phase 1 immediately

Do not ask for unnecessary confirmation. Start with the architecture and type scaffolding.

---

## 16) Optional bootstrap prompt for the human to paste above your first task

```text
Implement CodeMap as a hardened successor to Codesight.

Read `docs/codemap-architecture.md` and `AGENTS.md` first.
Assume legacy repository mode unless the repo is clearly fresh.
Do not do a big-bang rewrite.
Preserve current Codesight behavior while introducing `.codemap/` as the canonical structured store.
Implement in small, test-backed phases and report progress after each milestone.
```
