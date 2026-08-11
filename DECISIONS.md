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
