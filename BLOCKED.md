# Harness Rewrite Blockers

## Current status

No active blockers. Item 1.11 and D-017 were implemented by `1576b20bb` after an independent PASS; work continues with Phase 1 Tier A close/reopen boundary coverage.

## Resolved B-005 — Close versus synchronous provider fault winner ordering

- Date: 2026-08-11
- Resolved: 2026-08-12 — human selected option 1; recorded in D-015
- Phase: 1
- Work item: 1.9 — dispatch the retained assistant provider lease
- Trigger: §6 repeated review-agent rejection. Two review passes rejected the same underlying close-versus-provider-fault winner-ordering gap.
- Status: resolved and implemented by `7eea8b445`; Harness runtime 181/181, session storage 31/31, `npm run check` PASS, independent conformance review PASS

### Context

The asynchronous half is resolved: a `stream.result()` rejection arriving after `close()` is observed without changing the shell from `closed` to `fault`, and reopen remains uncertain.

One reentrant synchronous trace remains. Retained `streamSimple()` or `stream.result()` can synchronously call `shell.close()` and then throw. Close seals first, but the dispatch catch currently calls `#faultShell()` unconditionally, changing future calls from `closed` to `fault`.

### Decision

1. **Selected:** close-first wins. If a synchronous provider throw occurs after close sealed the shell, abort the owned controller, preserve `closed`, write nothing, and reopen from durable `effect_pending` as uncertain. A throw that wins before close keeps the existing fault-first behavior and original cause.
2. Fault always wins for a synchronous provider throw, even when provider reentrancy already sealed close. This differs from the approved asynchronous ordering and requires updating D-014 plus close tests.

### Resume point

For option 1, apply the asynchronous callback's winner arbitration to the synchronous catch; add direct reentrant-close regressions for both `streamSimple()` and `result()` throws; rerun focused/full Harness tests and `npm run check`; obtain a fresh independent PASS before commit.

## Resolved B-004 — Restore cannot validate a reserved usage ID with the current Storage contract

- Date: 2026-08-11
- Resolved: 2026-08-11 — human selected option 1; recorded in D-009 and implemented by `8f31fd0ba`
- Phase: 1
- Work item: 1.4 — Phase 1 runtime shell and pure next-action planner
- Trigger: §6 hard-to-reverse storage-contract decision found by independent architecture review
- Status: resolved; storage tests 31/31, `npm run check` PASS, independent implementation review PASS

### Context

An assistant `effect_pending` state durably reserves both a response entry ID and a usage-row ID. At escalation time, recovery could validate the response ID through the bounded `Storage.getEntries(ids)` query, but the domain-neutral Storage contract had no equivalent exact usage-row lookup. It therefore could not enforce `harness-v3.md` §3.3's requirement that a reserved usage ID, if already materialized, has the expected identity.

Normal atomic settlement cannot create a usage row without its response entry, but imported or corrupted durable state can. Inferring from absence or scanning the ledger is forbidden.

### Decision

The human selected option 1:

1. **Selected:** add a domain-neutral bounded `Storage.getUsageRows(ids)` point query, with the same exact-ID validation and immutable-map semantics as `getEntries`, then extend the shared Memory/SQLite conformance contract.
2. Narrow Phase 1 restore validation to entries/registers and rely on settlement atomicity plus ID uniqueness; explicitly defer exact reserved-usage validation. This is smaller now but does not fully satisfy the current §3.3 text.
3. Replace the separate exact lookups with a broader cross-kind item lookup. This is more invasive and is not recommended.

## Resolved B-003 — Exact-ID query validation runs after an unsafe clone

- Date: 2026-08-11
- Resolved: 2026-08-11 — human selected option 1; recorded in D-008 and implemented by `c4506dbd5`
- Phase: 1
- Work item: 1.3, increment B — typed Memory Session/repository
- Trigger: two independent review rejections for the same runtime input-validation reason
- Status: resolved; storage tests 30/30, Session tests 26/26, `npm run check` PASS, independent review PASS

### Context

The first review rejected incomplete exact validation for Session query objects and repository metadata. That was corrected and covered by table-driven tests. The second review found that `Session.getEntries()` still calls `structuredClone(ids)` before the Storage contract validates the list. A malformed list containing a symbol, accessor, or other non-cloneable value can therefore throw `DataCloneError`, which becomes `SessionError("storage")` instead of `SessionError("invalid_query")`.

Current uncommitted implementation otherwise passes session-storage 30/30, harness-runtime 26/26, and `npm run check`.

### Decision needed

1. **Recommended:** pass `ids` directly to `Storage.getEntries()`, whose contract already performs exact structural validation and does not mutate input; add Session-level malformed-list regressions, then re-review.
2. Add a duplicate exact-list validator in Session before cloning.
3. Accept generic `storage` classification for non-cloneable malformed lists.

Reply with `1`, `2`, or `3`.

## Resolved B-002 — Memory handle still exposes its core at runtime

- Date: 2026-08-11
- Resolved: 2026-08-11 — human selected option 1; recorded in D-007 and implemented by `48dfa1e0f`
- Phase: 1
- Work item: 1.3, increment A — reopenable Memory storage handles
- Trigger: two independent review rejections for the same lifecycle-encapsulation reason
- Status: resolved; package tests 30/30, `npm run check` PASS, independent review PASS

### Context

The first review rejected an exported `MemoryStorageState` that publicly exposed commit/read/drain operations. The rework moved those operations into a module-private core and limited `MemoryStorageState` to `createStorage()`. The second review found that `MemoryStorage` still stores the core in a TypeScript `private` field; that modifier is erased, so JavaScript can access `storage.core.commit(...)` after close and bypass handle admission.

Current uncommitted implementation and tests otherwise pass 29/29 package tests and `npm run check`.

### Decision needed

1. **Recommended:** approve replacing the TypeScript-private field with native runtime-private `#core`, then re-run review.
2. Accept TypeScript-private encapsulation as sufficient for this non-security API and proceed despite the review finding.
3. Use a module-private `WeakMap<MemoryStorage, Core>` instead of a native private field.

Reply with `1`, `2`, or `3`.

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
