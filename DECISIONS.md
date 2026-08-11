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
- Status: 1.8a implemented by `32ef80020`; 1.8b pending
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
