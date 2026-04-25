# CodeMap Quickstart

Audience: developers adopting CodeMap on a real project.
Companion to `docs/codemap-architecture.md` (which explains *why*); this doc explains *how*.

## 1. Adopt CodeMap on a new project

CodeMap ships inside the existing `codesight` CLI under the `--codemap` flag. It writes to `.codemap/` in your repo root and never overwrites legacy `.codesight/` output unless you ask.

```bash
# from your project root
npx codesight --codemap
```

This produces:
- `.codemap/snapshots/` — immutable hash-anchored snapshots of source + notes
- `.codemap/claims/claims.ndjson` — verified claims with evidence references
- `.codemap/views/` — rendered markdown views derived from claims (read these, don't read the raw .ndjson)
- `.codemap/views/knowledge/overview.md` — decisions, open questions, themes, people
- `.codemap/compatibility/` — drop-in replacements for the legacy `.codesight/wiki/` and `KNOWLEDGE.md` consumers
- `.codemap/publish/incidents.ndjson` — flagged drift (see section 3)
- `.codemap/history/` — publish-run ledger, claim-state history, archive policy state

Add `.codemap/cache/` to `.gitignore`. Commit the rest if you want claim history to be diffable in PRs; ignore the whole directory if you want CodeMap as a per-developer tool only.

### Install the git hook

```bash
npx codesight --install-hook --codemap
```

This appends a CodeMap stanza to `.git/hooks/pre-commit`. The hook runs the publish on every commit and gates the commit on incident severity (see section 2).

The hook starts in **`warn`** mode by default. For new repos you should override to `shadow` until you've watched what incidents fire (see section 2).

## 2. Hook policy modes

The hook reads `CODESIGHT_CODEMAP_POLICY` (env var). Three modes:

| Mode | What it does | When to use |
| --- | --- | --- |
| `shadow` | Publish runs, incidents are written to `.codemap/publish/incidents.ndjson`, hook **never** blocks the commit. Prints an observation line: `shadow mode observed CodeMap incidents (high=N medium=N low=N); commit allowed.` | Initial adoption. Soak for days/weeks. Look at what incidents accumulate. |
| `warn` | Same publish as shadow, plus the hook prints a warning per non-zero severity tier (`high` and `medium`). Never blocks. | Once shadow has shown the signal is real and not noisy. |
| `block` | Hook exits non-zero (blocks the commit) **only if `high`-severity incidents exist**. Medium and low never block. | Once you trust `high` to mean "stop the commit." Typical end state. |

Set the mode in your shell profile, CI env, or a per-developer `.envrc`:

```bash
export CODESIGHT_CODEMAP_POLICY=shadow
```

You can also bake the default into the installed hook script via the CLI flag:

```bash
npx codesight --hook --codemap --codemap-policy shadow
```

The flag changes the *default* in the script's env-var fallback (`${CODESIGHT_CODEMAP_POLICY:-<mode>}`). The env var still wins at commit time, so a per-developer override stays possible.

### Migration path

1. Install hook → set `shadow`. Commit a few times. Inspect `.codemap/publish/incidents.ndjson`.
2. Are the incidents that fire actually things you want to know about? If yes, promote to `warn`.
3. Live on `warn` until `high`-severity incidents only fire on real "stop and fix" cases. Promote to `block`.
4. If `block` proves too aggressive, demote to `warn` and investigate which incident source is producing false positives.

You can switch modes any time. Nothing is destructive about a mode change — only the gating behavior differs.

## 3. Incident sources reference

`.codemap/publish/incidents.ndjson` is the canonical signal stream. Each line is one incident:

```json
{"id":"...","createdAt":"...","severity":"high","message":"...","claimIds":["..."],"source":"claim-stale-critical","sourceRecordId":"verification:..."}
```

The `source` field tells you why it fired and how to investigate. `sourceRecordId` points back to the verification record (for stale/conflicting/quarantined claims) or conflict edge (for conflicts) — that's your audit trail.

| Source | Severity | What triggers it | How to investigate / fix |
| --- | --- | --- | --- |
| `conflict-high` | `high` | A `ConflictEdge` with `severity: "high"` between two claims | Read the rationale in the message. Resolve the underlying disagreement (usually two sources of truth contradicting each other). The two `claimIds` in the incident are the conflicting claims. |
| `conflict-medium` | `medium` | `ConflictEdge` with `severity: "medium"` | Same as above, lower urgency. |
| `claim-stale-critical` | `high` | A claim of type `route`, `model`, `env_var`, or `middleware` with `status: "stale"` (verifier rejected it) | These are runtime-load-bearing. Look up the verification record by `sourceRecordId` to see which verifier failed (`hash-match`, `line-exists`, `ast-shape`, etc.) and against which snapshot. Either re-verify (run publish again) or update the source. |
| `claim-stale` | `medium` | Stale claim of any other type (component, library, config, hotspot, knowledge_*) | Same investigation; lower urgency. |
| `claim-conflicting` | `medium` | Claim with `status: "conflicting"` (its evidence supports an unresolved conflict) | Pair with the `conflict-high` / `conflict-medium` incident covering the same claim. |
| `claim-quarantined` | `medium` | Claim explicitly excluded from publication by the verifier | Review the claim; either re-verify, fix the source, or accept the quarantine. |
| `compatibility-missing` | `medium` | A legacy `.codesight/wiki/<article>.md` exists but no CodeMap compatibility article was generated for it | Migration TODO. Add the missing topic to CodeMap, or accept the gap and remove the legacy article. |
| `compatibility-drift` | `low` | Compatibility wiki text similarity below threshold vs. legacy wiki | Informational. Either regenerate compatibility output or accept that CodeMap's view differs. Never blocks `warn` or `block` mode. |

### Severity tiers (operational summary)

- **`high`** — block-worthy. Something the AI / users will silently get wrong if unfixed.
- **`medium`** — investigate soon. Not an emergency, but real drift.
- **`low`** — informational only. Never gates anything.

### Knowledge incidents

Knowledge claims (`knowledge_decision`, `knowledge_question`, etc.) produce parallel incidents at `.codemap/publish/knowledge-incidents.ndjson`. The hook reads **both** `incidents.ndjson` and `knowledge-incidents.ndjson` and sums their severity counts before gating. So a stale `knowledge_decision` (severity `high` because `knowledge_decision` is in the critical knowledge claim type set) will block a commit in `block` mode just like a stale route would.

## 4. AI adoption template

CodeMap is most useful in long-running AI sessions where context drifts across days or weeks. To wire an AI assistant into CodeMap, paste this into your project's `CLAUDE.md` (or `AGENTS.md` / `GEMINI.md` — whatever your AI reads at session start):

```markdown
## CodeMap (project memory)

This project uses CodeMap. Treat `.codemap/` as the canonical truth for what the codebase contains and what decisions have been made — not your own re-reading of source files.

**At the start of every session:**
1. Call the `codemap_get_overview` MCP tool — orients you to the current claim graph.
2. Call `codemap_get_knowledge_overview` — surfaces decisions, open questions, themes, people.
3. Read `.codemap/views/knowledge/overview.md` if MCP tools aren't available.

**When the user makes a decision** (picks a tool, library, architecture, scope cut, name, deprecation, etc.):
- Call `codemap_record_decision` with `subject`, `decision`, optional `rationale`, optional `related_source_paths`, optional `supersedes`.
- Use the user's near-verbatim words for `decision`. You are transcribing, not synthesizing.
- Confirm to the user with the file path the tool returned, so they can edit if you got it wrong.
- The recording will surface as a `knowledge_decision` claim on the next CodeMap publish, tagged `recorded` with lower default confidence so a human can review and promote.

**When proposing changes:**
- Use `codemap_search_claims` (code) and `codemap_search_knowledge` (decisions/questions/themes/people) instead of grepping source.
- Cite claim IDs in your reasoning when you're relying on an existing claim. e.g. "per `claim:xxxxx`, the auth middleware is JWT-based."
- If `codemap_get_publish_status` reports incidents, look at them before proposing changes that touch the affected claims.

**When you encounter conflicting or stale information:**
- Surface the conflict to the user. Don't pick a winner silently.
- `codemap_get_conflicts` returns the unresolved conflict edges with both sides and a rationale.

**Never:**
- Trust a rendered summary as evidence for a new claim. Re-ground on raw source via `codemap_get_claim_evidence`.
- Skip recording a decision because "it's small." If the user changed direction, record it.
```

Adjust to match your actual MCP setup (some clients use `mcp__codesight__codemap_get_overview` etc.).

### Why this works

The recording tool is only as useful as the AI's habit of calling it. The template above turns it into a reliable reflex by:
- Front-loading session orientation (the AI starts grounded in the claim graph, not a blank slate).
- Naming the trigger ("when the user makes a decision") so the AI doesn't have to guess.
- Requiring near-verbatim transcription so the recording captures user intent, not AI synthesis.
- Requiring claim IDs in proposals so reasoning is auditable.

Without this template, the recording tool exists but rarely fires. With it, an AI session in a new project becomes meaningfully reusable across days and weeks.

## 5. Where to learn more

- `docs/codemap-architecture.md` — the design rationale: why claims, why evidence, why no recursive summarization.
- `docs/codemap-handoff.md` — current implementation state and what's next.
- The `.codemap/views/index.md` of any repo running CodeMap — the live shape of the system in that project.
