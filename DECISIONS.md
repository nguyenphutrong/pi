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
