---
title: Runtime Inventory
view_type: code_topic
generated_at: 2026-07-13T16:07:01.175Z
claim_count: 16
verified_claim_count: 16
inferred_claim_count: 0
stale_claim_count: 0
conflict_count: 4
source_snapshot_count: 104
---

# Runtime Inventory

<!-- claim_ids: claim:909782b786d1f342121087195bd8dd0d37f13adc31354a416252c17f3be98d57, claim:f3313e608a58864075a532ead2db557f49ad44c4a6ffdfe4128ce47c70bd844a, claim:0eb0602f7670734844a21290e89b0b70675ec5060c5475e9388a440d006ee260, claim:fedcb988b404fae0202be7890ff4a5286d4adab485cd19e6b2298af4154041ca, claim:aa87f0dbe80bebffcd05b81935ffc718ff4312b26e99c01bc1bd93105ff82a65, claim:021b33a59fd0d7197d0498c72096e8309a4519fad8540865af5202003ec0ea8e, claim:6a431e61ea74ce6cd57764ab52bc8a5dc3fc7152769ddbc904b871fa3c1ef1f9, claim:6fd1c3e79dfcf7a49cf3b3428ef80653793b6e9cac96d19f94fc5efb389c417a, claim:424d3c373b8e6938ffec103bbb7897be82b3171cbb2d046654acedb28985dde9, claim:5edc8ad75534d044755391b2991d83ee3372643cc99376e9ec4a1fab86729842, claim:bbe0c54fc07c3bf2f27ac4ddce3d214429dffe6dbb1d3cfc393a422405de6afd, claim:5a4aeade721587e0ffc216ed600ef2d6f85413c680216850d0e3d678efbd4729, claim:d316d0f4ff7975e64168c097dd5b32b81445224bb430ad31eeea124d7b3c4a84, claim:bb5f5b727b3279881b0e2eb49c7f68b05b8bf764f5b7a223e7b4e38e5ce74b83, claim:560faacc005eeb0aa58bb33227b06ad8bb69e47a24a03bd9e8ea5fef0196650a, claim:5d8a3ffe7f17b62052b6468f9a7a57ac7f49950bb2579864320478d75a15fc31 -->

Environment variables and middleware are rendered from canonical CodeMap claims. Markdown here is a derived navigation layer, not the source of truth.

## Required Environment Variables
<!-- claim_ids: claim:0eb0602f7670734844a21290e89b0b70675ec5060c5475e9388a440d006ee260, claim:fedcb988b404fae0202be7890ff4a5286d4adab485cd19e6b2298af4154041ca, claim:aa87f0dbe80bebffcd05b81935ffc718ff4312b26e99c01bc1bd93105ff82a65, claim:bbe0c54fc07c3bf2f27ac4ddce3d214429dffe6dbb1d3cfc393a422405de6afd, claim:5a4aeade721587e0ffc216ed600ef2d6f85413c680216850d0e3d678efbd4729, claim:d316d0f4ff7975e64168c097dd5b32b81445224bb430ad31eeea124d7b3c4a84, claim:bb5f5b727b3279881b0e2eb49c7f68b05b8bf764f5b7a223e7b4e38e5ce74b83, claim:5d8a3ffe7f17b62052b6468f9a7a57ac7f49950bb2579864320478d75a15fc31 -->

- `AUTH_SECRET` [verified] — `tests/codemap.test.ts`
- `DATABASE_URL` [verified] — `tests/fixtures/config-app/.env.example`
- `JWT_SECRET` [verified] — `tests/fixtures/config-app/.env.example`
- `SESSION_SECRET` [verified] — `tests/codemap.test.ts`
- `STRIPE_SECRET` [verified] — `tests/codemap.test.ts`
- `VAR` [verified] — `src/detectors/config.ts`
- `VAR_NAME` [verified] — `src/detectors/config.ts`
- `VITE_VAR_NAME` [verified] — `src/detectors/config.ts`

## Optional Environment Variables
<!-- claim_ids: claim:424d3c373b8e6938ffec103bbb7897be82b3171cbb2d046654acedb28985dde9 -->

- `PORT` [verified] — `tests/fixtures/config-app/.env.example`

## Middleware
<!-- claim_ids: claim:909782b786d1f342121087195bd8dd0d37f13adc31354a416252c17f3be98d57, claim:f3313e608a58864075a532ead2db557f49ad44c4a6ffdfe4128ce47c70bd844a, claim:021b33a59fd0d7197d0498c72096e8309a4519fad8540865af5202003ec0ea8e, claim:6a431e61ea74ce6cd57764ab52bc8a5dc3fc7152769ddbc904b871fa3c1ef1f9, claim:6fd1c3e79dfcf7a49cf3b3428ef80653793b6e9cac96d19f94fc5efb389c417a, claim:5edc8ad75534d044755391b2991d83ee3372643cc99376e9ec4a1fab86729842, claim:560faacc005eeb0aa58bb33227b06ad8bb69e47a24a03bd9e8ea5fef0196650a -->

### auth
<!-- claim_ids: claim:909782b786d1f342121087195bd8dd0d37f13adc31354a416252c17f3be98d57, claim:f3313e608a58864075a532ead2db557f49ad44c4a6ffdfe4128ce47c70bd844a, claim:021b33a59fd0d7197d0498c72096e8309a4519fad8540865af5202003ec0ea8e, claim:6a431e61ea74ce6cd57764ab52bc8a5dc3fc7152769ddbc904b871fa3c1ef1f9 -->

- `auth` [verified] — `tests/fixtures/middleware-app/src/middleware/auth.ts`
- `auth` [verified] — `tests/fixtures/graph-app/src/auth.ts`
- `middleware` [verified] — `src/detectors/middleware.ts`
- `middleware` [verified] — `tests/fixtures/graph-app/src/middleware.ts`

### rate-limit
<!-- claim_ids: claim:5edc8ad75534d044755391b2991d83ee3372643cc99376e9ec4a1fab86729842 -->

- `rate-limit` [verified] — `tests/fixtures/middleware-app/src/middleware/rate-limit.ts`

### validation
<!-- claim_ids: claim:6fd1c3e79dfcf7a49cf3b3428ef80653793b6e9cac96d19f94fc5efb389c417a, claim:560faacc005eeb0aa58bb33227b06ad8bb69e47a24a03bd9e8ea5fef0196650a -->

- `middleware` [verified] — `src/codemap/extract/code/middleware.ts`
- `verify-middleware` [verified] — `src/codemap/verify/verify-middleware.ts`

## Conflicts

- [medium] conflicts: `middleware` vs `middleware` — middleware claims for middleware disagree on middleware type classification (auth vs validation)
- [low] duplicates: `middleware` vs `middleware` — middleware claims for middleware were detected in multiple files with the same auth classification
- [low] duplicates: `auth` vs `auth` — middleware claims for auth were detected in multiple files with the same auth classification
- [medium] conflicts: `middleware` vs `middleware` — middleware claims for middleware disagree on middleware type classification (auth vs validation)
