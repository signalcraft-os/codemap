# CodeMap Beta Tester Setup

Welcome. You're being onboarded as a beta tester for CodeMap, a hardened claim/evidence layer that sits on top of the existing `codesight` CLI. This doc gets you running in ~15 minutes and explains what we're trying to learn from your usage.

If you want the design rationale and product principles, read [docs/codemap-architecture.md](codemap-architecture.md) — but you don't need it to use the tool. The full quickstart is at [docs/codemap-quickstart.md](codemap-quickstart.md). This doc is a thin layer on top.

## What you're testing

CodeMap turns your project's source + markdown notes into a graph of verified claims with attached evidence, so AI sessions can reason about the codebase without rebuilding context every time. We want signal on:

1. **Installation works** on whatever OS/shell setup you have.
2. **Output is useful** on a real codebase the project owner hasn't seen — different framework, different markdown structure, different team conventions.
3. **The AI adoption template fires.** When you change direction in an AI session, does the assistant actually call `codemap_record_decision`? If it does, the wiring is load-bearing. If it stays silent, we have a documentation problem to fix.
4. **Telemetry reaches the channel.** Each scan should produce a Slack message in our shared channel within a few seconds.

## What gets sent to telemetry, what doesn't

You'll set an env var pointing at a Slack incoming webhook the project owner controls. After every CodeMap publish, the CLI POSTs a small JSON payload. **Sent:**

- An opaque project hash (`sha256(hostname, project_path)`, first 12 chars — not reversible without knowing your machine name + project path)
- CLI version
- Trigger type (cli / watch / hook)
- Domain (code / knowledge)
- Counts: claims, snapshots, evidence, verification records, conflicts
- Incident counts by severity (high / medium / low)
- AI-recorded decisions count
- Timestamp

**Not sent:** file paths, source code, claim text, decision content, your project name, your real path, your hostname (only the hash includes it).

The payload schema is the `TelemetryEvent` type in [src/codemap/telemetry/index.ts](../src/codemap/telemetry/index.ts) if you want to read it directly. A regression test in `tests/codemap.test.ts` asserts the serialized payload contains no path or project-name leaks.

If you don't set the env var, the CLI is a silent no-op telemetry-wise. The tool works fine without it.

## Install

CodeMap isn't on npm under its own name yet — the package is still called `codesight` for compatibility. You'll install from source.

**Prerequisites:** Node 18+, git, and `pnpm` (the project uses `corepack pnpm` so `corepack enable` should be enough on a recent Node).

```bash
git clone https://github.com/signalcraft-os/codemap.git
cd codemap
git checkout bootstrap-from-codesight
corepack enable
corepack pnpm install
corepack pnpm build
npm install -g .
```

Verify:

```bash
codesight --version
# codesight v1.13.1
```

If you ever want to update to a newer version, pull the branch, rebuild, and re-run `npm install -g .`. The global install is a copy, not a symlink, so it doesn't auto-update when you `git pull`.

## Set the telemetry env var

The project owner will share a Slack webhook URL with you out-of-band (Slack DM, password manager, etc. — never paste it in chat or commit it).

Once you have it:

**macOS / Linux** — add to `~/.bashrc`, `~/.zshrc`, or your shell's profile file:

```bash
export CODEMAP_TELEMETRY_URL='https://hooks.slack.com/services/...'
```

Then `source ~/.bashrc` (or open a new terminal).

**Windows (PowerShell)** — set as a user environment variable so both PowerShell and Git Bash inherit it:

```powershell
[Environment]::SetEnvironmentVariable('CODEMAP_TELEMETRY_URL', 'https://hooks.slack.com/services/...', 'User')
```

Then close and reopen all your terminals. If you launch terminals from inside VS Code/Cursor, also close and reopen the editor — embedded terminals inherit env from the editor process.

**Verify in a fresh terminal:**

```bash
# Bash:
echo $CODEMAP_TELEMETRY_URL
# PowerShell:
echo $env:CODEMAP_TELEMETRY_URL
```

It should print your `https://hooks.slack.com/...` URL. If it prints blank, the env var didn't persist or the shell predates the change.

## First scan

Pick a project of yours that has code and ideally some markdown notes (READMEs, decision records, meeting notes). From the project root:

```bash
codesight --codemap
```

A few things happen:

1. Legacy `codesight` produces its scan output under `.codesight/`.
2. **CodeMap** produces a claim/evidence graph under `.codemap/`. The AI-readable views are:
   - `.codemap/views/index.md` — entry point for the code claim graph
   - `.codemap/views/knowledge/overview.md` — decisions, open questions, themes from your markdown
   - `.codemap/publish/incidents.ndjson` — drift/conflict signal stream (should be 0 lines on a healthy first scan)
3. Two Slack messages should land in our channel within a few seconds — one for the code pipeline, one for the knowledge auto-run. They look like:

   ```
   📊 codemap:`7a3f2c1b8e4d` [code] (cli) v1.13.1
   claims: 58 · snapshots: 27 · conflicts: 0
   0 incidents · decisions recorded: 0
   ```

If you don't see Slack messages but the CLI ran cleanly, check `echo $CODEMAP_TELEMETRY_URL` in the same shell — most often the env var didn't propagate.

## What to commit

The `.codemap/` directory is generally safe to commit if you want claim history diffable in PRs. Or add it to `.gitignore` if you want CodeMap as a per-developer tool only. Either is fine. Definitely add `.codemap/cache/` to `.gitignore` regardless — that's per-developer state.

## Wire CodeMap into your AI assistant

This is where the leverage lives. CodeMap is most useful when AI sessions actually consume the claim graph instead of grepping source. **One command installs the AI adoption template into your global LLM config files** (Claude Code, OpenAI Codex CLI, Gemini CLI):

```bash
codesight --install-prompts
```

This appends a "CodeMap (project memory)" section to:
- `~/.claude/CLAUDE.md`
- `~/.codex/AGENTS.md`
- `~/.gemini/GEMINI.md`

The section is wrapped in HTML-comment markers so re-running is idempotent (a second run skips, doesn't duplicate). If you only use one tool, you can scope:

```bash
codesight --install-claude-md   # Claude Code only
codesight --install-codex-md    # OpenAI Codex CLI only
codesight --install-gemini-md   # Gemini CLI only
```

Pass `--force` to update an already-installed section in place (replaces the content between markers; leaves your other content untouched). If you'd rather skip the auto-install and paste manually, the section text is at [docs/codemap-quickstart.md §4](codemap-quickstart.md#4-ai-adoption-template).

Two key behaviors the template trains in your AI assistant:

1. **At session start**, the AI reads `.codemap/views/knowledge/overview.md` to orient on prior decisions and open questions.
2. **When you change direction** ("let's switch from Stripe to Polar", "deprecate the old auth flow", "use Postgres instead of MySQL"), the AI calls the `codemap_record_decision` MCP tool to persist the decision as a `knowledge_decision` claim. You'll see the file appear at `.codemap/notes/decisions/recorded/<timestamp>-<slug>.md`.

The MCP tool requires the `codesight --mcp` server to be wired into your AI client's MCP config. If you haven't done that, the AI falls back to reading `.codemap/views/` directly and the recording reflex won't fire — that's still useful, just less complete.

**Soft conditional behavior.** The installed section starts with "If `.codemap/` does not exist in this project, ignore this entire section." That means projects without CodeMap aren't disturbed by the global install — the AI just skips the section. So setting it once globally is non-disruptive even on projects you haven't adopted CodeMap on.

## What we want feedback on

After a few days of usage, the project owner will be looking at the Slack channel for signal. From you specifically:

1. **Did install work cleanly?** If you hit friction, what was it — Node version, pnpm setup, npm permissions, anything weird?
2. **Did your first scan produce sensible output?** Open `.codemap/views/index.md` and `.codemap/views/knowledge/overview.md`. Is what's there roughly what you'd say if asked "what's in this codebase, what decisions has the team made?" — or is it noise?
3. **Did the AI start using it?** Watch for AI sessions that cite claim IDs (`per claim:abc123, ...`) or that surface a relevant past decision when you change direction. If you see this, it's working. If you never see it, the wiring is decorative.
4. **Any specific failures or confusing output?** Quote the exact path or line. Screenshot or paste into Slack DM with the project owner.

## What to do if it breaks

1. **CLI errors:** capture the full stderr output and share with the project owner.
2. **Telemetry doesn't fire:** confirm `echo $CODEMAP_TELEMETRY_URL` prints your URL in the same shell where you ran `codesight`. Most issues are env propagation.
3. **Output looks wrong:** check `.codemap/publish/incidents.ndjson` and `.codemap/publish/knowledge-incidents.ndjson` — they're NDJSON, one incident per line. Lines starting with `"severity":"high"` are the priority signal.
4. **Anything destructive:** stop and tell the project owner. CodeMap should never modify source files, never overwrite content outside `.codesight/` and `.codemap/`. If it does, that's a bug we want to know about immediately.

## Opting out

Unset the env var (`unset CODEMAP_TELEMETRY_URL` in bash, or remove via the same PowerShell `SetEnvironmentVariable` with an empty string) and telemetry stops. The CLI continues to work locally. Delete the global install with `npm uninstall -g codesight` if you want to fully remove the tool.

## Where to ask questions

DM the project owner directly. Beta is small enough that there's no public issue tracker yet — that comes later if the tool earns its keep.
