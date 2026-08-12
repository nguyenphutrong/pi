# Harness Rewrite Decisions

## D-001 — Fork selectively and replace the Harness kernel

- Date: 2026-08-11
- Phase: 1
- Status: accepted by project instruction
- References: mission §0; `packages/agent/docs/harness-v2.md`; `packages/agent/docs/harness-v3.md` §§0.5, 1, 3, 4, 8–9

### Options

1. Extend the current `AgentHarness` record/reducer scaffold.
2. Build every provider, loop, tool, and product layer from scratch.
3. Keep upstream-compatible AI and loop foundations, but replace the durable Harness kernel and storage model.

### Choice

Option 3.

### Rationale

The existing provider, message, tool, compaction, and SQLite primitives are reusable. The current `LaneRecord`/reducer recovery model conflicts with the required current-state model: `lane.state → operation id → op.state`. Supporting both would create two recovery authorities and is explicitly forbidden.

## D-002 — Use the current-state store model where the older spec conflicts

- Date: 2026-08-11
- Phase: 1
- Status: accepted by project instruction
- References: mission §§0–2 and guardrails; `packages/agent/docs/harness-v2.md` §§5, 7, 13, 19; `packages/agent/docs/harness-v3.md` §§0.5, 1, 3, 4, 8–9

### Options

1. Implement the older record catalog and recover by reducing bounded history.
2. Treat the mission's explicit replacement rules as authoritative and use entries, registers, and usage rows with `op.state` as the durable program counter.

### Choice

Option 2.

### Rationale

The mission explicitly excludes `LaneRecord`, `appendRecord`, `findRecords`, `getLog`, configuration-change records, and recovery by historical reduction. The current-state model is also fully specified in the newer design document. The older spec remains a behavioral reference only where it does not require an excluded durable shape.

## D-003 — Prove Memory durability semantics before SQLite

- Date: 2026-08-11
- Phase: 1
- Status: accepted by project instruction
- References: phase plan §§2–3; `packages/agent/docs/harness-v3.md` §§1.4–1.7, 8 slice 1, 9.3

### Options

1. Build Memory and SQLite together.
2. Establish one backend-neutral contract and conformance suite with Memory first, then implement SQLite in Phase 3.

### Choice

Option 2.

### Rationale

It isolates transaction and recovery correctness from database lifecycle and lease concerns. The shared suite then becomes the acceptance contract for SQLite instead of allowing backend behavior to diverge.

## D-004 — Keep storage domain-neutral and validate in the Harness session boundary

- Date: 2026-08-11
- Phase: 1
- Status: accepted after design and independent architecture review
- References: `packages/agent/docs/harness-v3.md` §§1, 1.4, 2.8, 8 slice 1

### Options

1. Let `session-storage` own Harness-specific entry and register types.
2. Make `Storage` generic over an injected domain schema catalog.
3. Give `session-storage` concrete JSON envelopes and structural invariants; let the Harness session boundary own semantic schemas and typed codecs.

### Choice

Option 3.

### Rationale

Storage must not know agents, lanes, or conversations, and the spec assigns complete semantic validation to Session before storage admission. A domain-neutral envelope keeps dependencies pointing from `harness-runtime` and `session-sqlite` into `session-storage`, while typed decoding prevents malformed persisted data from reaching Harness code. Storage conformance covers atomicity, identity, sequence, register, query, stats, and close behavior; Harness codec conformance separately covers entry and register schemas.

## D-005 — Validate complete durable envelopes in `session-storage`

- Date: 2026-08-11
- Phase: 1
- Status: confirmed by human after B-001 escalation
- References: `packages/agent/docs/harness-v3.md` §§1.1, 1.4–1.5, 2.8, 9.3; D-004

### Options

1. Add reusable structural validators for complete backend-read `Entry`, `UsageRow`, and `Register` envelopes in `session-storage`.
2. Defer complete-envelope validation to the Harness Session codec.

### Choice

Option 1.

### Rationale

Storage owns structural envelope invariants, including storage-assigned sequence and timestamp fields. Harness remains responsible for semantic payload and typed register namespace validation. This keeps Memory and SQLite on one decoded-envelope contract without importing Harness types into either backend.

## D-006 — Put typed Session semantics in `harness-runtime` over reopenable Memory handles

- Date: 2026-08-11
- Phase: 1
- Status: accepted after design and independent architecture review
- References: `packages/agent/docs/harness-v3.md` §§2.1–2.8, 3.1–3.7, 8 slices 3–5, 9; D-004–D-005

### Options

1. Put the typed Session and repository directly in `session-storage` through generic injected codecs.
2. Add a separate `session-domain` package for entries, registers, Session, and repositories.
3. Put Harness-specific Session, repository, and codecs in `harness-runtime`, while `session-storage` supplies domain-neutral durable Memory state and disposable handles.

### Choice

Option 3.

### Rationale

The Session boundary owns Harness semantics without making storage know about messages, lanes, or operations, and it avoids a new package before there is demonstrated reuse. A Memory repository owns metadata and durable in-process state, enforces one active handle per session, and creates a fresh handle on reopen; closing a handle seals and drains it without destroying that state. Session creation publishes exactly one transaction containing `lane.leaf/main = null` and idle `lane.state/main`, with no lane configuration.

Phase 1 keeps its built-in `pi-ai` message codecs package-internal. Canonical extensible `AgentMessage` ownership is deferred until before custom messages or the product shell; this does not change the domain-neutral durable envelope. The Session item includes typed main-lane append, branch reads, and no-compaction context projection, but defers provider execution and operation registers to the runtime/planner item.

## D-007 — Keep shared Memory state inaccessible behind runtime-private handles

- Date: 2026-08-11
- Phase: 1
- Status: confirmed by human after B-002 escalation
- References: D-006; `packages/agent/docs/harness-v3.md` §§1.4, 2.8

### Options

1. Store the shared core in a native runtime-private `#core` field.
2. Rely on a TypeScript `private` field, which is erased at runtime.
3. Associate handles and cores through another module-private `WeakMap`.

### Choice

Option 1.

### Rationale

The state token exposes only handle creation, and native privacy prevents JavaScript callers from bypassing a closed handle to commit or read through its core. It is the smallest implementation that preserves the repository-owned state and disposable-handle design.

## D-008 — Let Storage validate exact-ID lists before Session reads

- Date: 2026-08-11
- Phase: 1
- Status: confirmed by human after B-003 escalation
- References: D-004–D-006; `packages/agent/docs/harness-v3.md` §§1.5, 2.8

### Options

1. Pass exact-ID lists directly to `Storage.getEntries()`, whose contract validates and does not mutate them.
2. Duplicate the exact-list validator in Session before cloning.
3. Allow malformed non-cloneable lists to surface as generic storage errors.

### Choice

Option 1.

### Rationale

Structural query validation has one authority. Session maps Storage's typed `invalid_query` result while retaining ownership of entry payload decoding; no pre-validation clone can change error classification or bypass the shared backend contract.

## D-009 — Add bounded exact usage-row lookup to Storage

- Date: 2026-08-11
- Phase: 1
- Status: confirmed by human after B-004 escalation
- References: `packages/agent/docs/harness-v3.md` §§1.5–1.6, 3.3–3.4, 4.4; D-004–D-005

### Options

1. Add `Storage.getUsageRows(ids)` with the same exact-ID and detached-result contract as `getEntries`.
2. Defer exact reserved-usage validation and rely on atomic settlement plus ID uniqueness.
3. Replace separate exact lookups with a cross-kind durable-item query.

### Choice

Option 1.

### Rationale

Assistant intent durably reserves a response entry ID and a usage-row ID. Recovery must validate either row when materialized without scanning the ledger or inferring state from absence. A bounded domain-neutral point query is the smallest complete contract and becomes part of the shared Memory/SQLite conformance suite. Commit `8f31fd0ba` implements it; package tests pass 31/31, `npm run check` passes, and independent review passes.

## D-010 — Build a canonical-state Phase 1 runtime shell behind an internal Session port

- Date: 2026-08-11
- Phase: 1
- Status: implemented by `3dbf5d7c0` after independent conformance review
- References: mission §§0–2; `packages/agent/docs/harness-v3.md` §§2.3, 2.8, 3.1–3.7, 4.1–4.5, 5.1–5.2, 8–9; D-004–D-009

### Options

1. Let the runtime reach Storage through a concrete Memory-only adapter and use a separate mutation line.
2. Add general conditional register writes to Storage before the Memory milestone needs independent writers.
3. Give Session a package-internal typed runtime port that shares its mutation line, retain canonical common run-state fields, and keep planning pure over decoded current state plus immutable scheduler facts.

### Choice

Option 3.

### Rationale

Storage remains domain-neutral and inaccessible to Harness callers. The internal Session port owns semantic register codecs, exact current-state reads, and typed commits. It rereads expected register sequences inside the one Session mutation line and commits at most once; these are logical stale-write tokens under one active Memory handle, not a claim of general backend CAS. Real transactional preconditions remain a prerequisite if independent writers are introduced.

Fresh Session state remains `{ currentOperationId: null, pendingNextRun: [] }`. Phase 1 exposes no queue behavior and accepts only an empty `pendingNextRun`. First Harness attachment atomically seeds only the missing idle `lane.config/main`; an existing configuration is authoritative.

Persisted Phase 1 run states retain the canonical common fields from §3.2: running control, total captured settings, empty inbox, and latest assistant identity. Only reachable phase discriminants are enabled: checkpoint `need_assistant`, assistant `ready`, assistant `effect_pending`, and checkpoint `may_finish`. Generation context stores the canonical configuration, curated JSON-safe stream options, normalized retry policy, and overflow marker inline; effect intent stores response/usage reservations and output/context limits. Later phases add new reachable values, not missing required fields or compatibility decoders.

Restore follows only current authority: `lane.config/main`, `lane.state/main`, `lane.leaf/main`, then `op.meta/O` and `op.state/O` when open. It batch-hydrates the exact entry and usage IDs those values name and validates that bounded rooted closure. It never scans branch history, entries, registers, or the usage ledger and never reads `lane.lastResult`. Repository inventory may enforce the temporary one-main-lane restriction, but is not recovery or a global orphan audit.

`nextAction` is pure over decoded durable values, exact hydrated rows, and immutable process-local scheduler facts such as live effect keys. This distinguishes a live pending effect from restored uncertainty without giving the planner Session, Storage, Models, clocks, ID generators, callbacks, or mutable maps. IDs are minted only by the executor that attempts their committing transition; discarded IDs carry no durable meaning.

One package-internal runtime-attachment claim is allowed per open Session handle, independently of repository active-handle ownership. Shell close writes nothing, seals admission, rejects local parked work, drains admitted Session mutations, and closes Session. Fault handling preserves the last committed prefix and performs no repair write.

The runtime-shell increment exposes no completion promise while provider and terminal seams are unimplemented. Stable peek and one-step execution may inspect or advance internal actions; public `runToCompletion()` is added only with the no-tool flow and resolves only after its terminal transaction. `Models.lease(provider, modelId)` is a separate additive upstream-mergeable `pi-ai` increment before provider dispatch; create, restore, and peek resolve no identities and start no effects.

The mission's phase order controls implementation sequencing: hooks, events, and watch remain Phase 5 even though Part 8 groups their primitives into an earlier broad build slice. Work item 1.4 is a narrower sub-slice and does not claim completion of that broad slice.

## D-011 — Prove the manual scheduler with one provider-free transition

- Date: 2026-08-11
- Phase: 1
- Status: implemented by `0ba92a6a8` after independent conformance review
- References: D-010; `packages/agent/docs/harness-v3.md` §§3.5–3.7, 4.1–4.5, 4.7, 5.1, 9.3

### Options

1. Add an internal exhaustive planner and manual scheduler, but execute only the provider-free `checkpoint need_assistant → assistant ready` transition.
2. Add a generic arbitrary-state transition executor shaped like the eventual full interpreter.
3. Make the scheduler observation-only until provider dispatch exists.

### Choice

Option 1.

### Rationale

The first generation transition is the smallest complete proof of pure planning, stable peeking, one-action release, executor-only ID minting, and conditional state commits. It snapshots detached stream options, normalized retry policy, and current lane configuration without resolving a provider or starting an effect. Ready preparation, live-effect waiting, restored uncertainty, matching materialized-settlement repair, and terminal finish remain explicit but non-executable actions until their owning increments land; attempting one rejects locally, writes nothing, and leaves it visible.

The executable plan carries expected `op.state`, `lane.state`, and `lane.config` sequence tokens plus the process-local harness-settings revision. An internal settings owner validates initial values, serializes snapshots on a settings mutation line, and starts at revision zero with no public setter. Execution acquires the settings line before the Session lane line, rereads every durable token and current-operation identity, and mints `stepId` only after those checks. Staleness reloads and replans but never releases the replacement action in the same call.

Planner/action types stay package-internal. `peekAction()` is side-effect free and strips correctness tokens from its stable description. `executeAction()` returns only a successfully released action; parked, stale, and closed cases are distinct errors. Shell close seals scheduler admission, lets earlier admitted Session work drain, writes nothing itself, and closes the Session idempotently.

This introduces no public API or Storage change, no generic state writer, and no provider, hook, event, tool, queue, compaction, or terminal behavior.

## D-012 — Lease provider request identity without resolving auth

- Date: 2026-08-11
- Phase: 1
- Status: accepted after design and independent architecture review
- References: D-010–D-011; `packages/agent/docs/harness-v3.md` §§0.7, 4.1, 5.7, 8 runtime-shell slice

### Options

1. Capture the selected provider and model object identities, plus a provider-bound auth path that resolves current credentials only when a leased request starts.
2. Deep-clone and recursively freeze the model while capturing provider callables and auth handlers.
3. Build a private one-provider `Models` collection for every lease and delegate requests through it.

### Choice

Option 1.

### Rationale

`Models.lease(provider, modelId)` is a synchronous registry snapshot: it performs no auth, refresh, network access, or provider request. A successful lease retains the exact provider and model selected in that turn, so later provider replacement, deletion, or catalog replacement cannot redirect the request. Its methods resolve auth at request time through the captured provider's auth implementation and the collection's current credential store, preserving login, logout, OAuth refresh, caller overrides, and cancellation without consulting the provider registry again.

The existing `Model` contract permits provider extension data under `samplingParams`, so structural cloning is not total, and freezing would add behavior not required by the spec. The lease therefore captures the model reference rather than inventing immutable value semantics. Provider methods execute with the captured provider as receiver so implementations that use `this` remain valid. Fetch failures remain stream-backed settled error messages, while deferred cancellation continues to reject directly.

The `pi-ai` change is additive: one general `ModelRequestLease` interface and one `Models.lease` method, with no Harness concepts or provider-adapter changes. `ModelRuntime`, as a separate `Models` implementation, captures its composed provider and configured request-header inputs while retaining live credential resolution; it must not delegate through a path that rereads mutable provider/config registries.

The first implementation review rejected exporting the low-level `resolveProviderAuth` helper so `ModelRuntime` could rebuild the captured request path. The approved rework keeps auth private and adds an optional `createModels` binder for lease-only header enrichment. The binder synchronously captures the selected provider/model's configuration references without I/O; its request-time transform receives resolved-plus-caller environment and runs after auth/model headers but before explicit headers and the caller's final transform. `ModelRuntime.lease` then delegates to the underlying lease, so provider identity, auth, lazy errors, and deferred behavior retain one implementation authority.

## D-013 — Split prompt acceptance from assistant-effect intent

- Date: 2026-08-11
- Phase: 1
- Status: implemented by `32ef80020` and `2eca9c11f`; independent conformance review PASS
- References: D-010–D-012; `packages/agent/docs/harness-v3.md` §§3.3–3.7, 4.1–4.5, 5.1, 9.3

### Options

1. Implement prompt acceptance and assistant-effect intent as one combined change.
2. Keep work item 1.8 but split it into two independently buildable transitions: idle prompt acceptance, then assistant lease plus durable effect intent.
3. Add a provisional shell prompt first and defer the public acceptance invariants until completion exists.

### Choice

Option 2, without provisional acceptance semantics.

### Rationale

Acceptance and effect intent are separate atomic transitions in §§3.6–3.7 and have different failure boundaries. Increment 1.8a implements spec-conformant acceptance: under shell admission and the settings-before-lane ordering, it synchronously preflights the configured provider/model identity, then the Session mutation line rereads and validates the authoritative idle configuration, state, leaf, and directly rooted entry. Missing identity, stale state, busy state, malformed input, or close-before-admission writes nothing. Only after those checks does the executor mint globally unoccupied operation and prompt-entry ids and atomically insert the ordered prompt chain, move the leaf, create `op.meta` and checkpoint `op.state`, and set `lane.state.currentOperationId`. Caller messages retain every supported `AgentMessage` role. The internal result updates the runtime attachment but exposes neither a completion promise nor `runToCompletion()`.

Identity preflight is not retained as the later request lease. Increment 1.8b snapshots a fresh `ModelRequestLease` outside the lane mutation line while holding the settings snapshot, then asks the Session transition to reread and validate the expected operation, lane, and configuration sequences plus the bounded rooted closure. A missing or throwing lease returns an explicit unavailable result and leaves `ready` unchanged. A stale transition discards the captured lease. A current transition mints globally unoccupied response and usage ids, calculates `contextWindow` from the leased model and `intendedOutputLimit` from the effective pre-clamp request options with the model maximum as fallback, and atomically replaces `op.state` with `effect_pending` before any provider dispatch.

After a successful intent commit, the shell synchronously retains the complete process-local assistant plan under `assistant:{operationId}:{stepId}:{attempt}`. The plan contains the exact lease, projected request context, effective options, and durable correlation ids. It is never persisted or exported, and future dispatch must use it without rereading the provider registry. A failed commit installs no live key. Reopen has the durable pending intent but no process-local plan, so the pure planner selects uncertain-effect recovery rather than claiming that dispatch never started.

Every newly minted id is checked pairwise and through exact entry, usage-row, and relevant operation-register lookups before commit; backend uniqueness remains the final atomic guard. No provider request, auth resolution, hook, public Harness API, Storage contract, history scan, or record/reducer compatibility path is added by this work item. Provider dispatch and atomic response/usage settlement remain later increments.

## D-014 — Separate assistant dispatch, await, and settlement boundaries

- Date: 2026-08-11
- Phase: 1
- Status: implemented by `7eea8b445` after independent conformance review
- References: D-010–D-013; `packages/agent/docs/harness-v3.md` §§3.7, 4.1–4.8, 5.2, 9.3

### Options

1. Track one discriminated process-local assistant effect as `planned`, `running`, or `settled`, with separate dispatch, await, and settlement actions.
2. Keep separate planned, running, and settled maps.
3. Let one existing await action both dispatch and wait for the provider result.

### Choice

Option 1.

### Rationale

The three local states match the interpreter boundaries without adding durable state. A pending durable intent with an exact local `planned` value exposes `dispatch_assistant_effect`; `running` exposes `await_assistant_effect`; `settled` exposes a parked `settle_assistant_effect`; an absent exact key exposes uncertain recovery. Matching materialized reservations retain precedence over every local state. The pure planner receives only each key's status, never leases, promises, controllers, contexts, options, or messages.

Dispatch publishes a harness-owned controller in the running state before synchronously invoking the exact retained `lease.streamSimple(context, {...options, signal})`. It installs fulfillment and rejection observation in the same turn and returns without awaiting. Await waits only that observed promise, validates and detaches the terminal assistant message, then replaces running with settled without a storage write. Provider `error` and `aborted` terminal messages remain valid in-band outputs; durable settlement is a later transition.

No provider registry, current model lookup, credential helper, or auth surface is consulted after the lease captured in 1.8b. The retained context is passed by identity, retained options remain unmodified, and the harness adds only its own signal at dispatch.

Close seals new admission, notifies parked await work, and aborts running controllers immediately. It drains already-admitted scheduler work, aborts again to cover a delayed admitted dispatch, clears every local assistant state, and closes Session without writing. The serialized provider-start check is later than shell action admission: close that wins it prevents the provider call and rejects the dispatch as closed; provider start that wins may run once and is then signalled. Close never waits for provider cooperation, so a provider that ignores abort cannot deadlock Session closure.

A synchronous stream throw, rejected result promise, malformed terminal message, or pending terminal message violates the `pi-ai` stream contract. It removes the local proof, faults and seals the current shell, aborts other effects, preserves the durable `effect_pending` prefix, and rejects pending/future local calls. The same handle must not execute recovery after an invariant fault; only close/reopen may observe the absent key and apply uncertain-effect policy.

Work item 1.9 stops at the process-local settled state. `settle_assistant_effect` remains stable and write-free but unavailable until the response/usage/classification transaction lands. No public API, Storage schema, provider adapter, event/hook surface, or completion promise changes.

## D-015 — Preserve the first terminal shell condition across provider reentrancy

- Date: 2026-08-12
- Phase: 1
- Status: confirmed by human after B-005 escalation and implemented by `7eea8b445`
- References: D-014; `packages/agent/docs/harness-v3.md` §§4.2, 4.7–4.8, 9.3

### Options

1. Close-first wins when provider code synchronously reenters `close()` and then throws; fault-first remains a fault.
2. A synchronous provider throw always reclassifies the shell as faulted, even after close sealed it.

### Choice

Option 1.

### Rationale

Close and fault are terminal process-local conditions, so the first one observed must remain authoritative. If provider code reenters `close()` from `streamSimple()` or `result()` and then throws, close has already sealed admission and pulled the owned signal. The throw is consumed, dispatch rejects as closed, no storage write occurs, and reopen applies uncertain recovery to the durable `effect_pending` prefix. A synchronous or asynchronous provider contract failure observed before close still faults the shell with its original cause. This makes synchronous and asynchronous outcome arbitration identical and prevents provider callback timing from changing a closed handle's classification.

## D-016 — Settle only the Phase 1 no-tool success classification

- Date: 2026-08-12
- Phase: 1
- Status: implemented by `c0dae84c2` after independent conformance review
- References: D-010, D-013–D-015; `packages/agent/docs/harness-v3.md` §§3.2–3.7, 4.1–4.8, 8, 9.3

### Options

1. Inline settlement checks and commit only the currently supported success path.
2. Add one narrow package-private pure classifier, but expose only the currently supported success path to the durable transition.
3. Widen the durable union now with tools, retry, deferred, failure-drain, cancellation, and overflow states so every provider result can settle.

### Choice

Option 2.

### Rationale

D-010 deliberately makes only checkpoint `need_assistant`/`may_finish` and assistant `ready`/`effect_pending` reachable in Phase 1. Settlement therefore commits only a call-free `stop`, or a call-free `length` whose `usage.output` is at least the persisted `intendedOutputLimit`. A lower-output `length` is suspected overflow. Responses containing tool calls, `toolUse`, `error`, `deferred`, and suspected overflow remain valid process-local outputs but are unavailable to this increment: settlement stays parked and writes nothing. An `aborted` response while durable control is still running is different: the owned signal was not pulled by durable cancellation, so the spec classifies it as corruption and the shell faults without writing.

Classification is pure and occurs after Session reloads the latest durable state. The Session mutation line verifies semantic effect authority — current operation, assistant `effect_pending`, step, attempt, response/usage reservations, captured provider/model, and trigger leaf — instead of rejecting on old operation, lane, configuration, settings, or leaf sequence numbers. This preserves the §4.1 settlement rule: future unrelated state changes may advance register sequences while the same exact effect remains pending, and settlement merges into the latest total state. With one mutation line, a semantically current absent settlement always commits; old sequence changes do not create a separate pending outcome.

The successful transaction has exactly four ordered writes: insert reserved response entry R under the current trigger, set `lane.leaf/main = R`, insert reserved usage row U linked to R, and replace `op.state/O` with the latest run state updated to `latestAssistantEntryId = R` plus checkpoint `may_finish` triggered by R. Provider `responseId` remains payload data and is never confused with durable entry id R. Message usage remains in the payload and is also copied completely into ledger row U. All four writes land or none do.

Session returns a structured observation: committed, matching materialized reservations, obsolete effect, or unsupported classification. RuntimeShell updates its attachment before changing local proof. It deletes the exact settled value only after commit, validated materialization, or confirmed obsolescence; unsupported classification retains it. Matching materialization never inserts again and lets planner repair keep precedence. Partial or mismatched reservation materialization is corruption. Storage/corruption failures fault the shell through D-015 first-terminal-condition arbitration. Close-first writes nothing; settlement admitted first may commit and close waits.

Commit `c0dae84c2` implements this boundary. Harness runtime tests pass 202/202, session-storage tests pass 31/31, `npm run check` passes, `git diff --check` passes, and the independent conformance review reports PASS with no blocking findings.

## D-017 — Reconcile terminal Phase 1 no-tool completion conditionally

- Date: 2026-08-12
- Phase: 1
- Status: implemented by `1576b20bb` after independent conformance review
- References: D-010–D-016; `packages/agent/docs/harness-v3.md` §§1.3, 3.2–3.5, 3.12–3.13, 4.1–4.4, 4.7–4.8, 5.1–5.2, 8–9

### Options

1. Keep `finish_run` as a distinct action and add one narrow completed-run terminal transition.
2. Fold terminal cleanup into assistant settlement, removing the durable `may_finish` boundary.
3. Build the future generic terminal kernel and public completion surface together now.

### Choice

Option 1, with the full terminal-cleanup ownership contract but only the completed no-tool result variant currently reachable.

### Rationale

The separate finish boundary preserves deterministic close/reopen behavior and leaves room for later checkpoint work such as `before_run_end`. Unlike assistant settlement, finish is an ordinary conditional transition: it requires the planner's expected `op.state` and `lane.state` sequences as well as semantic validation of the latest total state. A changed token reloads and replans without writing; no configuration or settings token is needed because finish snapshots neither.

Inside the lane mutation line, finish rereads and validates lane state, leaf, `op.meta/O`, `op.state/O`, and the exact final assistant entry. The lane must still own O; the state must be running at checkpoint `may_finish` with an empty Phase 1 inbox and `includeFinalAssistant:true`; leaf, checkpoint trigger, and `latestAssistantEntryId` must name the same assistant entry.

The completed terminal transaction owns this ordered shape:

```text
delete op.meta/O
delete op.state/O
delete every op.tool_args key prefixed O:
delete every op.preparation key prefixed O:
delete every operation-owned pending.entry key
set lane.lastResult/main
set lane.state/main with only currentOperationId cleared
```

Valid Phase 1 no-tool state has empty prefix and pending-entry deletion sets, so its transaction has exactly four writes: the two operation-register deletes, `lane.lastResult`, then latest total `lane.state`. The executor nevertheless discovers and deletes defensive `op.tool_args/O:*` and `op.preparation/O:*` leaks now, preserving §3.13 ownership before those namespaces become reachable. Operation-owned `pending.entry` is provably empty under the current codecs; its explicit ids and deletion tests land before queues or abort can make it non-empty. Lane-owned `pendingNextRun` is never deleted, and the final lane-state write spreads the latest value before clearing only operation ownership.

The Harness-owned narrow durable result is `{ operationId, kind:"run", outcome:"completed", leafId, finalAssistantEntryId, runCompletion:"assistant" }`, with exact fields, UUIDv7 ids, and equal leaf/final-assistant ids. Restore never reads `lane.lastResult`. The transition also returns a detached internal result `{ operationId, kind:"completed", leafId, finalEntryId, finalMessage }` computed from the authoritative persisted entry. RuntimeShell installs the idle attachment only after commit and keeps returning the released `finish_run` action; it does not add a singleton completion slot, change prompt semantics, or expose `runToCompletion()`/`getLastResult()` yet.

Close-first prevents terminal admission and reopen plans `finish_run`; finish-first commits completely and close waits. A commit or codec failure faults without publishing idle state or a result, subject to D-015 first-terminal-condition ordering. Public results, prompt completion promises, generic outcomes, queues, abort, hooks/events, and structural operations remain deferred.

Commit `1576b20bb` implements the conditional terminal transition, exact narrow result codec, deterministic operation-register cleanup, committed-only internal result, and shell execution boundary. Harness runtime tests pass 218/218, session-storage tests pass 31/31, `npm run check` passes, `git diff --check` passes, and the independent conformance review reports PASS with no blocking findings.

## D-018 — Complete Phase 1 Tier A coverage by durable state, not process-local effect status

- Date: 2026-08-12
- Phase: 1
- Status: implemented by `69eb76d7f` after independent conformance review
- References: D-010–D-017; `packages/agent/docs/harness-v3.md` §§1.3–1.7, 3.2–3.7, 3.13, 4.1–4.8, 5.1–5.2, 8, 9.1–9.3

### Options

1. Add only the missing close/reopen integration cases to the existing runtime-shell tests and retain current complete boundary tests.
2. Duplicate every Phase 1 boundary in one new table-driven recovery suite.
3. Extract shared recovery fixtures into a new test-support surface and create a separate Phase 1 recovery file.

### Choice

Option 1.

### Rationale

Phase 1 has six distinct durable recovery positions: idle, checkpoint `need_assistant`, assistant `ready`, assistant `effect_pending` with absent reservations, assistant `effect_pending` with matching materialized reservations, and checkpoint `may_finish`. The terminal transaction returns the lane to idle.

Provider effect statuses `planned`, `running`, and `settled` are process-local sub-boundaries over the same durable `effect_pending` state. Close writes nothing and discards their local lease, controller, promise, or settled message, so every such close/reopen deterministically plans `recover_assistant_effect`. Matching materialized response and usage reservations are different bounded durable evidence and retain precedence, planning `repair_materialized_assistant`.

Existing tests already provide complete close/reopen coverage for accepted `need_assistant`, absent-reservation `effect_pending` at planned/running/settled local positions, settled `may_finish`, failed terminal commit, and terminal idle. The increment adds only the missing durable `ready` and matching-materialization close/reopen cases. It does not duplicate Tier C close races or add process-kill mechanics, which belong to the next work item.

Recovery authority remains `lane.state/main` to `op.meta/O` and `op.state/O`, with bounded exact entry and usage hydration. Restore performs no history, branch, configuration, register, or usage-ledger scan. Close performs no durable write. A committed terminal state restores idle without reading `lane.lastResult/main`.

Matching materialization is a supported recovery prefix, not a normal assistant settlement boundary: ordinary settlement still inserts the reserved response and usage and advances the total operation state in one atomic transaction. No production behavior, Storage contract, LaneRecord API, provider adapter, public completion API, or new test-support abstraction is introduced.

Commit `69eb76d7f` adds the two missing close/fresh-handle/reopen integration cases. Harness runtime tests pass 220/220, session-storage tests pass 31/31, `npm run check` passes, `git diff --check` passes, and the independent conformance review reports PASS with no blocking findings.

## D-019 — Model Phase 1 kill coverage as fresh-handle loss over one end-to-end commit-cut matrix

- Date: 2026-08-12
- Phase: 1
- Status: implemented by `5afa0cc35` after B-006/B-007 resolution and independent conformance review
- References: D-003, D-006, D-010–D-018; `packages/agent/docs/harness-v3.md` §§1.3–1.7, 2.8, 3.2–3.7, 3.13, 4.1–4.8, 8, 9.1–9.3

### Options

1. Treat D-018's per-durable-state close/reopen tests as the complete item 1.13 evidence.
2. Retain D-018 as Tier A state coverage and add one narrow end-to-end manual commit-cut matrix over the real Phase 1 no-tool path.
3. Add a reusable commit fault-injection or Memory snapshot/process-kill harness.

### Choice

Option 2.

### Rationale

Memory durability is intentionally in-process. `MemoryStorageState` owns the durable maps while `MemoryStorage`, `MemorySession`, RuntimeShell, scheduler state, provider leases, controllers, promises, and settled outputs are disposable handles or process-local values. Phase 1 therefore defines a kill as discarding those local objects, closing or abandoning the active handle, creating a fresh handle from the same repository-owned state, and restoring from current registers. It makes no OS process-crash durability claim; SQLite process-crash testing belongs to Phase 3.

D-018 already proves every distinct reachable durable recovery position: idle, checkpoint `need_assistant`, assistant `ready`, assistant `effect_pending` with absent reservations, assistant `effect_pending` with matching materialized reservations, and checkpoint `may_finish`. Provider-local `planned`, `running`, and `settled` intervals are not additional durable states: all reopen from the same `effect_pending` prefix without a live key and deterministically expose `recover_assistant_effect`. Matching materialization instead exposes `repair_materialized_assistant`.

Item 1.13 adds only integration evidence that the actual `prompt → provider → final response` path reaches those commit cuts in order. The audit includes session creation, first configuration seed, prompt acceptance, assistant ready, assistant intent, provider planned/running/locally-settled aliases, assistant settlement, and terminal finish. At each cut it asserts the complete durable inventory, absence of partial transaction artifacts, fresh-handle next action or idle state, no provider resolution during restore, and no recovery write.

Unknown-effect execution remains intentionally unavailable in the current Phase 1 runtime. Deterministically exposing `recover_assistant_effect` after runtime loss is the acceptance result; driving that action through retry or synthetic settlement is owned by later generation-recovery work.

No production Storage API, serialization format, SQLite backend, child process, provider adapter, public completion surface, history reducer, or LaneRecord compatibility path is introduced.

The final audit instruments the real repository-owned Memory handle from `MemorySessionRepo.create()` onward. A fixed clock and deterministic O/P/S/R/U generator make metadata, operation state, entry envelopes, reservation identity, and every transaction value independently exact. Its prefix includes repository initialization, configuration seed, acceptance, ready, intent, settlement, and terminal cleanup. Every fresh `repo.open()` handle is separately instrumented and proves that open, attach, action planning, and close commit nothing and never resolve a model.

Commit `5afa0cc35` adds only test coverage. Focused repository/runtime-shell tests pass 114/114, Harness runtime passes 230/230, session-storage passes 31/31, `npm run check` passes, `git diff --check` passes, and the independent D-019 review reports PASS with all historical and B-007 findings resolved.

## D-020 — Accept Phase 1 and advance to durable tools only after two independent final gates

- Date: 2026-08-12
- Phase: 1
- Status: accepted
- References: D-003–D-019; Phase 1 mission done bar; `packages/agent/docs/harness-v3.md` minimal no-tool runtime and testing tiers

### Decision

Phase 1 is complete. The independent whole-phase reviewer traced the actual no-tool state machine, storage transactions, provider effect sandwich, terminal cleanup, package boundaries, forbidden-legacy absence, and D-018/D-019 recovery evidence and returned PASS. A separate Recovery/QA pass then reran Harness runtime 230/230, session-storage 31/31, pi-ai provider-lease 44/44, coding-agent lease integration 6/6, `npm run check`, and `git diff --check`; all passed from a clean worktree.

Unknown-effect execution, retry, public completion promises, automatic drive, tools, abort, queues, hooks/events, SQLite, and OS-process durability remain explicit later-phase work rather than Phase 1 gaps. Phase 2 may now begin, but only after re-reading its authoritative tool, recovery, abort, terminal, API, and testing sections.

## D-021 — Keep agent-loop private and use the fork scope for fork-owned packages

- Date: 2026-08-12
- Phase: 2
- Status: implemented by `b8d312e62` after independent review
- References: B-008; target `packages/agent-loop` boundary

### Options

Visibility:

1. Create `@nguyenphutrong/pi-agent-loop` as a private workspace-only package.
2. Publish `pi-agent-loop` as a supported public package.

Scope:

1. Rename only the future `agent-loop` package to the fork scope.
2. Rename every fork-owned package, including the existing Harness runtime and session storage packages, while retaining upstream-owned public package identities.

### Choice

Visibility option 1 and scope option 2.

### Rationale

The private package establishes the required internal boundary without prematurely creating a public API. A single fork-owned scope makes ownership explicit and avoids introducing a mixed identity convention for new fork-only modules. Therefore the existing packages become `@nguyenphutrong/pi-harness-runtime` and `@nguyenphutrong/pi-session-storage`, and the future package will be `@nguyenphutrong/pi-agent-loop`.

Public upstream packages retain their existing `@earendil-works` scope, including `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`. The coding-agent installer identity also remains under its existing upstream scope. This decision changes npm identity only and does not change package directories or production behavior.

Commit `b8d312e62` applies the two existing package renames, source and tooling resolution updates, internal-workspace recognition for both scopes, and the regenerated root lockfile. Session storage passes 31/31, Harness runtime passes 230/230, script tests pass 5/5, `npm run check` passes, `git diff --check` passes, fresh local workspace links resolve under `@nguyenphutrong`, and the independent review reports PASS.

## D-022 — Keep the legacy public loop independent from the private Harness loop package

- Date: 2026-08-12
- Phase: 2
- Status: confirmed by human after B-009 escalation
- References: D-021; B-009; target three-layer architecture; `packages/agent/docs/harness-v3.md` §§5.7, 8

### Options

1. Keep the current public `pi-agent-core` loop unchanged and make private `@nguyenphutrong/pi-agent-loop` canonical only for the new Harness architecture.
2. Vendor compiled private-package artifacts into `pi-agent-core/dist` during every public build.
3. Physically stage and bundle the private package as a nested dependency in the public tarball.

### Choice

Option 1.

### Rationale

The target architecture requires `harness-runtime` to use a narrow session-agnostic agent-loop boundary and forbids a dependency on the broad legacy agent package. It does not require the retained public compatibility package to consume that boundary. Keeping the legacy loop independent avoids an unpublished runtime dependency, custom build-time copying, nested-package staging, shrinkwrap exceptions, and fork-specific release coupling in an upstream package.

The private package is the single behavior authority for the new Harness architecture. The legacy loop remains upstream-compatible reference and compatibility behavior outside that architecture; it is not a recovery, durability, or product-runtime authority. Shared conformance vectors cover overlapping contracts without creating package coupling. `pi-agent-core` receives no dependency on the private package and no build, pack, or release changes.

## D-023 — Keep Harness private with its private agent-loop dependency

- Date: 2026-08-12
- Phase: 2
- Status: implemented by `ccf86e630` after independent review
- References: D-021–D-022; B-010; package and local-release contracts

### Options

1. Make `@nguyenphutrong/pi-harness-runtime` private workspace-only, while keeping `session-storage` public.
2. Keep Harness public and publish `@nguyenphutrong/pi-agent-loop` as a supported public package.
3. Keep Harness public and vendor compiled private-loop artifacts into its public distribution.

### Choice

Option 1.

### Rationale

Harness needs a real runtime dependency on the narrow loop package. A public Harness depending on an unpublished package would produce a publishable but uninstallable tarball; development, optional, or peer dependency forms do not satisfy that runtime import. Making Harness private preserves the selected private agent-loop boundary without adding vendoring, nested-package staging, or release exceptions.

`session-storage` remains public because it has an independently installable contract and no private runtime dependency. Public release discovery already excludes packages marked private; local release must remove Harness from its explicit tarball list. Once agent-loop exists, the internal root build orders it before Harness. Coding-agent shrinkwrap and install-lock remain unchanged while neither private package enters that dependency closure.

Commit `ccf86e630` marks Harness private and removes only its explicit local-release artifact. The public-package inventory excludes Harness and retains session storage; `npm run check` and `git diff --check` pass, no lockfile change is required, and the independent implementation review reports PASS.

## D-024 — Split stateless tool phases from durable sequential orchestration

- Date: 2026-08-12
- Phase: 2
- Status: implemented by `bd7cefe5b` after independent review
- References: D-021–D-023; `packages/agent/docs/harness-v3.md` §§0.4–0.5, 3.8, 3.13, 4.1–4.8, 5.6–5.7, 9; `packages/agent/docs/harness-v2.md` tool behavior and crash catalog

### Options

1. Put tool lookup, callbacks, effects, durable state, and recovery together in Harness.
2. Move the complete tool-batch driver and durable callbacks into `agent-loop`.
3. Put only the stateless `prepareToolCall → executeToolCall → finalizeToolCall` phases and narrow contracts in `agent-loop`, with all durable orchestration in Harness.

For aggregate callback failure:

1. Reject the phase promise and leave ordinary callback defects to Harness.
2. Ignore callback failure and preserve the previous value.
3. Normalize callback failure into a call-level synthetic error while keeping per-handler isolation inside the Harness hook registry.

### Choice

Boundary option 3 and callback option 3. Phase 2 executes tool calls sequentially; parallel execution remains deferred.

### Rationale

`@nguyenphutrong/pi-agent-loop` is a private, session-agnostic package. It owns tool lookup, `prepareArguments`, argument validation and replacement revalidation, one aggregate before callback, one tool invocation with transient updates, one aggregate after callback, replay declarations defaulting to `never`, and result/error normalization. It knows no Session, storage, durable id, register, operation state, transaction, recovery policy, running-effect map, hook registry, or batch state machine. Legacy public `pi-agent-core` remains unchanged and independent.

Harness owns the complete batch plan, source-order interpreter, `EffectPlan`, process-local running map, hooks and events, recovery, abort, and commits. Durable call state is exactly:

```ts
type ToolCall =
  | { status: "planned"; sourceIndex: number; resultEntryId: string }
  | { status: "effect_pending"; sourceIndex: number; resultEntryId: string;
      replay: "never" | "safe" }
  | { status: "completed"; sourceIndex: number; resultEntryId: string;
      terminate: boolean };
```

The source call is derived from `ToolBatch.assistantEntryId + sourceIndex`. Effective arguments use exactly `op.tool_args/{operationId}:{turnId}:{sourceIndex}`, where `turnId` is the producing generation `stepId`; call id, name, raw arguments, and an argument key are not duplicated in state.

The complete batch and every reserved result id commit atomically before lookup, preparation, hooks, or effects. Successful clearance atomically writes effective arguments and `effect_pending(replay)` before dispatch. Settlement atomically writes the reserved result, lane leaf, optional finalized tool-usage row, and total state with `completed(terminate)`. Synthetic results report no usage. Unlike the older record design, this register design has no usage-without-result crash state. All effective-argument registers remain until the final source-position settlement, which also deletes the whole batch prefix and enters `may_finish(includeFinalAssistant:false)` only when every result terminates; otherwise it enters `need_assistant(false)`. Terminal cleanup defensively deletes any operation-owned argument prefix.

Recovery uses only `lane.state → op.meta/op.state` plus bounded direct hydration. A planned call reruns clearance under its existing result id. A live `effect_pending` call awaits its exact process-local promise. After process loss, it never reruns clearance or infers a live effect: persisted arguments replay only when both persisted and current declarations are `safe` and current policy allows; otherwise the reserved id receives a synthetic `interrupted` result. Cancellation settles unstarted planned calls as `aborted`, never replays restored pending calls, and permits already-live effects to settle. The interpreter remains `dispatch → await_effect → finalizeTool → settlement`.

The Harness hook registry and the loop's aggregate callbacks have different failure contracts. Registry handlers run in registration order. Ordinary hook failures emit `handler_error`, skip that handler, and continue according to that hook's aggregation. `before_tool` instead fails closed: a throw, rejection, invalid output, or valid first block is terminal and later `before_tool` handlers do not run. A valid `block` field is `{ reason: string; terminate?: boolean }`; `reason` is mandatory.

An aggregate before callback throw, rejection, invalid output, or invalid replacement arguments becomes one immediate synthetic error with `isError:true`, `terminate:false`, no updates, no persisted arguments, and no tool effect. Only an intentional valid block may preserve its nested `terminate`. An aggregate after callback throw, rejection, or invalid patch replaces the raw result completely with a synthetic error carrying `isError:true`, `terminate:false`, and no usage; the real effect and already emitted transient updates remain observable. Valid after patches replace `content`, `details`, `isError`, `usage`, and `terminate` field by field without deep merge. Invalid external tool results are normalized before any durable write.

Tool updates are transient, accepted only while the tool promise is active, drained before execution resolves, and ignored when late. Public listener failures are isolated by Harness before reaching the aggregate sink; aggregate sink rejection is an internal fault, not a replay-safe tool error. Genuine accepted `length` responses still receive a complete plan, then source-ordered explanatory errors with no lookup, hook, or effect. Missing tools, argument failures, blocks, and before failures settle from planned state without an intent. Tool throws become raw error results and still pass through after finalization unless abort won first. Sequential execution settles every source position; one terminating result never short-circuits the batch.

The conformance bar covers every normal, error, invalid-output, abort, update, and replay-default path in the stateless phases. Harness Tier A must cover every source position and durable call status, replay declaration combination, exact-argument hydration/corruption, synthetic outcome, abort position, prefix cleanup, and resumed-versus-uninterrupted result. Tier B proves exact `plan → clearance → args+intent → effect → updates → finalize → atomic settlement → prefix cleanup/checkpoint` order. Tier C drives both abort/close orders around every boundary and compares manual with automatic durable state.

The independent final design gate reports PASS. Commit `bd7cefe5b` creates the private package, its 95-case conformance suite, root build and type paths, lockfile entry, and the private Harness dependency without changing legacy agent behavior. Focused tests pass 95/95, `npm run check` passes, `git diff --check` passes, and the independent implementation review reports PASS. Parallel tools, queues, full hook/event facilities, compaction, SQLite, serving, and legacy-loop refactoring remain deferred.
