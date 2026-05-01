# Dependency Graph

## Most Imported Files (change these carefully)

- `src/types.ts` — imported by **55** files
- `src/codemap/model/types.ts` — imported by **39** files
- `src/codemap/model/ids.ts` — imported by **27** files
- `src/codemap/snapshot/snapshotter.ts` — imported by **22** files
- `src/codemap/model/layout.ts` — imported by **17** files
- `src/scanner.ts` — imported by **16** files
- `src/codemap/extract/code/source-path-filter.ts` — imported by **10** files
- `src/codemap/store/fs.ts` — imported by **8** files
- `src/codemap/publish/code-pipeline.ts` — imported by **8** files
- `src/ast/loader.ts` — imported by **6** files
- `src/codemap/store/index.ts` — imported by **6** files
- `src/ast/extract-brightscript.ts` — imported by **5** files
- `src/codemap/publish/plans.ts` — imported by **4** files
- `src/codemap/store/claims-store.ts` — imported by **4** files
- `src/codemap/store/conflict-store.ts` — imported by **4** files
- `src/codemap/store/evidence-store.ts` — imported by **4** files
- `src/codemap/store/snapshots-store.ts` — imported by **4** files
- `src/codemap/store/verification-store.ts` — imported by **4** files
- `src/codemap/publish/knowledge-pipeline.ts` — imported by **4** files
- `src/codemap/notes/record-decision.ts` — imported by **3** files

## Import Map (who imports what)

- `src/types.ts` ← `src/ast/extract-android.ts`, `src/ast/extract-brighterscript.ts`, `src/ast/extract-brightscript.ts`, `src/ast/extract-components.ts`, `src/ast/extract-csharp.ts` +50 more
- `src/codemap/model/types.ts` ← `src/codemap/extract/code/components.ts`, `src/codemap/extract/code/config.ts`, `src/codemap/extract/code/env.ts`, `src/codemap/extract/code/hotspots.ts`, `src/codemap/extract/code/libs.ts` +34 more
- `src/codemap/model/ids.ts` ← `src/codemap/extract/code/components.ts`, `src/codemap/extract/code/config.ts`, `src/codemap/extract/code/env.ts`, `src/codemap/extract/code/hotspots.ts`, `src/codemap/extract/code/libs.ts` +22 more
- `src/codemap/snapshot/snapshotter.ts` ← `src/codemap/extract/code/components.ts`, `src/codemap/extract/code/config.ts`, `src/codemap/extract/code/env.ts`, `src/codemap/extract/code/hotspots.ts`, `src/codemap/extract/code/libs.ts` +17 more
- `src/codemap/model/layout.ts` ← `src/codemap/history/index.ts`, `src/codemap/history/policy.ts`, `src/codemap/mcp/index.ts`, `src/codemap/migration/compatibility-parity.ts`, `src/codemap/model/index.ts` +12 more
- `src/scanner.ts` ← `src/core.ts`, `src/detectors/components.ts`, `src/detectors/config.ts`, `src/detectors/contracts.ts`, `src/detectors/coverage.ts` +11 more
- `src/codemap/extract/code/source-path-filter.ts` ← `src/codemap/extract/code/components.ts`, `src/codemap/extract/code/config.ts`, `src/codemap/extract/code/env.ts`, `src/codemap/extract/code/hotspots.ts`, `src/codemap/extract/code/index.ts` +5 more
- `src/codemap/store/fs.ts` ← `src/codemap/history/index.ts`, `src/codemap/history/policy.ts`, `src/codemap/mcp/index.ts`, `src/codemap/publish/knowledge-pipeline.ts`, `src/codemap/publish/plans.ts` +3 more
- `src/codemap/publish/code-pipeline.ts` ← `src/codemap/publish/index.ts`, `src/codemap/publish/routes-pipeline.ts`, `src/codemap/publish/routes-pipeline.ts`, `src/codemap/telemetry/index.ts`, `src/index.ts` +3 more
- `src/ast/loader.ts` ← `src/ast/extract-components.ts`, `src/ast/extract-routes.ts`, `src/ast/extract-schema.ts`, `src/detectors/components.ts`, `src/detectors/routes.ts` +1 more
