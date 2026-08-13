# Harness Rewrite Blockers

## Current status

No active blockers. Phase 4.1 is complete at `219526a1a`; deferred tree writes are next.

## B-015 — Choose the exact SQLite commit-boundary oracle bar

- Date: 2026-08-13
- Phase: 3
- Work item: 3.4a — RuntimeShell SQLite commit-boundary audit
- Trigger: two independent implementation reviews rejected the same work item for incomplete exact durable/effect evidence; usage-ledger exactness remains the repeated underlying reason
- Resolved: 2026-08-13 — human selected option 1
- Status: resolved and implemented by `152a49b38` after focused 34/34, complete Harness and SQLite suites, root check, and fresh independent review PASS

### Context

The test-only matrix covers all 17 prefixes of the Phase 2 sequential-tool trace for both `safe` and `never` over real SQLite files. It uses fresh repository, Session, and RuntimeShell ownership after every controlled close; verifies exact action identities, replay counts, real versus interrupted tool results, terminal tree and cleanup; snapshots all nine SQLite tables; and proves a third fresh terminal shell performs no effects or writes.

The first implementation review rejected weak action identities, an incomplete nine-table snapshot, incomplete usage fields, and incomplete terminal cleanup. Those were corrected. The second fresh review confirms those findings are closed but still rejects the oracle because assistant-retry contexts are checked only at the first and last call, and usage rows are checked for type/order/association rather than the exact UUIDv7 identity contract and exact settlement sequence relationship. This repeats the usage-ledger exact-evidence boundary, so §6 requires escalation rather than another unilateral test expansion.

### Decision

1. **Selected:** finish the literal oracle. Assert every provider context for normal and uncertain cuts; require each usage id to be UUIDv7; and require each usage sequence to equal its assistant entry sequence plus two, matching the settled response transaction's exact `entry → lane.leaf → usage → op.state` order. Rerun focused/full verification and a fresh independent review.
2. Narrow D-043 to semantic ledger equivalence: exact response association, payload, adjustment/details, uniqueness/disjointness, and increasing order are sufficient; add only the missing complete provider-context assertions, then review against the narrowed decision.
3. Accept the current 34/34 matrix despite the repeated review failure. This violates the guardrail and is not recommended.

### Resume point

Do not commit `packages/harness-runtime/test/sqlite-runtime-commit-boundary.test.ts`. After selection, record the choice in `DECISIONS.md`, apply only the selected test-oracle change, rerun the focused matrix, complete Harness and SQLite suites, `npm run check`, `git diff --check`, and obtain a fresh independent PASS before committing.

## B-014 — Apply segment creation identity on the exact-tip path

- Date: 2026-08-13
- Phase: 3
- Work item: 3.3e — segmented entry projection, divergence, and guarded branch scans
- Trigger: two independent review-agent rejections for the same incomplete `segment:{creationEntryId}` validation boundary
- Resolved: 2026-08-13 — human selected option 1
- Status: resolved; recorded in D-040 and implemented by `4a94c253c` after independent final review PASS

### Context

D-039 requires every private branch id to be `segment:{newEntryId}`, with that creation entry physically present in the segment. The first review found that candidate/base branches accepted arbitrary ids. The rework added exact `segment:{UUIDv7}` and suffix-membership validation while materializing divergence candidates. The second review found the same invariant is still absent from the exact-tip fast path: `EXACT_TIP_SQL` checks only a non-empty, non-NUL string and matching canonical parent sequence. A malformed or non-owned branch id can therefore append and advance successfully without entering candidate materialization.

The current uncommitted implementation otherwise passes SQLite 120/120, package build, `npm run check`, and `git diff --check`. Canonical entry/membership sequence comparison, divergence ownership, compaction bounds, rollback, query plans, and handle isolation are green. Per the guardrail, it cannot be committed while review remains failing.

### Decision

1. **Selected:** extract one private segment-identity assertion that validates `segment:{UUIDv7}` and point-checks that the suffix entry is physically present in that segment. Use it from both exact-tip and materialized-candidate paths, add exact-tip malformed/missing-owner regressions, then run a fresh review. This is the smallest complete correction and keeps the fast path bounded.
2. Materialize and validate the exact-tip segment's complete closure before every append. This also closes the gap but adds unnecessary full-chain work to the hot append path.
3. Accept format-only validation on exact-tip and defer suffix ownership to reads/repair. This permits a known-invalid cache transition and violates D-039; not recommended.

## B-013 — Choose the runtime-safe SQLite callback capability

- Date: 2026-08-13
- Phase: 3
- Work item: 3.3b — shared ordered SQLite transaction engine
- Trigger: two independent review-agent rejections for the same runtime capability-isolation reason
- Resolved: 2026-08-13 — human selected option 1
- Status: resolved; recorded in D-036 and implemented by `cdd033a62` after final independent review PASS

### Context

D-035 requires transaction callbacks to receive only statement preparation, so they cannot open a nested transaction, close the connection, or bypass the ordered engine. The first implementation passed the full `SqliteDatabase`; its rework narrowed the TypeScript type to `Pick<SqliteDatabase, "prepare">` but still placed the original database object in the runtime context. A callback can therefore cast or dynamically inspect `context.db` and recover `transaction`, `close`, and `exec`. The second independent review correctly rejected this as the same underlying issue.

The corrected engine passes 29/29 focused tests and 46/46 package tests. Package build, `npm run check`, and `git diff --check` pass. Final independent review confirms the implementation satisfies D-035 and B-013 with no remaining finding.

### Decision

1. **Selected:** keep the current private callback shape, but pass a new frozen runtime object containing only `prepare: (sql) => db.prepare(sql)`. Add runtime assertions that `transaction`, `close`, and `exec` are absent, then rerun the complete verification and fresh independent review. This is the smallest correction and preserves D-035.
2. Replace `context.db` with a direct `context.prepare(sql)` capability. This also closes the leak but changes the approved private callback shape more broadly without adding safety over option 1.
3. Accept compile-time-only capability narrowing. This leaves the reviewed runtime escape hatch and violates D-035; not recommended.

## B-012 — Confirm the exact canonical SQLite DDL validation approach

- Date: 2026-08-13
- Phase: 3
- Work item: 3.3a — private SQLite adapter and canonical schema
- Trigger: two independent review-agent rejections for the same exact-schema validation boundary
- Resolved: 2026-08-13 — human selected option 1
- Status: resolved; recorded in D-034 and implemented by `2cf987b40` after independent final review PASS

### Context

The first review rejected schema reopen validation that compared only table/index/trigger names. The rework added durable-object inventory and canonical SQL validation, but the second review correctly found that testing whether an object's normalized SQL was a substring of the full schema could still accept a table missing trailing `WITHOUT ROWID`.

The current uncommitted rework derives one exact normalized DDL fingerprint for every canonical `(type, name)` pair from the executable schema and compares each reopened `sqlite_schema.sql` value by equality. Regressions now cover an extra view, a same-name index with changed columns, and a same-name canonical table missing `WITHOUT ROWID`. The complete package passes 17/17 tests; the schema and adapter subset passes 15/15. `npm run check` and `git diff --check` pass. The first post-decision review found no implementation defect and rejected only this stale checkpoint, which is now corrected.

### Decision

1. **Selected:** approve the current exact `(type, name) → normalized DDL` map, run a fresh independent review, and commit only if it passes.
2. Replace the derived exact map with 18 separately declared DDL constants before review. This makes comparisons visibly direct but duplicates and fragments the executable schema.
3. Validate only object inventory and trust `user_version` for definitions. This is smaller but accepts malformed current-version schemas and repeats the rejected behavior.

## B-011 — Decide whether failed-response identity remains self-authenticating

- Date: 2026-08-12
- Phase: 2
- Work item: 2.3 — generation unknown-effect recovery
- Trigger: §6 repeated review-agent rejection for the same exact durable-validation boundary
- Resolved: 2026-08-13 — human selected option 1
- Status: resolved; recorded in D-025 and implemented by `e6e6b1cd0` after independent final review PASS

### Context

D-025's cap transaction writes an exact synthetic assistant response and then replaces generation state with the v3-specified `failure_drain { error, provenance:{kind:"response",entryId} }`. The latest state deliberately no longer contains `GenerationContext`, response usage id, or a recovery timestamp. Restore can therefore verify the response's entry id, parent, role, Harness API, empty content, zero usage, stop reason, error text, and exact optional-field absence. It cannot independently prove that the persisted provider/model/timestamp equal values discarded by the same atomic transition.

The third reviewer requires those three comparisons. Satisfying that literally requires changing the durable `failure_drain` shape to retain duplicate provider/model/timestamp evidence. Comparing provider/model to current `lane.config` is incorrect because the captured generation configuration may differ after a concurrent configuration change. Comparing a timestamp to itself adds no validation. History lookup is forbidden.

This follows two earlier review corrections on the same work item: exact response/error consistency and exact retry-wait diagnostics. Under §6, another unilateral schema choice is not allowed.

### Decision

1. **Selected:** keep the canonical v3 `failure_drain` shape. Treat provider/model/timestamp as self-authenticating typed response fields after the writer transaction; restore validates every independently verifiable relationship but does not compare a value to itself. Record this boundary in D-025, obtain a fresh review against it, and commit only after PASS.
2. Extend `failure_drain` provenance with expected provider, model, and response timestamp so restore can compare them. This duplicates settled entry data, changes the durable state contract, and diverges from `harness-v3.md` §3.2.
3. Compare provider/model to current `lane.config` and accept the false-corruption risk when configuration changes after generation start. Timestamp remains unverifiable. Not recommended.

### Outcome

The restore check now compares no entry-owned field to itself, while exact field-set and independently representable relationship checks remain. Sequence authority was added after the final review found a separate stale-action gap. Harness runtime passes 266/266, root check and diff check pass, and a fresh independent review reports PASS.

## B-010 — Choose how Harness distributes its private agent-loop dependency

- Date: 2026-08-12
- Phase: 2
- Work item: 2.1 — private agent-loop boundary
- Trigger: §6 hard-to-reverse package and release-contract decision found during corrected design review
- Resolved: 2026-08-12 — human selected option 1
- Status: resolved; recorded in D-023

### Context

`@nguyenphutrong/pi-harness-runtime` is currently public: its manifest has no `private` marker, release discovery includes it, and local release packs and isolated-installs its tarball. The planned private `@nguyenphutrong/pi-agent-loop` is a real runtime dependency of Harness. A public Harness tarball may publish with that dependency, but consumer installs and the isolated npm/Bun release smoke test will fail when they try to fetch the unpublished package.

`devDependencies`, optional dependencies, and peer dependencies do not solve a required runtime import. Coding-agent shrinkwrap/install-lock are currently unaffected because Harness is outside that dependency closure. `session-storage` can remain public independently because its dependency graph contains no private package.

### Decision needed

1. **Selected:** make `@nguyenphutrong/pi-harness-runtime` private workspace-only too. Keep `session-storage` public, remove Harness from public/local-release tarball inventories, and build private `agent-loop` before private Harness. This preserves D-021/D-022 without custom packaging.
2. Keep Harness public and change `@nguyenphutrong/pi-agent-loop` to public. Both install normally, but this reverses the selected private-package decision and creates a supported public API now.
3. Keep Harness public and vendor compiled private-loop implementation into `harness-runtime/dist`. The tarball remains installable without a private dependency, but Harness gains custom build, declaration, source-map, clean, pack, and release verification machinery.

The user also directed the orchestrator to apply future evidence-backed recommendations automatically and ask only when it genuinely cannot decide between materially different outcomes.

### Resume point

After selection, record D-023's package visibility together with the corrected durable-tool design, rerun independent design review, and only then create `packages/agent-loop`.

## B-009 — Choose the legacy public agent compatibility strategy

- Date: 2026-08-12
- Phase: 2
- Work item: 2.1 — private agent-loop boundary
- Trigger: §6 ambiguous, hard-to-reverse public-package and release architecture decision after independent design disagreement
- Resolved: 2026-08-12 — human selected option 1
- Status: resolved; recorded in D-022, and `packages/agent-loop` has not yet been created

### Context

The target architecture requires the new Harness kernel to consume a narrow private `@nguyenphutrong/pi-agent-loop` package rather than the broad legacy `packages/agent`. It does not unambiguously require the existing public `@earendil-works/pi-agent-core` tarball to consume the same private package. The target monorepo layout omits the legacy agent package, while the upstream-mergeability guardrail asks that retained Pi foundations remain close to upstream.

The first Design pass recommended build-time vendoring so both consumers share one implementation. Independent review rejected that recommendation: vendoring adds custom JS/declaration copying and release verification to an upstream public package even though the new Harness does not need it. Keeping the legacy loop independent avoids release coupling but retains a bounded legacy implementation beside the new canonical Harness implementation.

An npm prototype also established that `bundleDependencies` does not bundle a workspace symlink directly. Making nested bundling work requires a physical staging install before every pack and changes shrinkwrap/install-lock handling.

### Decision needed

1. **Selected:** keep the current public `pi-agent-core` loop unchanged and independent. Make private `@nguyenphutrong/pi-agent-loop` canonical only for the new Harness architecture, and use shared conformance vectors to limit behavioral drift. This is the smallest and most upstream-mergeable option.
2. Vendor the private package's compiled JS and declarations into `pi-agent-core/dist` during build. Both consumers share one source implementation, but the public package gains custom build, clean, pack, source-map, and release verification machinery.
3. Bundle the private package as a nested dependency inside the public tarball. This requires physical staging because npm does not bundle workspace symlinks, exposes the private package identity in a public artifact, and complicates npm/Bun release and lock generation.

The legacy implementation remains compatibility evidence outside the target architecture, not a second recovery or Harness authority. It gains no dependency on the private package and no custom packaging machinery.

### Resume point

After selection, record D-022, correct the tool-state design so durable `ToolCall` state stores only source index/result id plus status-specific replay or terminate, then obtain an independent design PASS before creating or extracting code.

## B-008 — Choose the `agent-loop` package visibility

- Date: 2026-08-12
- Phase: 2
- Work item: 2.1 — durable sequential tool design
- Trigger: §6 hard-to-reverse package/public contract decision found by the Design agent
- Resolved: 2026-08-12 — human selected private workspace-only visibility and the fork-owned npm scope
- Status: resolved; recorded in D-021

### Context

The reusable `prepareToolCall → executeToolCall → finalizeToolCall` behavior is currently private inside broad `packages/agent`, which also contains the forbidden legacy harness/reducer. Making `harness-runtime` depend on that package would violate the target boundary and create a later migration. The target layout already names `packages/agent-loop`, so the recommended design creates that narrow package now and lets both `agent` and `harness-runtime` consume it.

The unresolved choice is whether creating the package also commits the project to a new published public API. Publishing is hard to reverse. A private workspace package still establishes the correct internal dependency boundary and can be made public later.

### Decision needed

1. **Selected:** create `@nguyenphutrong/pi-agent-loop` as a private workspace package. Export only the contracts and three phases required internally; keep current `pi-agent-core` exports/behavior intact. Publishing can be decided later without migrating the kernel.
2. Create `@nguyenphutrong/pi-agent-loop` as a public lockstep-versioned package now. Its exports become a supported external contract and must join release artifacts immediately.
3. Do not create the package yet; export the phases from `pi-agent-core` and accept a temporary `harness-runtime → agent` dependency. This conflicts with the target boundary and is not recommended.

The same decision renames the existing fork-owned packages to `@nguyenphutrong/pi-harness-runtime` and `@nguyenphutrong/pi-session-storage`. Public upstream packages retain `@earendil-works`, including `pi-ai` and `pi-agent-core`.

### Resume point

After selection, correct the preliminary design before recording it: `ToolCall` state must follow `harness-v3.md` and store only source index/result id plus status-specific replay or terminate; tool call id/name come from the durable assistant entry, and the `op.tool_args` key is deterministic rather than duplicated in state. Then run an independent design review before implementation.

## B-007 — Resolve the remaining literal D-019 audit evidence

- Date: 2026-08-12
- Resolved: 2026-08-12 — human selected option 1
- Phase: 1
- Work item: 1.13 — kill-at-every-boundary recovery coverage
- Trigger: §6 repeated review-agent rejection after the human selected B-006 option 1
- Status: resolved and implemented by `5afa0cc35`; focused 114/114, Harness runtime 230/230, Storage 31/31, `npm run check` PASS, independent conformance review PASS

### Verified state

The current rework independently constructs exact O/P/S/R/U UUIDv7 identities, the complete `RunOperation`, all four reachable `RunState` values, ordered transaction writes at cuts 0/1/2/5/6, exact intent-to-settlement R/U linkage, terminal result and cleanup, and globally empty operation-cleanup namespaces. Focused tests pass 114/114, Harness runtime passes 230/230, Storage passes 31/31, `npm run check` passes, and `git diff --check` passes.

The independent gate still reports three blocking evidence gaps:

1. `startedAt` is read back from the accepted operation, and materialized entry timestamps are compared to themselves, so those generated values are not independently fixed.
2. The writer audit instruments a synthetic idle fixture after initialization, so it does not include the repository's initial lane transaction in the claimed end-to-end prefix.
3. The real `MemorySessionRepo.create → close → open` matrix proves the restored action and zero provider lease, but does not directly instrument each reopened handle to prove restore performs zero commits.

### Decision

1. **Selected:** finish the literal audit with test-only instrumentation. Mock `Date.now`, wrap `MemoryStorageState.prototype.createStorage()` before `MemorySessionRepo.create()`, inventory the initial lane transaction plus every subsequent exact transaction, and assert every reopen/attach/peek handle records zero commits. No production or public API changes.
2. Narrow D-019 to treat storage-assigned timestamps, repository initialization, and restore write-freedom as composition of existing conformance/repository tests rather than requiring all three in this end-to-end matrix. Keep the current exact operation/state and R/U audit.
3. Accept the current evidence despite the review failure. This overrides the guardrail and is not recommended.

### Outcome

Commit `5afa0cc35` fixes all three evidence gaps without changing production code or public APIs. The independent review passed; orchestration advanced to the Phase 1 done-bar review.

## B-006 — Choose the Phase 1 end-to-end writer-audit completeness bar

- Date: 2026-08-12
- Resolved: 2026-08-12 — human selected option 1
- Phase: 1
- Work item: 1.13 — kill-at-every-boundary recovery coverage
- Trigger: §6 repeated review-agent rejection. Two review passes rejected the writer audit for not proving complete state values and exact intent-to-settlement reservation identity.
- Status: decision resolved; implementation rework in progress and no flagged test code has been committed

### Context

D-019 correctly defines a Phase 1 kill as losing the RuntimeShell, Session, Memory handle, and provider-local state, then reopening a fresh handle over repository-owned in-process Memory state. True OS process-crash durability remains Phase 3 SQLite work.

The uncommitted tests now prove the real `MemorySessionRepo.create → attach → prompt → transition → close → open` lifecycle at every normal cut and restore the correct action. A complementary instrumented writer audit proves exact transaction counts, write order, and write identities. The second review still requires the audit to duplicate every complete `RunOperation` and `RunState` value, and to derive R/U from intent before proving settlement uses exactly those same ids. It also requires the isolated cleanup namespaces to be entirely empty rather than merely free of operation-prefixed keys.

### Decision needed

1. **Selected:** complete the fully exact end-to-end writer audit. Rework the test to build exact expected operation/state values for acceptance, ready, intent, settlement, and finish; carry R/U from intent into settlement assertions; assert cleanup namespaces are globally empty. This is test-only and adds duplication, but satisfies the literal D-019 bar.
2. **Keep a shape-complete end-to-end audit and rely on existing exact transition/codec tests for values.** Revise D-019 to require exact transaction count/order/identities plus durable-state action recovery, not one duplicated assertion of every total state field. Carry R/U linkage and empty namespace assertions into the current test, then review against the narrower decision.
3. **Drop the new writer audit.** Treat D-018 plus existing writer-conformance, close-race, failed-commit, and fresh-handle tests as the Phase 1 boundary evidence; defer a consolidated end-to-end exact matrix until SQLite process-crash testing in Phase 3.

### Resume point

Do not commit `packages/harness-runtime/test/repo.test.ts` or `packages/harness-runtime/test/runtime-shell.test.ts` while the review remains failing. After the selection, update D-019, make the selected test-only rework, rerun focused tests, Harness runtime, Storage, `npm run check`, and `git diff --check`, then request a fresh independent review. Repeated rejection after the human decision remains blocking rather than permission to bypass review.

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
