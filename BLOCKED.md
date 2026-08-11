# Harness Rewrite Blockers

No current blockers.

## Resolved B-001 — Confirm ownership of decoded durable-envelope validation

- Date: 2026-08-11
- Resolved: 2026-08-11 — human selected option 1; recorded in D-005
- Phase/work item: 1 / 1.2 — `session-storage` contract and Memory backend
- Trigger: §6 repeated review rejection. Review pass 1 rejected incomplete runtime structural validation; after that was expanded and regression-tested, review pass 2 rejected the same boundary for lacking validators for complete decoded durable envelopes.
- State: implementation and tests are uncommitted. Focused/package tests pass 22/22, but one current branch-order expectation is now known to encode incorrect `oldestFirst` stop behavior. No flagged code may be committed.

### Decision needed

Choose where structural validation of complete backend-read envelopes belongs:

1. **Finish it in `session-storage` now (recommended).** Add reusable validators for complete storage-assigned `Entry`, `UsageRow`, and `Register` envelopes (`seq`, `timestamp`, exact fields), while keeping Harness-specific entry payload and register namespace semantics in `harness-runtime`.
2. **Move it to the next Harness Session codec work item.** Keep `session-storage` validators write-only and accept that each backend must return structurally trusted envelopes until the typed Session boundary decodes them.

Option 1 matches D-004's split: storage owns structural envelope invariants; Harness owns semantic schemas. It also lets Memory and future SQLite share one decoded-envelope contract without importing Harness types.

### Unconditional fix after resolution

`MemoryStorage.branch()` must construct the full path, apply requested order, then apply inclusive `stopAtId`/`stopAtType`, filtering, cursor, and limit. The current implementation stops newest-first before reversing, so `oldestFirst` returns the wrong segment.

### Resume point

If option 1 is confirmed: implement the three durable-envelope validators, fix branch ordering, update conformance for both orders and repeated stop types, rerun focused tests and `npm run check`, then request a fresh independent review. If option 2 is confirmed: fix branch ordering only, document the deferred codec ownership in `DECISIONS.md`/`PLAN.md`, then review again.
