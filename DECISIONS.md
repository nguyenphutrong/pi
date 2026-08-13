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

## D-025 — Recover an unknown generation through durable retry wait or synthetic failure

- Date: 2026-08-12
- Phase: 2
- Status: implemented by `e6e6b1cd0` after B-011 human confirmation and independent final review
- References: D-010–D-020; `packages/agent/docs/harness-v3.md` §§3.2, 3.7, 3.12–3.13, 4.1, 4.4–4.8, 9.1–9.3; `packages/agent/docs/harness-v2.md` retry and recovery behavior

### Options

1. Atomically replace the restored uncertain intent with durable `retry_wait`, cross a separately visible timer effect, release to `ready`, and let the ordinary preparation transition allocate a later attempt's fresh response and usage ids. At the captured cap, atomically settle the uncertain attempt under its reserved ids and enter `failure_drain`.
2. Replace the uncertain intent directly with `ready` and keep the backoff deadline only in process memory.
3. Leave the uncertain intent current during backoff, then combine later-attempt preparation, id allocation, and the replacement intent in a recovery-only transition.

### Choice

Option 1.

### Rationale

The captured retry policy is operation state, so process loss must not erase its deadline or reset an attempt count. Recovery applies only under running control with `1 <= k <= maxAttempts`. Below the cap means exactly `k < maxAttempts`: one commit writes only total `op.state`, `effect_pending(k) → retry_wait(nextAttempt:k+1, notBefore, errorMessage)`. Delay is `min(Number.MAX_SAFE_INTEGER, baseDelayMs * 2^(k-1))`, and `notBefore` is `min(Number.MAX_SAFE_INTEGER, capturedNow + delay)`, where `capturedNow` is read inside the current recovery transition after authority validation. The stable retry diagnostic is `"Provider outcome unknown after interruption"`.

The timer is an independently released process-local action. Completion installs only an exact local elapsed proof keyed by operation id, step id, `nextAttempt`, and `notBefore`; a proof for another wait can never release this one. A second action conditionally commits `retry_wait → ready` while preserving the same `nextAttempt` without another increment. This preserves stable peeking and the one-effect-or-one-transaction manual boundary. Close during the timer releases no proof and writes nothing. Close before the ready commit leaves the same durable deadline; reopen waits only its non-negative remainder.

The ordinary `prepare_assistant_effect` path remains the only authority that resolves the captured model lease, projects context, calculates request limits, allocates response/usage ids, and commits an intent. It accepts the persisted later attempt number and allocates fresh ids only after the `ready` state is current. The uncertain attempt's reserved ids are never reused by another provider effect and may remain unmaterialized below the cap.

At the cap means exactly `k === maxAttempts`. Recovery needs no provider identity and performs one atomic transaction: insert a synthetic assistant error under the uncertain attempt's `responseEntryId`, move `lane.leaf/main`, insert zero usage under its `usageId`, and replace total state with `latestAssistantEntryId` plus response-provenance `failure_drain`. The exact `OperationError` is `{ code: "provider_interrupted", message: "Provider outcome unknown after interruption" }`. The synthetic message uses captured provider/model identity, `api: "harness"`, empty content, zero usage, `stopReason: "error"`, and the same string as `errorMessage`. Its message timestamp is `Date.now()` captured inside the current recovery transition after authority validation. Zero usage has zero `input`, `output`, `cacheRead`, `cacheWrite`, and `totalTokens`, with zero `input`, `output`, `cacheRead`, `cacheWrite`, and `total` cost; optional usage fields are absent. The ledger row copies that exact usage and sets `adjustment:false`. `api: "harness"` identifies Harness as the producer rather than fabricating an adapter API that is absent from `GenerationContext`; `pi-ai` already permits application-defined API strings. This changes neither `pi-ai` nor Storage.

After this atomic transaction, the canonical `failure_drain` state retains only its exact `OperationError` and response entry id. Provider, model, and message timestamp are entry-owned typed fields whose prior generation context and captured clock value are intentionally no longer duplicated in operation state. Restore validates their runtime types through the message codec, but does not compare them to current lane configuration, reconstruct discarded generation context, or compare values to themselves. Current lane configuration may legitimately differ from the captured generation configuration. Restore still requires the exact synthetic field set, Harness API, empty content, zero usage with no optional usage fields, error stop reason and message, response parent, provenance, lane leaf, and latest-assistant relationship. Tier B's exact cap transaction is the evidence that the writer copied captured provider/model and recovery time correctly; Tier A validates the independently representable current-state relationships. Human confirmation of B-011 selected this canonical v3 boundary instead of extending `failure_drain` with duplicate evidence.

With the Phase 2 inbox still empty, `failure_drain` has no input to restart work. Its next ordinary action is a failed terminal transaction: delete operation-owned registers, write `lane.lastResult` with `outcome:"failed"`, the exact `OperationError`, and `leafId`/`finalAssistantEntryId` both equal to the synthetic response entry id, omit `runCompletion`, then clear only `lane.state.currentOperationId`. The result references the durable response by id and never embeds it. It runs no provider request and no normal finish hook. Queue draining and cancellation variants remain deferred to their ordered Phase 2 work items.

Option 2 loses the deadline on reopen and violates the specified durable `retry_wait` state. Option 3 restarts a full delay after close, duplicates request preparation in recovery, and couples identity resolution to scheduling. Neither is acceptable.

Replacing a below-cap intent with `retry_wait` intentionally leaves its old response/usage strings unmaterialized and no longer reserved: current-state invariant 15 gives reservation authority only to ids named by the latest `op.state`. Tier A covers uncertain attempts below and at the cap, invalid attempt/policy relationships, exact timer-proof matching, every new durable prefix, fresh later ids, exact independently verifiable synthetic response/usage/provenance relationships, bounded write-free restore, and failed terminal cleanup. Writer/close-reopen coverage proves recovery intent, timer, ready release, later request intent, exact cap synthesis including provider/model/timestamp, and failed finish remain distinct boundaries. No public Harness API, provider adapter, private agent-loop behavior, Storage contract, history reducer, or forbidden legacy record surface changes.

Commit `e6e6b1cd0` implements the complete boundary. Recovery and retry-release transitions carry exact planned `op.state` and `lane.state` sequence authority, so even an identical-value rewrite makes an old action stale before clock capture or commit. Harness runtime passes 266/266, `npm run check` and `git diff --check` pass, and the independent final review reports PASS with no blocking or non-blocking findings.

## D-026 — Settle a tool-bearing response with its complete batch plan atomically

- Date: 2026-08-13
- Phase: 2
- Status: implemented by `929407e39` after independent final review
- References: D-024–D-025; `packages/agent/docs/harness-v3.md` §§3.2–3.3, 3.7–3.8, 4.1, 4.4–4.5, 9.1–9.3; `packages/agent/docs/harness-v2.md` tool-batch crash catalog

### Options

1. Commit the assistant response and usage first, then allocate and commit the tool batch in a second transition, preserving v2's X1 prefix.
2. In the assistant settlement transaction, insert the response, move the leaf, insert usage, and replace generation state with the complete all-planned tool batch and all reserved result ids.
3. Reserve possible tool-result ids in the assistant effect intent before provider dispatch, then select the used subset at settlement.

### Choice

Option 2.

### Rationale

Harness v3 makes the operation state the program counter and explicitly folds the complete tool plan into assistant settlement. The transaction writes, in order, the reserved response entry, `lane.leaf/main`, the reserved usage row, and total `op.state` with `latestAssistantEntryId` equal to that response and `phase.tools.batch` containing every source call. The only crash prefixes are therefore the prior assistant `effect_pending`, recovered under D-025, or the complete all-planned batch. There is no durable response-without-usage or response-without-plan state.

The batch copies the producing generation's captured `configuration`, uses its `stepId` as `turnId`, and derives source calls from the durable assistant entry. Tool-call id, name, and raw arguments are not duplicated in state. Calls contain consecutive `sourceIndex` values and pairwise-distinct result ids reserved before the transaction; those ids are followers of the response id so assistant and results share a timestamp partition. Allocation validates pairwise distinction from every directly known correlation and reservation id, absence from the shared entry/usage id namespace, and any explicitly conflicting current operation-register identity before any write. Arbitrary register keys do not join the entry/usage namespace. The settlement remains one atomic commit, so failed validation, allocation, occupancy checks, or storage commit publish none of it.

Restore hydrates the batch's assistant entry and any completed result entries by exact id. For the all-planned slice it validates `assistantEntryId === latestAssistantEntryId === lane.leaf`, a complete ordered source-index mapping onto the response's tool calls, a UUIDv7 `turnId`, and unique unmaterialized result reservations. It reads no tool-argument register because planned calls have none, resolves no model or tool identity, scans no history, and writes nothing. The planner identifies source index zero under its existing result id as the first unfinished call. A later resume may enter clearance only after the required tool identity and batch context resolve; otherwise it reports missing identities without a write. Item 2.4 parks before lookup, argument preparation, hook, or tool effect.

Option 1 carries a superseded v2 record-era crash prefix into the v3 register state machine and requires a new intermediate state solely for implementation sequencing. Option 3 cannot know call count or order before the provider response and would create unused reservations. Neither is acceptable.

This item changes no Storage contract, provider adapter, `pi-ai` surface, public Harness API, or private `agent-loop` behavior. Clearance, `op.tool_args`, replay, dispatch, tool settlement, abort, genuine-length explanatory results, and batch completion remain later Phase 2 work.

Commit `929407e39` implements the complete boundary. Tool-bearing `stop`, `toolUse`, and genuine output-limit `length` responses commit response, leaf, usage, and complete planned batch atomically; below-limit `length`, errors, and deferred responses remain later classification work. Result ids are follower UUIDv7s and restore validates their timestamp relationship, exact source ordering, planned non-materialization, assistant closure, and lane/latest identity without scans, identity resolution, or writes. Harness runtime passes 283/283, `npm run check` and `git diff --check` pass, and the fresh independent final review reports PASS.

## D-027 — Persist sequential tool clearance before dispatch

- Date: 2026-08-13
- Phase: 2
- Status: implemented by `be47c4560` after independent final review
- References: D-024–D-026; `packages/agent/docs/harness-v3.md` §§3.2–3.3, 3.8, 4.1–4.7, 5.7, 9.1–9.3

### Options

1. Perform one process-local clearance action through `@nguyenphutrong/pi-agent-loop` `prepareToolCall`, ending in one atomic prepared-intent or immediate-result transaction, without executing the tool.
2. Split lookup/validation and `before_tool` into additional process-local and durable stages.
3. Combine clearance with execute, finalize, and settlement.

### Choice

Option 1.

### Rationale

The kernel does not import legacy `packages/agent` types. RuntimeShell owns a narrow private, structurally compatible context-aware runtime-tool option and adapter; `@nguyenphutrong/pi-agent-loop` continues to own only stateless `AgentTool` phases. This is a routine package seam within the already approved private architecture, not a §6 public or storage-contract decision, and it does not change D-021–D-023's private package or public release decisions.

At prompt admission, every `activeToolName` must exist alongside the model or acceptance is write-free unavailable. At the first action for a batch, RuntimeShell captures definitions for every `batch.configuration.activeToolNames`, resolves `toolContext` exactly once, binds plain `AgentTool` leases, and retains the immutable snapshot under `assistantEntryId`. Missing definitions are write-free unavailable. A `toolContext` callback throw or rejection is a trusted deterministic application defect and faults the shell under §4.7; it is not missing identity. The source call is derived only from `assistantEntryId + sourceIndex`. A source name outside the retained active lease produces the ordinary immediate not-found result.

One process-local `prepare_tool_call` performs lookup, `prepareArguments`, initial validation, aggregate `before_tool`, and replacement validation through `prepareToolCall`. Full hook-registry event aggregation remains deferred; this slice accepts one narrow aggregate before callback. Only a successful prepared-intent commit retains the same tool lease and prepared call for later dispatch.

The prepared transaction is conditionally authorized by the expected lane-state sequence, operation-state sequence, current operation id, exact tools batch, assistant, turn, source, and result identities, first-unfinished position, leaf sequence and value, and absent argument register and result/usage reservations. It sets `op.tool_args/{operationId}:{turnId}:{sourceIndex}` to detached JSON-object effective arguments, then sets total `op.state` with only this planned call changed to `effect_pending(replay)`. It writes no entry, usage, leaf, or effect. RuntimeShell publishes the process-local prepared plan only after commit; obsolete or failed commits never publish or dispatch.

The immediate transaction uses the same authority. It inserts the reserved `ToolResultMessage` with parent equal to `assistantEntryId` or the prior completed result id, sets `lane.leaf/main`, and sets total `op.state` with the call `completed(terminate)`. It writes no argument register or usage row. The mutation line captures the message timestamp after authority validation. `pi-agent-loop` normalizes the synthetic output with `isError:true`; only a valid intentional block may retain `terminate:true`.

Clearance is strictly source ordered: only the first non-completed call may clear, every earlier call must be completed, and every later call remains planned. A pending earlier call blocks later clearance. If immediate settlement completes the batch, the same transaction deletes every `op.tool_args/{operationId}:{turnId}:*` key in deterministic key order, then checkpoints with `triggerEntryId` equal to the newest result: `may_finish(includeFinalAssistant:false)` iff every completed call terminates, otherwise `need_assistant(false)`. `latestAssistantEntryId` remains the batch-producing assistant while `lane.leaf` and `triggerEntryId` equal that newest tool result. For `may_finish(includeFinalAssistant:false)`, the later terminal transaction records `outcome:"completed"` and `runCompletion:"terminated_tools"`, omits `finalAssistantEntryId` and the final message, and performs the ordinary operation-register cleanup; it does not require the leaf to equal `latestAssistantEntryId` or contain an assistant. No final assistant is fabricated and terminal cleanup does not occur in the immediate-result transaction.

Current-state restoration remains bounded and exact. `effect_pending` requires its deterministic arguments register and `planned` requires none. Completed calls are exactly one contiguous source-order prefix. Every completed result matches its source call's tool-call id, name, and reserved result id; result zero has parent `assistantEntryId`, each later completed result has the preceding result id as parent, and `lane.leaf` equals the last completed result or `assistantEntryId` when none are complete. `latestAssistantEntryId` remains `assistantEntryId` throughout the tools phase and its resulting checkpoint. Checkpoint hydration directly names the trigger and latest-assistant entries and does not reconstruct discarded batch history.

A stale action may finish deterministic preparation and its hook before losing the conditional commit; it writes nothing, publishes no process-local prepared plan, and dispatches nothing. Storage failure faults the shell. Close before commit prevents publication and dispatch; close after commit leaves a valid `effect_pending` state without running the effect.

Tier A covers prepared `safe` and `never` with exact arguments; missing active identity and `toolContext` fault; every representative immediate family (unknown tool, invalid arguments, preparation throw, invalid/throwing/blocking before callback); absence of usage and arguments for synthetics; and two-call source progression. Reopening both final-immediate checkpoints must prove unchanged `latestAssistantEntryId`, the exact result parent/tool identity chain, `need_assistant(false)` starting the next assistant from the newest result, and all-terminating completion committing `runCompletion:"terminated_tools"` with no final assistant and complete operation-register cleanup. Bounded corruption cases cover the same closure and argument-register invariants. Tier B proves exact resolution, preparation, hook, and transaction order plus exact write order. Tier C covers close and stale-authority races and retention of the lease across a delayed callback. The implementation reuses `pi-agent-loop`'s exhaustive callback-normalization tests rather than duplicating them.

Option 2 adds durable program-counter states around stateless deterministic work without improving the §§4.1–4.7 authority or crash boundary; stale work can already be discarded before its one conditional commit. Option 3 crosses the required intent-before-effect boundary, preventing effective arguments and replay policy from becoming durable before dispatch and collapsing the §§3.8 and 9.1–9.3 crash cut. Both conflict with the split established by D-024–D-026.

Execute, update, finalize, `after_tool`, real-result settlement and usage, replay/interrupted recovery, abort, parallelism, full hooks/events, registry setters, and genuine-length explanatory result specialization remain explicit later work unless a currently reachable action requires them.

The fresh independent design gate reports PASS after the terminated-tools finish contract, completed-result closure, and explicit reopen assertions were made exact.

Commit `be47c4560` implements the complete clearance boundary. The retained registry now snapshots nested TypeBox schema data, symbols, descriptors, and prototypes rather than retaining caller-mutable nested objects. Harness runtime passes 313/313, `npm run check` and `git diff --check` pass, and the fresh independent final review reports PASS with no blocking findings. Real tool execution remains absent by design and is the next work item.

## D-028 — Separate live sequential tool execution, finalization, and settlement

- Date: 2026-08-13
- Phase: 2
- Status: implemented by `711f5d97c` after corrected independent design and final reviews
- References: D-024–D-027; `packages/agent/docs/harness-v3.md` §§1.2, 1.6, 3.2–3.3, 3.8, 3.13, 4.1–4.7, 5.7, 9.1–9.3

### Options

1. Fold dispatch, execution, finalization, and durable settlement into one action.
2. Separate dispatch and await, but fold `after_tool` finalization and durable settlement into the await action.
3. Use four process-local manual stages over one unchanged durable `effect_pending` call: dispatch, await raw output, finalize, then settle.

### Choice

Option 3.

### Rationale

The durable program counter remains the existing `effect_pending` call from D-027. Four process-local statuses expose `dispatch_tool_effect → await_tool_effect → finalize_tool_effect → settle_tool_effect` without adding a durable state. This preserves the spec's effect, source-ordered callback, and transaction boundaries and makes every boundary independently parkable in manual drive. Options 1 and 2 hide those crash and close positions and cannot provide the required Tier B ordering evidence.

Clearance retains the exact `PreparedToolCall` and batch lease. Dispatch is serialized through RuntimeShell admission, validates the semantic effect identity, installs a running state and controller before invoking `executeToolCall`, and transfers ownership from the prepared map. Close-first starts nothing; dispatch-first gives close and future abort a registered controller. Await stores only the normalized raw result. Finalization has its own admitted start check, reuses the same prepared call and controller signal, and invokes the construction-captured aggregate `afterToolCall` through `finalizeToolCall`. Future abort-first can therefore skip an unstarted finalizer and force `terminate:false`, while finalization-first may finish; D-028 does not yet implement abort reconciliation. Expected tool throws, invalid results, and `after_tool` failures remain in-band. Internal defects use first-terminal-condition arbitration: close-first remains closed, fault-first preserves its original fault.

Settlement does not compare stale pre-effect register sequences. It reloads the latest current state on the lane mutation line, requires the same open operation and semantic pending identity, exact persisted arguments, completed-prefix parent and leaf, and absent result/usage conflicts, then merges completion into that latest state. This preserves future concurrent control and inbox mutations rather than erasing them. A same-value state rewrite cannot invalidate an otherwise authoritative live result. Semantically obsolete effects write nothing and discard all matching local artifacts; malformed arguments, parents, or reservations are corruption and fault instead of stranding a local stage.

When a finalized result reports usage, settlement mints a fresh UUIDv7 only after semantic authority validation, validates its uniqueness and absence from the shared entry/usage namespace, then commits exactly: result entry, lane leaf, optional usage row linked to the result with `adjustment:false`, final sorted validated argument-prefix deletes when this is the last call, and total latest `op.state`. No reported usage means no id allocation and no row. Earlier argument registers remain until final source settlement. The last call enters `may_finish(includeFinalAssistant:false)` only when every completed call terminates; otherwise it enters `need_assistant(false)`.

Close writes nothing, aborts registered tool controllers, prevents locally observed outputs from finalizing or settling, and clears tool effects, prepared calls, and batch leases after admitted work drains. Valid transient updates are intentionally ignored in this slice by omitting an update sink; event delivery and sink isolation remain later work, while `agent-loop` conformance already covers update normalization and draining.

Tier A covers real success, tool/error normalization, `after_tool` patches and failures, usage/no-usage, termination, two-call source and parent order, exact retained args/identity, final cleanup, close/reopen, and completed reopen. Tier B proves `clearance commit → registered dispatch → raw result → finalization → one settlement transaction` and exact write order. Tier C covers both close/fault orders at dispatch, raw, finalization, and settlement boundaries, semantic settlement across unrelated sequence advancement, and obsolete local cleanup.

Replay/interrupted recovery, public abort and cancelled-output reconciliation, parallel tools, full hooks/events, and genuine-length explanatory results remain later Phase 2 items. This changes no durable schema, Storage contract, public Harness API, `pi-ai`, provider adapter, legacy agent package, or forbidden record/history surface. The corrected independent design review reports PASS and requires no §6 escalation.

Commit `711f5d97c` implements the complete live sequential-effect boundary. The planner exposes four stable process-local actions; RuntimeShell retains one context-bound prepared lease through registered execution and source-ordered finalization; Session semantically settles against the latest state in one result/leaf/optional-usage/cleanup/state transaction. Real result messages snapshot finalized usage while a fresh commit-time row records the same charge, and completed durable calls drop pending-only replay data. Harness runtime passes 341/341, `npm run check` and `git diff --check` pass, and the corrected independent final review reports PASS after close/fault and real-result reopen evidence closed its two test-only findings.

## D-029 — Recover restored tool effects from persisted arguments

- Date: 2026-08-13
- Phase: 2
- Status: implemented by `22d75bde0` after corrected independent final review
- References: D-024–D-028; `packages/agent/docs/harness-v3.md` §§3.2–3.3, 3.8, 3.13, 4.1–4.7, 5.7, 9.1–9.3

### Options

1. Hydrate exact persisted tool arguments, replay through the existing process-local effect stages only when both durable and current declarations are `safe`, and otherwise reuse ordinary tool settlement for a synthetic interruption.
2. Synthetically interrupt every restored `effect_pending` tool call.
3. Return the call to `planned`, rerun clearance, or compare newly persisted implementation/schema revisions before replay.

### Choice

Option 1.

### Rationale

The planner exposes one JSON-safe `recover_tool_effect` action carrying operation, assistant, turn, source-index, and reserved-result identities. It selects that action only for the first unfinished durable `effect_pending` call with no matching process-local effect. Existing local `planned`, `running`, `raw`, and `finalized` states continue through D-028's `dispatch → await → finalize → settle` stages.

Current-state hydration point-reads and validates each deterministic `op.tool_args/{operationId}:{turnId}:{sourceIndex}` register as before, but now retains a detached read-only argument map in the internal runtime attachment. Recovery and settlement reuse the value from their latest bounded hydration; they do not scan, read register history, perform an extra argument read inside one hydration, or rerun argument preparation. This is an internal bounded-hydration addition, not a durable schema, Storage, or public Harness API change.

The persisted declaration is the pending call's `replay` value. The current declaration is only the captured-active-name membership and exact source-name lookup in the current runtime registry, with omitted replay normalized to `never`. There is no function, schema, hash, object-identity, or revision comparison because no such identity is durable. A pending source absent from the batch's captured `activeToolNames` is corruption: D-027 clearance could only have persisted an intent for an active resolved tool. After that membership check, a missing or non-safe current definition is an ordinary non-replay case, not `MissingIdentities`, because restored `effect_pending` follows unknown-effect recovery and synthetic settlement needs no tool identity.

When both declarations are `safe`, RuntimeShell resolves `toolContext`, refreshes bounded current state on the mutation line, and only then binds the still-current definition and constructs `PreparedToolCall` directly from the refreshed durable source call and exact persisted effective arguments. It does not invoke `prepareArguments`, schema validation, `prepareToolCall`, or `beforeToolCall`. The local plan is published only after refreshed operation, batch, first-unfinished, source, active-membership, replay, result, and argument authority all still match; dispatch, execution, source-ordered `afterToolCall`, optional replay usage, and real settlement then reuse D-028 unchanged. A `toolContext` throw or rejection remains the trusted runtime-contract fault established by D-027, writes nothing, and leaves the durable call pending.

Every non-replay case atomically settles the reserved result through `Session.settleToolCall` with exactly `content:[{type:"text",text:"Tool outcome unknown after interruption"}]`, `details:{}`, `isError:true`, and durable `terminate:false`. It runs no tool or hook, allocates no usage id, writes no usage row, and adds no tool names. The ordinary semantic settlement reload verifies the same operation, batch, first-unfinished position, source, result reservation, completed-prefix parent and leaf, and hydrated exact arguments before committing the result entry, leaf, final sorted argument cleanup when applicable, and latest total state. It then continues in source order or reaches the normal checkpoint.

Close before local publication or commit writes nothing. Close after replay-plan publication but before dispatch loses only process-local state, so reopen applies the same policy again. Close during or after an unsettled replay treats its outcome as unknown. An admitted synthetic or real settlement commits completely before close. Stale semantic authority publishes no replay plan or result and discards matching local artifacts; corruption and storage failures fault instead of being normalized to interruption. Public abort and cancelled-output reconciliation remain the next separate item.

Tier A covers the full persisted/current `safe|never|missing` matrix, captured-active-name corruption, exact detached arguments, absent preparation hooks, context faults, exact synthetic payload and optional-field absence, reserved identities and parents, multi-call continuation, final cleanup, and close/fresh-reopen continuation at every recovery/effect/settlement boundary. Tier B proves no clearance write, exactly one argument point-read per bounded authority refresh or settlement hydration, no tool/context lookup for durable `never`, exact effect/hook order for safe replay, and one no-usage synthetic settlement transaction. Tier C covers close, fault, stale authority, and settlement in both orders and compares fresh-reopen recovery with uninterrupted recovery.

Options 2 and 3 are rejected. Option 2 violates the specified safe-replay capability. Option 3 can change effective arguments or rerun `before_tool`, creates an unnecessary durable program-counter state, or requires a new declaration-revision contract not present in the spec. The corrected independent design review reports PASS with no §6 blocker.

Commit `22d75bde0` implements the complete restored-effect boundary. Internal attachments retain only exact arguments for currently pending calls; safe recovery refreshes current authority after asynchronous context resolution before publishing a local effect; and non-replay recovery uses the ordinary atomic settlement path under the reserved result id. Harness runtime passes 355/355, `npm run check` and `git diff --check` pass, and the corrected independent final review reports PASS after stale attachment arguments, post-context authority, and two-call recovery evidence were fixed.

## D-030 — Compose durable abort through orthogonal control and existing phases

- Date: 2026-08-13
- Phase: 2
- Status: implemented by `4fdb212cf` after corrected independent final review
- References: D-024–D-029; `packages/agent/docs/harness-v3.md` §§3.2–3.3, 3.7–3.8, 3.11–3.13, 4.1–4.7, 5.1, 9.1–9.3

### Options

1. Commit cancellation and terminal cleanup together, synthesizing every unsettled output in one abort transition.
2. Add a durable `cancelling` phase that wraps the prior phase and carries a reconciliation cursor.
3. Keep the current phase as the program counter, add the canonical orthogonal `cancel_requested` control, and compose cancellation through phase-specific settlement plus the existing terminal transaction.

### Choice

Option 3.

### Rationale

The first abort reloads current lane authority on the Session mutation line and atomically replaces only total `op.state` control with `{ status:"cancel_requested", requestedAt, drainedSteer:[], drainedFollowUp:[] }`. Phase, inbox, reservations, leaf, and arguments remain unchanged. The empty drained arrays are exact for the current pre-queue scope. Only after that commit may a synchronous process-local callback publish the new attachment and signal registered running assistant/tool controllers. A repeated abort while the operation remains open writes and signals nothing and returns the same operation id and empty payloads; after the terminal transaction it reports no active operation. A failed marker commit faults without signalling. Close remains a write-free controlled crash.

Ordinary assistant/tool dispatch and `after_tool` start re-enter the same Session mutation line. They reload exact semantic effect authority and require running control. Cancellation-first returns `not_started` and invokes no provider, tool, or hook. Start-first synchronously registers the controller/local ownership and invokes the external effect before releasing the line, so a later abort finds and signals the already-started effect. RuntimeShell abort bypasses an `executeAction()` admission job that may be awaiting an effect. Monotonic attachment publication prevents an older concurrently completing action from replacing a newer cancelled attachment.

Provider rejection is never inferred to mean abort from the signal alone. `pi-ai` requires operational failures and cooperative cancellation to resolve as terminal assistant messages; a rejected provider stream remains a trusted runtime-contract fault. A valid response settling after the marker is copied under its reserved id with real usage, `stopReason:"aborted"`, and its existing `errorMessage` or `"Operation aborted"`. A cancelled restored or locally planned assistant intent settles synthetically under its reserved response/usage ids with empty content, `api:"harness"`, captured provider/model, exact zero usage, `stopReason:"aborted"`, `errorMessage:"Operation aborted"`, and a post-authority timestamp. Response, leaf, usage, `latestAssistantEntryId`, and cancelled `may_finish(includeFinalAssistant:true)` checkpoint commit together. Ready, retry-wait, checkpoint, and failure-drain states start no new work and can finish aborted without fabricating an assistant.

Cancellation reconciliation remains source ordered. A planned tool call writes its reserved result with exactly `content:[{type:"text",text:"Operation aborted"}]`, `details:{}`, `isError:true`, `terminate:false`, no usage, no added names, no arguments register, and no effect or hook. This literal reuses `pi-agent-loop`'s established pre-effect abort normalization. A durable pending call with a matching local `planned` effect uses the same aborted result because its start gate did not run. A restored pending call has unknown execution and therefore always uses D-029's interrupted result, never safe replay. A live call may settle its real output. If abort wins before `after_tool`, the hook is skipped and normalized raw content, details, usage, added names, and error bit are retained with `terminate:false`. If hook start wins, the already-running hook is not signalled and its finalized transformed result, including terminate, is retained. Cancelled settlement of the final source enters `may_finish(includeFinalAssistant:false)` regardless of the calls' terminate values, then finishes aborted rather than requesting another assistant.

The aborted terminal transaction runs only after every intended assistant/tool output has reconciled, or immediately for a phase with no intended output. It defensively deletes the operation's metadata, state, tool-argument, and preparation registers, writes `lane.lastResult` with `outcome:"aborted"`, the current leaf, and optional newest settled assistant, then clears only `lane.state.currentOperationId`. An aborted run may end on a prompt, tool result, or assistant and never requires a universal assistant closure. Every marker, individual settlement, and terminal boundary is independently reopenable and selects one deterministic next action from current registers.

Options 1 and 2 are rejected. Option 1 cannot atomically reconcile an already-running effect or preserve the specified live-result and post-hook race. Option 2 duplicates the existing program counter, diverges from the canonical control shape, and adds a migration without improving recovery. The selected design changes no Storage contract, namespace set, `pi-ai`, provider adapter, public package contract, or forbidden history surface. Queues, deferred cancellation, parallel tools, automatic drive, events, and structural operations remain later ordered work. The corrected independent design review reports PASS with no §6 escalation.

Commit `4fdb212cf` implements the complete boundary with an orthogonal durable cancellation marker, serialized start gates, assistant and tool reconciliation, and defensive terminal cleanup. Crash-cut recovery converges at every implemented boundary; Harness passes 385/385, `npm run check` and `git diff --check` pass, and the corrected independent final review reports PASS.

## D-031 — Compose the canonical manual driver and full Phase 2 acceptance path

- Date: 2026-08-13
- Phase: 2
- Status: implemented by `9e04a44c6` after independent implementation and whole-phase reviews
- References: D-024–D-030; `packages/agent/docs/harness-v3.md` §§3.3, 3.7–3.8, 3.13, 4.1–4.8, 5.1, 9.1–9.3

### Options

1. Add the spec-shaped `runToCompletion(): Promise<void>` as a loop over the canonical one-action interpreter, retaining the private RuntimeShell's acceptance-only `prompt()` behavior.
2. Add temporary private acceptance, resume, and terminal-result APIs around a second operation driver.
3. Change `prompt()` to auto-drive and return a final outcome before automatic drive and the public AgentHarness surface are implemented.

### Choice

Option 1.

### Rationale

`runToCompletion()` repeatedly invokes `executeAction()` until the planner reports no action. It holds no outer admission reservation, so provider, tool, abort, close, and nested action ordering remain exactly those of the existing interpreter. It adds no automatic mode, durable state, Storage method, public package export, or temporary result contract. Post-crash applications will eventually reconcile through the spec's public `getLastResult()` path; the Phase 2 acceptance gate can inspect the existing durable `lane.lastResult` register without inventing that later API now.

The first composed prompt-to-tool test exposed an invalid recovery assumption: current-state hydration treated the final accepted prompt as the parent of every later assistant response. After tool settlement, the next assistant correctly parents the tool result, while the prior generation trigger is intentionally absent from the replacement checkpoint/tool/failure state. Harness v3 restore validates only entries directly named by current state and never walks history to reconstruct discarded triggers. Hydration therefore no longer compares post-settlement failure, tool-batch, or final-assistant parents to the original prompt. It retains the exact response-parent check while `effect_pending` still directly owns `GenerationContext.triggerEntryId`, plus all prompt-chain, leaf, role, latest-assistant, tool source/result, reservation, and usage checks.

The acceptance suite starts from a real prompt and fixes the exact 16-action uninterrupted sequence through a real sequential tool, durable result, post-tool provider request, final assistant, and terminal cleanup. It closes and reopens fresh handles at all 17 boundaries for both `replay:"safe"` and `replay:"never"`. Assertions distinguish permitted provider uncertainty and safe tool replay from durable duplication, verify the synthetic interrupted result for non-replay, and prove one durable transcript, usage ledger, leaf, `lane.lastResult`, operation/argument cleanup, and idle reopen.

Commit `9e04a44c6` implements the driver, corrects bounded closure validation, and adds the full acceptance matrix. Harness runtime passes 388/388; the complete Phase 2 relevant suites pass 514/514 with 34 recovery scenarios across all 17 cuts; `npm run check` and `git diff --check` pass. Independent implementation review, whole-phase spec review, and Recovery/QA all report PASS. Phase 3 is unblocked.

## D-032 — Rewrite SQLite behind a fenced Storage repository and backend-neutral Session

- Date: 2026-08-13
- Phase: 3
- Status: accepted after corrected independent design review
- References: D-001–D-009, D-021–D-023, D-031; `packages/agent/docs/harness-v3.md` §§1.4–1.7, 2.6, 2.8, 4.4–4.7, 8 slice 14, 9.3

### Options

1. Rewrite `packages/session-backends/sqlite-node` in place as a private fork-owned Storage backend, keep Harness integration in `harness-runtime`, and implement the SQLite-specific segmented branch index now.
2. Create a second `packages/session-sqlite` tree while retaining the legacy public backend until later migration.
3. Publish the rewritten backend immediately or let it depend on Harness/legacy `pi-agent-core` repository types.

For SQLite branch reads, the implementation also considered a temporary parent-pointer walk and implementing the whole slice-14 product surface now.

### Choice

Option 1. The package identity becomes private workspace-only `@nguyenphutrong/pi-session-sqlite`; the source path remains the spec-owned `packages/session-backends/sqlite-node` so the existing `node:sqlite`, `BEGIN IMMEDIATE`, SQL, and fenced-lease primitives can be retained directly. Runtime branch reads implement the §2.6 segmented cache immediately. FTS/search and coherent fork operations remain explicitly incomplete slice-14 work for their ordered product and fork phases.

### Rationale

The rewritten package depends only on `@nguyenphutrong/pi-session-storage`. Its canonical tables are `sessions`, `session_sequences`, `entries`, `registers`, `usage_ledger`, `session_stats`, `writer_leases`, `branch_entries`, and `branch_meta`, with the normative indexes. It contains no records, lanes, fact history, values, `slot_history`, durable log, legacy reducer, or `pi-agent-core` import. Entries and usage share one transactionally enforced id namespace. Registers are the only orchestration mutation surface. The segmented branch index traverses complete base chains, finds compactions through that chain, uses the required `CROSS JOIN` read plan, has query-plan and chain-soundness guards, and can be rebuilt only by an explicit repair operation. Runtime reads never fall back to a table scan or parent walk.

A private low-level `SqliteStorageRepository` owns one deliberately shared database file, its per-file FIFO, catalog, connections, writer leases, and disposable `Storage` handles. It supports create/open/list/delete/close, accepts an injectable `SqliteDatabaseFactory`, and accepts an optional initial transaction. Harness creation always supplies one initial transaction setting `lane.leaf/main = null` and empty `lane.state/main`. Repository create validates first, then atomically inserts the catalog, sequence, stats, lease, initial writes, and private branch projection in one `BEGIN IMMEDIATE`; a process crash therefore leaves either no session or one complete valid session. The shared file accepts SQLite's single-writer queue deliberately so future catalog/search inventory remains co-located.

Every admitted `Storage.commit()` maps to exactly one `BEGIN IMMEDIATE` transaction. Exact unexpired `(sessionId, ownerId, fence)` renewal, sequence-range allocation, caller-ordered writes, branch projection, stats maintenance, and sequence advancement all occur inside it. A failed check or write rolls the whole transaction back. Heartbeats and final fenced release are separate queued lifecycle transactions, never hidden parts of a Harness commit. WAL, full synchronous durability, foreign keys, and a bounded busy timeout are configured before use.

Each handle serializes reads, commits, heartbeat work, and close admission. The first close synchronously seals later admission, stops the timer, drains earlier work, then attempts one exact owner/fence release transaction; stale release is a no-op and cannot delete a replacement. Repeated close calls share one promise. Lease loss rolls back the current write, seals permanently, and uses the existing `StorageError("closed")`; no contract code is added. Unexpected commit SQL faults roll back, latch the original terminal error for current and already-admitted work, and close future admission. A transient background heartbeat SQL fault is contained and rescheduled, while every real commit still verifies ownership; a zero-row stale heartbeat seals. Close still attempts fenced release after an earlier fault and preserves the earlier fault over a release failure. Repository bookkeeping is released in all cases, and repository close drains active handles before closing the shared connection.

The existing Session implementation already accepts generic `Storage`; only its nominal `MemorySession` name and runtime-port check block SQLite. A behavior-preserving first increment renames it package-internally to `StoredSession`, with no alias. `MemorySessionRepo` remains memory-specific. A later private `SqliteSessionRepo` in `harness-runtime` validates the existing exact metadata contract, wraps low-level SQLite handles in `StoredSession`, and exposes the unchanged `Session`/RuntimeShell surfaces. Dependency order is `session-storage → agent-loop/session-sqlite → harness-runtime`; the backend never depends upward on Harness.

Verification is split by guarantee. The unchanged shared backend suite proves Memory/SQLite parity. Backend-specific tests prove exact `BEGIN IMMEDIATE` accounting, rollback, leases/fencing, WAL/reopen, branch plans and segment soundness. Subprocess SQL cuts prove a transaction is absent or complete; creation cuts prove a session is absent or valid. A separate real RuntimeShell process-crash matrix reuses the Phase 2 durable boundaries for `safe` and `never`, proving next-action and terminal-state equivalence rather than conflating SQL-internal cuts with Harness states.

The package stays private because publishing a new fork-owned replacement API is harder to reverse than making it public later, matching D-021's established rule. The obsolete public package is removed from local-release inventory; no registry, publication, deployment, or external data action occurs. The corrected independent design review reports PASS. Phase 3 may complete its stated durability done bar without claiming completion of all Part 8 slice-14 product features; PLAN retains FTS/search and forks as named future work.

Commit `7a0447f3b` completes the first behavior-preserving increment: the backend-neutral implementation and every internal runtime-port gate are now named `StoredSession`, while `MemorySessionRepo` remains memory-specific. No alias, public root export, method body, durable behavior, or test expectation changed. Four focused files pass 279/279 tests, `npm run check` and `git diff --check` pass, and independent review reports PASS.

## D-033 — Build SQLite from one ordered engine and a segmented private branch projection

- Date: 2026-08-13
- Phase: 3
- Status: accepted after corrected independent design review
- References: D-004–D-005, D-032; `packages/agent/docs/harness-v3.md` §§1.1–1.7, 2.5–2.8, 4.7–4.8, 8 slice 14, 9.1–9.3

### Options

1. Land a temporary parent-walking Storage first, then replace its branch implementation.
2. Build disconnected SQL primitives first and test only private helpers until a later large integration.
3. Rewrite the private package in buildable layers around one internal ordered engine, without exposing a known-wrong runtime branch path at any layer.

### Choice

Option 3. The layers are: private adapter/schema; ordered engine; repository and fenced handles; ordinary reads and shared conformance; segmented projection/scans/repair; Harness integration and crash gates. The package is not considered usable until full shared conformance and backend-specific acceptance pass.

### Rationale

The schema contains exactly nine tables: `sessions`, `session_sequences`, `entries`, `registers`, `usage_ledger`, `session_stats`, `writer_leases`, `branch_meta`, and `branch_entries`. Composite foreign keys scope every reference by session; session-owned rows cascade only on session deletion; branch repair deletes rows before metadata. Integer fields enforce their positive or non-negative domain and the JavaScript safe-integer ceiling. Entry type/custom-type/payload presence, valid JSON, usage adjustment, register key, and nullable base-pair constraints are structural only. SQLite reuses `session-storage` validators and never interprets provider messages, compaction semantics, lane namespaces, or register values; those remain Harness-owned under D-004/D-005. SQL `NULL` means an absent custom payload while the text `"null"` preserves JSON null.

Entries and usage rows retain separate write-once tables. Symmetric `BEFORE INSERT` triggers reject cross-table id collisions, while each primary key rejects same-table duplicates. The ordered engine still preflights ids and references in caller order, so an entry parent or usage `entryId` may name only a previously committed entry or an entry written earlier in the same transaction. Triggers are defense, not history or a third payload store. Deterministic caller failures—including duplicate-id `corruption`—roll back without sealing the Storage handle, as required by shared conformance. Lease loss seals with existing `closed`; unexpected adapter/SQL faults seal with the original fault; persisted corruption discovered by reads or repair latches and seals.

One internal synchronous engine serves both `Storage.commit()` and repository `initialTransaction`. Inside exactly one `BEGIN IMMEDIATE` it verifies and renews the exact unexpired owner/fence, reads one sequence range, takes one timestamp, applies every caller write in order, updates branch projection immediately after each entry, maintains stats after each entry/usage row, advances `next_seq`, and returns the ordinary `CommitResult`. Repository creation inserts catalog, sequence, zero stats, lease, and the Harness initial lane transaction in that same atomic transaction. No bootstrap format or second commit exists.

One FIFO serializes the shared database file. A per-handle gate gives admitted reads, commits, heartbeats, and close their file-queue positions synchronously. Close seals later admission, drains earlier work, then attempts one exact fenced release; stale release is a no-op. A prior terminal fault wins over release failure, otherwise release failure rejects the shared close promise. Transient heartbeat SQL failure is contained and retried, but zero-row renewal proves lease loss and seals. Caller transaction errors do not poison the lower-level Storage even though an admitted commit failure still faults the upper Harness.

Every new branch segment uses private id `segment:{newEntryId}`, which is collision-free even when siblings copy the same post-compaction prefix. Root entries start root segments; appending to an exact tip extends it. Divergence first resolves physical candidates through `ix_be_entry`, then proves the selected complete segment/base chain logically covers the parent and agrees with every other valid candidate. Selection is deterministic by newest tip sequence then branch id. The projection searches the complete chain for the newest compaction C at or below the parent. With C, the specific segment covering C becomes the new base at C's sequence and only C-exclusive through parent-inclusive rows copy; with no C, the root-through-parent range copies with no base; parent equal to C copies zero rows. Normal append, compaction search, and scan use only bounded branch ranges, never an entries inventory or parent loop.

Branch scans materialize and validate the complete root-to-start closure before applying query semantics. They then orient, stop inclusively at the first id/type match, filter, apply the exclusive directional cursor, and limit—matching Memory for both orders. Each physical range drives from `branch_entries` through the required `CROSS JOIN entries`; plans must use covering `ix_be_seq`/`ix_be_type` and the entries primary key, with no entries scan or temporary ordering b-tree. Structure scans use the same plan without payload.

Explicit repair is the sole parent-walking path. Under a valid lease and one transaction it inventories entries in ascending sequence, validates detached structural envelopes and that each parent has a lower entry sequence, deletes branch rows then metadata, and replays every entry through the ordinary projection using the same segment identity and compaction rules. It validates every rebuilt chain before commit and rolls back to the prior complete cache on failure. Repair never infers deleted register history: gaps are legal because superseded/deleted registers leave no rows. It requires only safe unique current sequences below `next_seq`; no log or history fold is introduced.

Focused gates cover exact schema/triggers, `BEGIN IMMEDIATE`, ordered references, shared ids, stats and sequence rollback, caller-error reuse, branch candidate agreement, nested compaction/base chains, zero-copy divergence, Memory-equivalent query ordering, query plans, deterministic repair, leases/heartbeat/close/fault precedence, reopen, and process crash. The final corrected independent design review reports PASS with no §6 escalation.

## D-034 — Validate current SQLite schemas against exact canonical DDL

- Date: 2026-08-13
- Phase: 3
- Status: confirmed by human after B-012 escalation
- References: D-033; `packages/agent/docs/harness-v3.md` §§1.7, 7, 8 slice 14, 9.3

### Options

1. Derive one exact normalized DDL fingerprint for every canonical `(type, name)` pair from the executable schema and require equality on reopen.
2. Duplicate the schema as 18 separately declared canonical DDL constants.
3. Validate only object names and trust `user_version` for definitions.

### Choice

Option 1.

### Rationale

Names and `user_version` do not prove that a current-version object still has its canonical constraints, indexes, `WITHOUT ROWID`, or trigger body. Substring comparison is also insufficient because a damaged table missing a trailing clause can remain a prefix of the canonical definition. Exact per-object equality closes both gaps while retaining one executable schema source of truth. Normalization ignores whitespace and a trailing statement terminator only; any other textual definition drift is rejected. Regressions cover extra objects, a changed same-name index, and a same-name table missing `WITHOUT ROWID`.

Commit `2cf987b40` implements D-034 together with the Phase 3.3a private SQLite adapter/schema foundation. The complete package passes 17/17 tests, `npm run check` and `git diff --check` pass, and the final independent review reports PASS.

## D-035 — Let one private engine own every ordered SQLite write transaction

- Date: 2026-08-13
- Phase: 3
- Status: accepted after corrected independent design review
- References: D-032–D-034; `packages/agent/docs/harness-v3.md` §§1.4–1.7, 2.6, 2.8, 8 slice 14, 9.3

### Options

1. Put bootstrap, lease lifecycle, ordered writes, and branch policy in one mode-switching engine.
2. Let each caller open its own SQL transaction around a shared write helper.
3. Let one private engine own `SqliteDatabase.transaction()`, with mandatory synchronous transaction-prologue and per-entry projection capabilities supplied by its internal callers.

### Choice

Option 3.

### Rationale

After one-time schema initialization, only the engine opens session/catalog/lease/storage write transactions, so one invocation cannot accidentally nest or split `BEGIN IMMEDIATE`. `initializeSqliteSchema()` remains the sole infrastructure exception and owns only creation of an empty database's canonical schema. A raw transaction is synchronously validated, detached, and JSON-serialized before queue or SQL admission. The engine receives only that prepared value, one session id, one injected clock, a mandatory `beforeWrites` callback, and a mandatory `projectInsertedEntry` callback. These types remain private to `src/sqlite/storage`; the package root exposes no partial Storage or repository.

Inside one transaction the engine takes one timestamp, runs `beforeWrites`, reads one current sequence and stats row, preflights durable ids and entry references in caller order, allocates one safe consecutive range, and computes the complete resulting stats projection before mutating rows. It preserves every required and optional `Usage` field and rejects a non-finite usage/cost sum or unsafe message count with `StorageError("invalid_transaction")`; `JSON.stringify` and SQLite constraints are not the detector. It then applies every write in caller order, invokes projection as `insert entry → project that exact complete Entry with assigned seq/timestamp → next caller write`, persists the precomputed stats, advances `next_seq`, and returns the ordinary `CommitResult`. A failed prologue, preflight, write, projection, stats update, or sequence update rolls everything back.

Sequence exhaustion is also deterministic `StorageError("invalid_transaction")`, raised before writes when `writeCount > Number.MAX_SAFE_INTEGER - nextSeq`. Assigned sequences therefore never exceed `Number.MAX_SAFE_INTEGER - 1`; `Number.MAX_SAFE_INTEGER` remains only the stored exhaustion sentinel, so the database never needs to represent `next_seq = Number.MAX_SAFE_INTEGER + 1`.

The callback boundary composes two already-required future paths without implementing them early. Ordinary commits supply exact unexpired owner/fence renewal as `beforeWrites`; atomic creation supplies catalog, sequence, zero stats, and initial lease insertion there. Both then run the same prepared initial transaction with no bootstrap format or second commit. The mandatory projection callback later becomes the segmented branch implementation. Until that exists, only focused engine tests supply a recording projection; no production entry-capable Storage path is exposed and no parent walk or empty projection is introduced.

Deterministic caller failures use existing `StorageError` codes: malformed ids and JSON retain their validator codes; missing or forward references, safe-range exhaustion, and accumulated-stats overflow are `invalid_transaction`; duplicate durable ids are `corruption`. Missing canonical session/sequence/stats rows are corruption; lease loss is `closed`; unexpected SQLite faults retain their original error. Fault latching belongs to the next handle-lifecycle unit, not this synchronous engine.

Focused tests use real in-memory SQLite plus counting wrappers to prove one transaction, one timestamp, exact sequence/write/projection order, committed and earlier-in-transaction references, cross-kind id collisions, register replacement/deletion, complete optional-field stats and overflow rejection, rollback, caller-error reuse, safe exhaustion, projection failure rollback, and bootstrap setup plus initial writes in the same transaction. FIFO, real lease lifecycle, ordinary reads/conformance, segmented branches, repair, and subprocess crash gates remain subsequent units.

Phase 3 assumes SQLite's retired-range inventory is empty. This engine therefore treats missing committed references by the ordinary transaction rules and does not claim support for imported truncated sessions. Retired-range storage, boundary-aware writes/scans, and inherited fork ranges remain the later retention scaffold; no hidden retention semantics enter the nine-table Phase 3 schema.

The corrected independent design review reports PASS with no §6 escalation.

## D-036 — Enforce the SQLite callback capability at runtime

- Date: 2026-08-13
- Phase: 3
- Status: confirmed by human after B-013 escalation
- References: D-035; `packages/agent/docs/harness-v3.md` §§1.4–1.7, 8 slice 14, 9.3

### Options

1. Preserve `context.db.prepare`, but pass a new frozen runtime object whose only own capability is a forwarding `prepare` function.
2. Replace `context.db` with a direct `context.prepare` function.
3. Keep only TypeScript `Pick<SqliteDatabase, "prepare">` while passing the original database object at runtime.

### Choice

Option 1.

### Rationale

A TypeScript projection is erased and did not prevent a callback from recovering `transaction`, `close`, or `exec` from the original database object. A fresh frozen prepare-only object enforces D-035 at runtime while preserving the already-approved private callback shape. Both transaction-prologue and per-entry projection callbacks receive the same restricted capability inside the engine-owned transaction. Tests assert that it is not the original database, has only `prepare`, cannot expose transaction or lifecycle methods, and still supports the required transactional reads and writes.

Commit `cdd033a62` implements D-035 and D-036. The complete SQLite package passes 46/46 tests, its package build, `npm run check`, and `git diff --check`; final independent review reports PASS.

## D-037 — Serialize SQLite lifecycle through one file-wide FIFO

- Date: 2026-08-13
- Phase: 3
- Status: accepted after corrected independent design review
- References: D-032–D-036; `packages/agent/docs/harness-v3.md` §§1.4–1.7, 2.8, 8 slice 14, 9.3

### Options

1. Give the repository and each handle separate queues.
2. Share one queue but let repository and lifecycle callers open generic transaction bodies.
3. Give one repository-owned FIFO all file work and expose only concrete lifecycle operations from the private transaction engine.

### Choice

Option 3.

### Rationale

The repository constructor synchronously reserves the FIFO's first position for asynchronous database open plus canonical schema initialization or validation before the object escapes. Every repository operation, handle operation, heartbeat, fenced release, and final connection close receives a position on that same tail synchronously; no handle owns another queue. External admission is sealed separately from a native-private cleanup capability, so repository close can reject new work while still enqueueing releases and final close. Queue rejection never breaks later positions.

After schema initialization, `transaction-engine.ts` remains the only file that calls `SqliteDatabase.transaction()`. Its generic immediate runner and in-current-transaction prepared-write helper stay module-private. Callers receive only concrete create, acquire, renew, release, delete, and ordered-commit operations; D-035's prepare-only prologue and projection callbacks remain inside the engine boundary. Atomic create inserts the catalog row, sequence, zero stats, fence-one lease, and optional prepared initial transaction in one `BEGIN IMMEDIATE`. Phase 3.3c rejects entry-containing transactions before admission until the segmented projector exists; it adds no no-op projector, fake write, partial `Storage`, or second bootstrap commit.

One injected clock value is validated and used for a lifecycle transaction's creation timestamp, lease window, and initial writes. Owner ids are opaque non-empty non-NUL strings, UUIDv7 by default and injectable for tests. Lease acquisition reads under `BEGIN IMMEDIATE`: expiry greater than now is busy; expiry equal to now is replaceable; replacement increments a safe fence in JavaScript; an expired `Number.MAX_SAFE_INTEGER` fence returns deterministic exhaustion without changing the row. Expiry arithmetic saturates safely at the maximum, while a maximum clock value is rejected because no positive lease window exists. Every normal commit and heartbeat renews the exact unexpired owner/fence; release deletes only that exact pair and treats a stale zero-row result as success.

Each `create` or `open` installs a per-session producer reservation before queue admission. On success the queued job registers its active handle before removing the reservation; on failure it removes the reservation in `finally`. Delete, parallel create/open, and ownership checks therefore never observe a gap. Delete rejects before admission while a local reservation, active handle, or closing handle exists, never closes that handle, returns `deleted:false` for a missing session, refuses an unexpired external writer, and acquires an expired lease with a checked next fence before cascading the session in the same transaction.

The first repository close synchronously seals external admission, closes all current handles, and prevents new producers. An admitted producer that has not begun its FIFO turn observes the seal and rejects before catalog or lease SQL; a producer that already ran registered its handle synchronously and is included in close. Close drains the FIFO and loops until producer reservations and active handles are empty, then enqueues connection close. This does not weaken the Storage rule that admitted commits drain: only not-yet-started repository handle producers are cancelled. Repeated repository and handle closes return the same promise.

Deterministic caller transaction failures—including duplicate-id `StorageError("corruption")`—roll back without poisoning. The engine marks persisted canonical corruption privately; that marker, an unexpected public commit/read SQL fault, or zero-row lease renewal seals only the affected handle. Work from that handle admitted earlier receives the original latched error, while later admission receives a fresh `closed`; other handles continue. Heartbeat SQL faults are contained and retried unless a zero-row renewal proves lease loss. Handle close always attempts exact fenced release; a prior terminal fault wins over release failure, otherwise release failure is returned, and registry cleanup always runs. Repository close completes all cleanup and prioritizes initialization error, then the first handle-close failure in release-enqueue order, then connection-close failure.

The low-level metadata contract is exactly id, creation time, current storage version, and optional parent session id; the SQL metadata column remains null in this phase. Private repository errors classify validation, duplicate/missing metadata, local ownership, busy writer, fence exhaustion, version mismatch, and repository closure without widening `StorageError` or a public API. Ordinary reads, shared conformance, entry projection, branch scans, repair, Harness integration, and crash matrices remain the next ordered units. The repository and incomplete handle are not exported from the package root.

Focused tests must prove initialization-first ordering, cross-handle/repository FIFO order, producer reservation races, producer cancellation before SQL, atomic creation, lease and fence boundaries, delete in both orderings, commit/heartbeat fencing, fault provenance and precedence, transient heartbeat retry, idempotent close, release-before-connection-close, initialization failure cleanup, and absence of public exports. The corrected independent design review reports PASS with no §6 escalation.

Commit `a470d2bb5` implements D-037. The package passes 71/71 tests, its package build, `npm run check`, and `git diff --check`. Coverage includes synchronous rejected-Promise validation, producer and delete orderings, cross-handle FIFO traces, real-file competing repositories, exact expiry takeover and deletion, atomic-create rollback, heartbeat retry and fence loss, per-handle persisted-corruption isolation, and cleanup/error precedence. A fresh independent final review reports PASS. Ordinary reads and shared backend conformance remain the next unit.

## D-038 — Add ordinary SQLite reads without exposing a partial Storage

- Date: 2026-08-13
- Phase: 3
- Status: accepted after corrected independent design review
- References: D-004–D-005, D-032–D-037; `packages/agent/docs/harness-v3.md` §§1.4–1.7, 2.5–2.8, 8 slice 14, 9.1–9.3

### Options

1. Put validation, SQL, decoding, and lifecycle arbitration directly in every `SqliteStorageHandle` read method.
2. Keep admission and faults in the handle, put only concrete synchronous queries and decoded-envelope validation in one private read module, and share seeded ordinary-read test vectors between Memory and SQLite.
3. Make the handle implement `Storage` now by enabling entry commits with an empty projector or placeholder branch methods, then run the existing full conformance suite.

### Choice

Option 2. The production handle gains only the six branch-independent Storage reads: exact entries, exact usage rows, one register, registers in one namespace, session-wide entry scan, and stats. It remains private and structurally incomplete until segmented projection and branch scans land. The existing full `createStorageConformance()` remains unchanged and continues to mean complete Storage conformance.

### Rationale

Every public-shaped read validates and detaches caller input synchronously before taking a position on D-037's one file FIFO. The handle owns open/closed admission, admitted-versus-late behavior, terminal latching, and close ordering. A private reader owns only fixed SQL operations scoped by exact session id and conversion of SQLite rows to domain-neutral envelopes. It exports no generic query callback or database capability. Reads admitted before close drain before fenced release; reads after the synchronous seal receive a fresh `StorageError("closed")`. If a prior handle fault exists, already-admitted reads receive that original fault.

Caller defects remain reusable `invalid_query`: exact id arrays are dense, unique UUIDv7 lists; register namespace/key text follows the existing empty/NUL rules; entry scans use the existing exact object validator plus safe bounds, type/custom-type compatibility, direction, and positive limit checks. Inputs are detached before queue admission so later mutation cannot alter SQL. An empty exact-id list returns an empty `ReadonlyMap` without SQL. Non-empty exact reads use fixed-size placeholder chunks below SQLite's portable variable limit, perform only primary-key lookups, and reconstruct the final map strictly in caller order; no valid list length is rejected merely because one SQL statement cannot bind it. Register lists use the `(session_id, namespace, key)` primary-key range and sort decoded rows by safe sequence; entry inventory is constrained by `session_id` and driven in sequence order through `ix_entry_seq`. No query reads branch tables, scans register namespaces globally, scans the usage ledger, interpolates caller values into SQL, or opens a transaction.

Each row is reconstructed with exact optional-field semantics before the existing complete `assertEntry`, `assertUsageRow`, or `assertRegister` validator runs. SQL `NULL` means an omitted optional field while stored JSON text `"null"` decodes to JSON null. Stats require one canonical row, a safe non-negative message count, and a complete finite `Usage` payload. A private persisted-corruption marker shared with the transaction engine converts missing canonical session/stats rows, malformed persisted JSON, invalid SQLite scalar/boolean domains, duplicate or impossible exact rows, and failed envelope/stats validation into marked `StorageError("corruption")`. Genuine adapter or SQL failures preserve their original error identity. Either class seals only the affected handle; caller validation happens before FIFO admission and never seals. The shared marker keeps commit-side provenance exact so deterministic caller `corruption` errors remain reusable.

The shared testing subpath gains a narrowly named ordinary-read case factory and fixture type whose storage surface is a `Pick<Storage, ...reads | "close">` plus a setup-only `seed(Transaction)` capability. Memory seeds through its ordinary commit path. SQLite tests seed complete canonical rows through the already-tested private ordered engine with a recording-only projection callback; this is fixture setup, not a production entry-capable handle or a no-op runtime projector. The same vectors then verify empty, missing, ordered, and multi-chunk exact lookups; register semantics; entry-scan filters/ranges/order/limit; stats; detached results and admitted queries; invalid-query classification; reads admitted before close; and closed rejection on both backends. SQLite-specific tests additionally prove primary-key and `ix_entry_seq` plans, no branch access, FIFO order with commit/heartbeat/close, persisted-corruption isolation, reopen, every optional JSON column's malformed-text handling, and exact SQL `NULL` versus JSON text `"null"` decoding.

This testing export is additive only under `@nguyenphutrong/pi-session-storage/testing`; it does not change the production `Storage` contract or weaken the meaning of full conformance. Entry-capable production commits, branch projection and scans, repair, Harness integration, subprocess crash gates, and public SQLite exports remain deferred to their ordered units. Option 3 is rejected because an empty projection creates known-invalid durable cache state and placeholder branch methods falsely claim a complete backend.

The corrected independent design review reports PASS with no §6 escalation.

Commit `bc071197b` implements D-038. Exact entry and usage reads use bounded chunks, preserve caller order, and revalidate the canonical session after all chunks so a second connection deleting at lease expiry cannot produce a partial result. The shared ordinary-read vectors pass on Memory and SQLite without changing full conformance. SQLite passes 103/103 tests, Storage passes 38/38, both package builds, `npm run check`, and `git diff --check` pass. The final independent review reports PASS after deterministic two-connection deletion regressions and exact production-SQL query-plan evidence closed earlier findings.

## D-039 — Project and read only validated segmented branch closures

- Date: 2026-08-13
- Phase: 3
- Status: accepted after corrected independent design review
- References: D-032–D-038; `packages/agent/docs/harness-v3.md` §§1.2, 1.4–1.7, 2.5–2.6, 9.1, 9.3

### Options

1. Materialize and validate each complete segmented closure, require every physical candidate to agree, then evaluate branch-query semantics over that canonical structure vector.
2. Stream physical segment rows directly into filtered output while resolving bases and pagination.
3. Flatten every divergence into one physical root-to-parent segment.

### Choice

Option 1. It gives one local proof for candidate eligibility, segment-chain soundness, compaction ownership, and payload reconciliation. Option 2 interleaves structural validation with pagination and makes corruption detection order-dependent. Option 3 copies an unbounded prefix and violates §2.6.

### Rationale

Every segment id is `segment:{newEntryId}`. A root creates one null-base metadata row and one branch row. An exact current-tip append inserts one row and conditionally advances the matching metadata tip. A non-tip append resolves every physical parent candidate through `ix_be_entry`. Zero candidates are persisted corruption because transaction preflight already proved the parent entry exists.

Each candidate materializes with initial upper bound equal to the parent's sequence. A segment owns `(baseSeq, upper]`; following its base sets `upper = baseSeq`, so the base segment alone emits the junction row at that inclusive upper bound. Bounds strictly decrease. Repeated branches, cycles, missing metadata or range rows, invalid joined envelopes, inactive physical membership, a bad tip/base/junction, gaps, or duplicates are persisted corruption. The canonical root-to-parent vector has strictly increasing but not necessarily consecutive sequences, a null root parent, exact adjacent parent links, and the requested parent as its final row. Every physical candidate must produce the same `(id, parentId, seq, timestamp, type, customType)` vector. Only then is the candidate with `(branch_meta.tip_seq DESC, branch_id ASC)` selected.

The newest compaction is the highest-sequence compaction in that selected complete vector, including base chains. Materialization records which selected-chain interval emitted each row. If compaction C exists, the new segment points to that exact owner branch with `baseSeq = C.seq` and copies only `(C.seq, parent.seq]`; when the parent is C, it copies zero rows. Without C, the base pair is null and the exact root-through-parent vector is copied. Bounded branch-index ranges supply copies; production never inventories entries or follows parent pointers. The projector runs immediately after each entry insert, so a later entry in the same transaction observes all earlier projections. Any later failure rolls back entries, projection, stats, sequence, lease renewal, and atomic creation together.

Branch reads synchronously validate and detach the query before FIFO admission, resolve and agree every physical start candidate, and produce one canonical root-to-start structure vector plus non-overlapping owner intervals. They then apply exactly: requested ordering, first inclusive id/type stop, type/custom-type filtering, directional exclusive cursor, and limit. Structure reads return only detached structural fields.

Payload reads first establish the complete canonical structure closure. Exact production `CROSS JOIN` interval queries drive from `branch_entries` through covering `ix_be_seq`, or `ix_be_type` when applicable, and point-join `entries` by its composite primary key. Every selected identity must have exactly one matching payload row, no foreign or duplicate row is accepted, and output is reconstructed in canonical structure order rather than SQL return order. An empty selected result runs no payload SQL. Query-plan tests use the production SQL constants and reject an entries scan or temporary ordering b-tree. SQL never merges segment ordering globally; code combines bounded intervals.

The transaction engine and atomic creation path receive the same private prepare-only projector. Entry rejection and placeholder callbacks disappear only when both paths project correctly. The private handle then gains `scanBranch` and `scanBranchStructure` through the existing file FIFO, fault latch, and close ordering. The actual complete handle—not a cast, fake Storage, or seed-only fixture—must pass the unchanged shared full conformance suite alongside Memory.

Caller UUID, shape, order, cursor, and filter defects remain reusable `invalid_query`; a missing or forward submitted parent remains reusable `invalid_transaction`; caller duplicate durable ids retain reusable unmarked `corruption`. Missing committed projection, malformed metadata or rows, cycles, candidate disagreement, structural or payload mismatch, and impossible tip/base/junction state are privately marked persisted corruption and seal only the affected handle. Unexpected adapter/SQL errors retain identity and seal. Already-admitted terminal identity, late `closed`, fenced release, and rollback semantics remain D-037/D-038.

Focused gates cover roots and tips, divergence with and without compaction, compactions in older bases, exact junction ownership, parent-equals-compaction zero-copy, candidate agreement, same-transaction root/child/sibling projection, rollback and sequence reuse, nested-chain soundness, complete query semantics in both orders, payload/structure parity, corruption, reopen, FIFO/close/fault precedence, exact plans, atomic create/commit, and unchanged full Memory/SQLite Storage conformance.

Explicit repair, Harness integration, FTS/search, forks, retired ranges and retention, JSONL, and subprocess crash matrices remain later ordered work. The corrected independent design review reports PASS with no §6 escalation.

## D-040 — Enforce segment creation identity uniformly

- Date: 2026-08-13
- Phase: 3
- Status: confirmed by human after B-014 escalation
- References: D-039; `packages/agent/docs/harness-v3.md` §2.6

### Options

1. Share one private assertion that validates `segment:{UUIDv7}` and point-checks the suffix creation entry's physical membership, using it from exact-tip and materialized-candidate paths.
2. Materialize the exact-tip segment's complete closure before every append.
3. Validate exact-tip format only and defer ownership checks to reads or repair.

### Choice

Option 1.

### Rationale

Format and ownership are one segment-identity invariant and must not depend on whether an append reaches the exact-tip fast path or divergence materialization. One point check keeps the hot append path bounded while rejecting malformed ids and a valid-shaped id whose creation entry is absent. Complete exact-tip materialization adds unnecessary work, while format-only validation permits the known-invalid cache transition that triggered B-014.

Commit `4a94c253c` implements D-039's projection increment and D-040. Concrete commits and atomic creation now project root, tip, and divergent entries through validated segmented closures. Every physical candidate agrees on canonical entry structure and sequence, compaction-bounded copies retain their exact owner junction, and segment identity is enforced uniformly on the exact-tip and divergence paths. SQLite passes 121/121 tests, its package build, `npm run check`, and `git diff --check`; the fresh independent final review reports PASS. Guarded branch reads and unchanged full Storage conformance remain the next increment.

Commit `c0ad1066b` implements D-039's guarded-reader increment. Both branch APIs first materialize one agreed structure-only closure, then apply ordering, inclusive stop, filtering, directional cursor, and limit. Payload reads reconcile bounded `ix_be_seq` or `ix_be_type` ranges one-to-one against that canonical plan before returning in plan order. SQLite passes 151/151 tests, its package build, `npm run check`, and `git diff --check`; independent final review reports PASS. The unchanged full Storage conformance gate remains separate and next.

Commit `886bb34ad` closes D-039 with the unchanged full conformance factory running directly against fresh real SQLite handles. All 20 shared cases pass exactly once, SQLite passes 171/171, Memory/session-storage passes 38/38, both package builds, `npm run check`, and `git diff --check` pass. Independent review confirms there is no cast, fake backend, wrapper, seed substitute, or weakened shared case. Phase 3.3e is complete; explicit repair and Harness integration remain next.

## D-041 — Keep repair administrative and integrate SQLite through complete handles

- Date: 2026-08-13
- Phase: 3
- Status: accepted after corrected independent design review
- References: D-032–D-040; `packages/agent/docs/harness-v3.md` §§2.6, 2.8, 8 slice 14, 9.1–9.3

### Options

1. Add repair to an active `Storage` or `Session` handle and let runtime callers invoke it.
2. Expose a generic repository transaction or SQL callback and implement repair in Harness.
3. Give the concrete SQLite repository one explicit administrative repair operation, then adapt its complete handles to `StoredSession` through a workspace-private `SqliteSessionRepo`.

### Choice

Option 3. Repair remains outside `Storage`, `Session`, `RuntimeShell`, open, reads, and restore. Runtime branch corruption continues to fail, seal only the affected handle, and never trigger repair or a parent-walk fallback.

### Rationale

`entries` is the only repair input. Registers and usage remain authoritative durable stores but do not participate in branch reconstruction. The repository validates exact metadata, synchronously reserves the session against local producers and active handles, and submits repair to D-037's file-wide FIFO. One concrete engine operation owns exactly one `BEGIN IMMEDIATE`: it verifies the catalog, current storage version, and a positive safe `next_seq`; acquires an absent or exactly expired writer lease with a checked fence; and rejects an unexpired owner.

The engine decodes all canonical entries in ascending sequence with the complete storage envelope validator. Entry sequences must be unique, strictly increasing, positive safe integers below `next_seq`; gaps and multiple roots are valid, while every non-null parent must already have appeared. It then deletes `branch_entries` before `branch_meta`, replays the detached entries through the ordinary `projectSqliteEntry`, and independently resolves every rebuilt entry closure so every canonical id has sound projection membership. Finally it deletes the exact repair owner/fence lease before the same commit. Any metadata, canonical-data, projection, validation, SQL, or release failure rolls back the lease takeover and replacement, preserving both all canonical rows and the old projection. A successful repair replaces the old projection completely and deterministically.

The private SQLite package adds only a workspace integration seam for `SqliteStorageRepository`, its repository errors/options/metadata, and a complete structural `SqliteStorageSession extends Storage` return type. Existing private adapter, schema, and type exports remain; concrete handles, engine operations, and transaction callbacks gain no new export. Emitted repository signatures use the complete interface rather than leaking `SqliteStorageHandle`. Boundary tests lock both runtime exports and declarations.

The private Harness package depends on the private SQLite package; SQLite continues to depend only on session storage and never imports Harness. Root build order follows that direction. `SqliteSessionRepo` accepts only an exact `{ path }`, creates the existing Node SQLite factory internally, owns one low-level repository, and exposes the existing `Session` and RuntimeShell behavior without passing database, factory, timer, SQL, lease, or fence capabilities upward.

Creation supplies exactly one low-level `initialTransaction`: `lane.leaf/main = null`, then idle `lane.state/main`. Catalog, sequence, stats, lease, and both registers therefore commit atomically with no second initialization commit. Open applies the existing exact metadata and directional storage-version checks, acquires a complete handle, validates the main lane, and closes that handle on validation failure while preserving the original error. `StoredSession.close()` owns handle closure once; repository close delegates the low-level drain and idempotent connection close. Low-level validation, missing/duplicate ownership, busy writer, version/metadata mismatch, closure, persisted corruption, and adapter faults map to existing `SessionError` codes; no durable or supported public contract changes.

Focused repair gates cover damaged, missing, and conflicting projections over forests, divergence, and compaction; repeat determinism; malformed canonical payload/sequence/parent data; failures after deletion and during replay; exact rollback; local and external ownership; expiry/fence/FIFO/close behavior; `BEGIN IMMEDIATE`; sibling isolation; repaired reads and append; and absence of automatic repair. Harness gates cover atomic creation, exact metadata/version/error mapping, ownership and cleanup, real-file close/fresh-repository reopen, and complete no-tool and tool RuntimeShell terminal restoration. The unchanged shared Storage suite remains green. Subprocess SQL, creation, and all Phase 2 RuntimeShell crash cuts remain the next work item and are required before the Phase 3 done bar is claimed.

Implementation stays incremental: repair core and repository operation; additive private package seam; Harness repository and lifecycle tests; real RuntimeShell SQLite acceptance; then subprocess crash matrices and whole-phase Recovery/QA. Final independent design review reports PASS with no §6 escalation.

Commit `8143f9d39` implements the repair core and repository operation. Repair replaces the derived projection from a fully decoded canonical entry inventory, globally reconciles every rebuilt metadata and membership row, resolves every canonical closure, and removes its exact fence before the same commit. Focused repair tests pass 43/43; the complete SQLite package passes 214/214; `npm run check` and `git diff --check` pass. A fresh independent final review reports PASS. The additive complete-handle package seam and Harness adapter remain next.

Commit `452fe721c` implements the additive private package seam. The package root preserves its adapter, schema, SQL, and type exports while adding the repository, repository errors/options, catalog metadata, and `SqliteStorageSession extends Storage`. Emitted `create` and `open` declarations return the complete structural interface; the concrete handle, transaction engine, callbacks, queues, and lifecycle internals remain outside the package root. Boundary tests use a real created handle rather than a cast or partial fake. The complete SQLite suite passes 214/214, the package build, `npm run check`, and `git diff --check` pass, and a fresh independent review reports PASS. Private Harness integration remains next.

Commit `a381f5f30` implements the private Harness adapter. `SqliteSessionRepo` accepts only an exact nonempty path, owns the Node factory and low-level repository, and creates the initial leaf and idle state in the low-level creation transaction. Open validates exact metadata and directional versions, validates the bounded main-lane closure, and releases the acquired handle without replacing the original validation error. `StoredSession` owns and maps handle close; repository close owns the file connection. Contextual error mapping exposes only existing `SessionError` codes, and unsupported persisted catalog metadata is corruption rather than a migration fallback. A forced failure on the second initial register proves catalog, sequence, stats, lease, and first-register rollback. Harness passes 398/398, SQLite passes 214/214, `npm run check` and `git diff --check` pass, and a fresh independent review reports PASS. Real RuntimeShell SQLite acceptance remains next.

## D-042 — Verify terminal SQLite restoration with separate fresh Session attachments

- Date: 2026-08-13
- Phase: 3
- Status: accepted after corrected independent design review
- References: D-019, D-024, D-041; `packages/agent/docs/harness-v3.md` §§1.7, 2.8, 3.13, 4.2, 4.4–4.7, 9.1–9.3

### Options

1. Add the two RuntimeShell terminal scenarios to the existing SQLite repository contract test.
2. Add one focused real-file acceptance suite with separate fresh Sessions for terminal attachment inspection and RuntimeShell no-op restoration.
3. Parameterize the complete Phase 2 Memory crash-cut matrix over Memory and SQLite immediately.

### Choice

Option 2. One initial Session manually drives complete no-tool and sequential-tool runs through RuntimeShell. After shell and repository close, one fresh repository/Session performs a single write-free `attachRuntime` inspection, and another fresh repository/Session creates a RuntimeShell directly and proves idle driving performs no effects or durable writes.

### Rationale

The focused suite closes D-041's real SQLite composition gate without mixing RuntimeShell behavior into repository contract tests or pulling subprocess crash matrices into this increment. `attachRuntime` is intentionally single-use per `StoredSession`; inspecting an attachment and then calling `createRuntimeShell` on that same Session would double-attach and fail. Separate fresh opens model real process lifecycles and keep ownership explicit.

The initial manual traces are exact: six actions for a no-tool response and sixteen for a one-tool sequential turn followed by a final response. Assertions cover ordered entry identities and parent chains, payloads, leaf, usage ledger totals, provider contexts, tool execution, terminal operation cleanup, and the exact `lane.lastResult`. Since the current incremental Session surface does not yet expose §5.1's `getLastResult`, a read-only exact SQLite query after all owners close supplies test evidence only; it does not drive, repair, fold, or bypass RuntimeShell state transitions. Fresh attachment and no-op RuntimeShell passes must preserve the database sequence, registers, tree, and stats and must invoke no provider or tool effect.

Subprocess SQL, creation, and every Phase 2 crash cut remain separate queued work and are still required before the Phase 3 done bar. No Storage, durable-schema, production API, repair, or recovery change is approved by this decision. The corrected independent design review reports PASS with no §6 escalation.

Commit `5ae9a5a9a` implements D-042 as a test-only real SQLite acceptance suite. It drives exact no-tool and sequential-tool action identities through RuntimeShell, verifies complete persisted messages and usage associations, terminal register cleanup and `lane.lastResult`, then proves separate fresh attachment and RuntimeShell lifecycles perform no effects or durable writes. Focused acceptance passes 2/2, Harness passes 400/400, SQLite passes 214/214, `npm run check` and `git diff --check` pass. A fresh independent final review reports PASS; subprocess commit-boundary crash work remains next.

## D-043 — Audit SQLite RuntimeShell prefixes with fresh controlled-close lifecycles

- Date: 2026-08-13
- Phase: 3
- Status: accepted after independent design review
- References: D-019, D-024, D-029, D-041, D-042; `packages/agent/docs/harness-v3.md` §§1.4, 1.7, 3.2–3.4, 3.8, 3.13, 4.2, 4.4–4.7, 9.1–9.3

### Options

1. Add the commit-boundary matrix to the existing terminal SQLite acceptance file.
2. Add a separate real-file suite for every Phase 2 sequential-tool action prefix and both replay policies.
3. Refactor the approved Memory and SQLite tests behind one backend-neutral driver.

### Choice

Option 2. Run 34 scenarios: cuts zero through sixteen of the exact sequential-tool trace, each with `safe` and `never`. Every cut closes the current shell and repository, then a new repository opens the same session and a fresh RuntimeShell converges from the durable prefix.

### Rationale

A separate suite keeps D-042's terminal composition evidence small and preserves the already-approved Memory crash fixture. Within one cut, provider and tool spies survive shell lifecycles so replay counts remain observable; repository, Session, and RuntimeShell instances never do. Each reopen therefore reacquires the real SQLite owner/lease on a fresh connection without double attachment.

The Phase 2 formulas remain authoritative. Assistant effects are uncertain after cuts 3, 4, 13, and 14. Tool intent is pending after cuts 6 through 9; a `never` tool is interrupted at all four, runs zero times only at cut 6, and otherwise retains its one pre-close execution. A `safe` tool replays after cuts 7 through 9 and therefore runs twice. All other cases run the tool once. Final provider calls total three only at assistant-uncertain cuts, and tool-result-bearing provider contexts total two only at cuts 13 and 14.

The converged state must contain the exact provider responses, the real or policy-required interrupted tool result, exact usage associations, terminal lane result and cleanup, and an idle lane. After all owners close, a read-only complete SQLite snapshot is captured. A third fresh Session/RuntimeShell with independent spies must expose no action, effect, or durable write, and the post-close snapshot must match exactly, including sequence high-water and absent writer lease.

This is a controlled-close commit-prefix audit, not an OS process-crash test. Storage/creation and RuntimeShell subprocess kill matrices remain required before the Phase 3 done bar. No production, Storage, schema, public API, repair, history-fold, or compatibility change is approved. Independent design review reports PASS with no §6 escalation.

## D-044 — Complete the literal SQLite commit-boundary oracle

- Date: 2026-08-13
- Phase: 3
- Status: confirmed by human after B-015 escalation
- References: D-043; `packages/agent/docs/harness-v3.md` §§1.7, 3.2–3.4, 4.4–4.7, 9.1–9.3

### Options

1. Assert every provider context exactly, require UUIDv7 usage ids, and tie every usage sequence to its assistant entry's exact settlement position.
2. Treat semantic usage association, payload, uniqueness, and monotonic order as sufficient while adding only complete provider-context assertions.
3. Accept the current matrix despite the repeated independent review failure.

### Choice

Option 1.

### Rationale

The audit claims exact recovery at every commit boundary, so first/last provider samples and merely increasing usage rows leave observable recovery and transaction-order gaps. Every normal run has exactly `[user]` then `[user, assistant tool-call, toolResult]`; cuts 3 and 4 repeat the first context before the tool-result context, while cuts 13 and 14 repeat the tool-result context. Each assistant settlement writes `entry → lane.leaf → usage → op.state`, so its usage row sequence must equal the associated assistant entry sequence plus two. Usage identities must satisfy the same UUIDv7 durable identity contract as the production writer and remain unique and disjoint from entry ids. This is test-only and changes no production or public contract.

Commit `152a49b38` implements D-043/D-044. All 34 controlled-close prefixes pass with exact action identities, complete provider-context traces, replay/interruption counts, UUIDv7 usage identities, exact assistant-entry-plus-two usage sequences, all-nine-table snapshots, fresh terminal no-op proof, and terminal cleanup. Harness passes 434/434, SQLite passes 214/214, `npm run check` and `git diff --check` pass. A fresh independent review reports PASS and confirms both repeated findings are closed. Subprocess storage/creation and RuntimeShell process-crash matrices remain required.

## D-045 — Prove SQLite transaction crash atomicity through semantic subprocess cuts

- Date: 2026-08-13
- Phase: 3
- Status: accepted after independent design review
- References: D-032–D-041; `packages/agent/docs/harness-v3.md` §§1.4–1.7, 2.6, 2.8, 4.7, 9.1–9.3

### Options

1. Wrap the test-only `SqliteDatabaseFactory`, forward every operation to the production adapter, and let a real child process kill itself at a cataloged semantic SQL cut.
2. Add crash hooks to the production transaction engine.
3. Kill an uninstrumented child on randomized or timed delays and classify observed outcomes.

### Choice

Option 1, delivered in two increments: ordinary `Storage.commit()` first, then atomic repository creation through the same protocol and oracle.

### Rationale

Each case owns one real SQLite file and a Node strip-only TypeScript child. The parent spawns without a shell and accepts a cut only after exact versioned `armed` and `cut-reached` NDJSON markers plus child exit `{code:null, signal:"SIGKILL"}`; a timeout, protocol mismatch, duplicate marker, or parent-issued kill fails. The wrapper activates only after schema and baseline setup. It forwards the production adapter and wraps its real `transaction()` callback solely to cut after `BEGIN IMMEDIATE` but before the first operation, or after the adapter returns from `COMMIT`. Statement wrappers run the real mutation first and then cut. They never implement begin, commit, rollback, the ordered engine, or branch projection.

A successful no-kill trace is the catalog authority. It classifies exact normalized SQL plus occurrence and parameters, requires every expected site exactly once, and rejects any unclassified mutating statement in the armed operation window. The ordinary transaction appends one exact-tip message and associated usage, sets a new register, overwrites and deletes existing registers, and deletes one absent register. Its catalog therefore covers lease renewal, entry and segmented-branch mutations, usage, each caller-ordered register operation, stats, sequence advancement, the before-first-operation cut, and post-commit uncertainty. Open/acquire completes before `armed`; its lifecycle transaction is not conflated with the tested commit.

Creation uses the real low-level repository with D-032's exact initial transaction: `lane.leaf/main = null` followed by idle `lane.state/main`. Its catalog covers the session, sequence, stats, lease, both initial registers, final stats and sequence writes, before-first-operation, and after commit. An artificial initial entry is unnecessary because the ordinary matrix already exercises branch tables, and instrumenting `SqliteSessionRepo.create()` would require a new factory seam without increasing transaction-boundary evidence.

The child uses fixed UUIDv7 ids, owner, clock, lease TTL, and non-firing timers. After confirmed process death, the parent first reads all nine tables with exact ordering, preserving WAL and shared-memory files. Ordinary state must equal the exact armed baseline or exact complete transaction with no per-table mixing. Creation must be absent from every table and list result, or be one exact complete valid session. The parent then opens through a fresh real repository exactly at lease expiry under a different owner, proving lawful takeover and fence advancement without raw lease deletion or bypass. Branch closure, stats, caller-order sequences, next-sequence allocation, metadata, normal close, and final absent lease are checked as applicable.

All support stays test-only in the private SQLite package with no new dependency or public capability. The POSIX `SIGKILL` matrix is explicitly skipped on Windows; ordinary cross-platform conformance remains unchanged. RuntimeShell process recovery remains a separate next work item. Independent design review reports PASS.

Commit `baab5f4f2` implements D-045's ordinary-commit increment. A real child runs one exact-tip entry, usage, register set/replace/delete/no-op-delete transaction through the production repository, adapter, transaction engine, and branch projector, then kills itself at 13 semantic sites from post-`BEGIN IMMEDIATE` through post-`COMMIT`. Every case exposes exact protocol and `SIGKILL` evidence, preserves SQLite recovery files, and yields one independently constructed all-nine-table baseline or complete snapshot before lawful expiry takeover. SQLite passes 215/215, `npm run check` and `git diff --check` pass, and fresh independent review reports PASS after exact protocol bounds and non-circular snapshot rework. Atomic repository creation remains the next D-045 increment.
