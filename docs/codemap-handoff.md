# CodeMap Handoff

Date: 2026-04-23
Branch: `bootstrap-from-codesight`

## Current State

CodeMap is now a parallel, hardened successor path to Codesight under `.codemap/`, with legacy behavior still preserved.

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

Latest verification:
- `corepack pnpm build` passed
- `corepack pnpm test` passed
- result: `112` passing, `0` failing

## Important Recent Fix

Snapshot metadata files now use Windows-safe hashed basenames instead of raw `snapshot:<id>` filenames.

This matters because Windows treated raw `:`-containing snapshot filenames as alternate data streams, which made snapshot archive planning miss hot snapshot files entirely.

Primary files involved:
- [src/codemap/history/policy.ts](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/src/codemap/history/policy.ts)
- [src/codemap/store/snapshots-store.ts](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/src/codemap/store/snapshots-store.ts)
- [src/codemap/model/ids.ts](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/src/codemap/model/ids.ts)
- [tests/codemap.test.ts](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/tests/codemap.test.ts)

## Exact Next Step

Implement **per-snapshot archive sharding** for archived snapshot history.

Reason:
- current archive lookup is correct, but still loads the matching gzip bundle for a snapshot lookup
- per-snapshot sharding would improve deep-history read speed and token efficiency
- it is a smaller, cleaner next step than retention/deletion policy

Target outcome:
- archived snapshots can be fetched by snapshot id without loading multi-snapshot bundles
- archive index points directly to snapshot shard paths
- `codemap_diff_since_snapshot` and snapshot store fallback use the shard path first
- existing bundle-based archive fallback remains backward compatible

## Likely Files To Touch

- [src/codemap/history/policy.ts](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/src/codemap/history/policy.ts)
- [src/codemap/store/snapshots-store.ts](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/src/codemap/store/snapshots-store.ts)
- [src/codemap/model/layout.ts](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/src/codemap/model/layout.ts)
- [src/codemap/model/types.ts](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/src/codemap/model/types.ts)
- [src/codemap/mcp/index.ts](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/src/codemap/mcp/index.ts)
- [tests/codemap.test.ts](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/tests/codemap.test.ts)

## Constraints To Preserve

- keep legacy Codesight behavior working
- no big-bang rewrite
- markdown remains a derived view, not the source of truth
- maintain compatibility with repos that already have Codesight and repos that do not
- keep archive fallback backward compatible with existing bundle-based snapshot archives

## Resume Checklist

1. Read [AGENTS.md](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/AGENTS.md) and [docs/codemap-architecture.md](C:/Users/MarketingLab/Documents/Codex/2026-04-21-read-agents-md-and-docs-codemap/docs/codemap-architecture.md).
2. Read this file.
3. Implement per-snapshot archive sharding only.
4. Run:
   - `corepack pnpm build`
   - `corepack pnpm test`
5. Report changed files, test results, and remaining risks before moving on.
