# Harness Rewrite Plan

## Current checkpoint

- Phase: 3 — SQLite and production durability
- Work item: 3.2b — SQLite schema, ordered write engine, lease lifecycle, and segmented branch design
- Status: backend-neutral `StoredSession` refactor committed as `7a0447f3b` after focused tests, root check, and independent review PASS
- Done bar: Memory and SQLite pass one shared storage conformance suite; each Harness commit is one SQLite transaction using `BEGIN IMMEDIATE`; writer lease/fencing, reopen, and process-crash recovery are verified
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Fix the exact SQLite write, schema, branch-segment, repository, and lifecycle implementation units against D-032.
2. Rewrite the legacy SQLite package as private `@nguyenphutrong/pi-session-sqlite` and pass shared/backend-specific conformance.
3. Add the private `SqliteSessionRepo` adapter in Harness runtime and run the real RuntimeShell over SQLite.
4. Add distinct storage-transaction, session-creation, and RuntimeShell subprocess crash matrices.
5. Run independent whole-Phase-3 review and Recovery/QA gates.

## Phase order

1. Minimal durable run.
2. Durable tools and abort.
3. SQLite and production durability.
4. Queues and interactive control.
5. Hooks, events, and snapshots.
6. Compaction and navigation, then forks/subagents.
7. OpenCode-level product shell.
8. Amp-level remote execution.

## Priority fallback

1. Storage transactions/registers.
2. Minimal prompt run.
3. Crash restore/resume.
4. Durable sequential tools.
5. Abort/close.
6. SQLite.
7. Queues/steering/follow-up.
8. Events/watch.
9. Permissions/sandbox/worktrees.
10. Hooks.
11. Parallel tools.
12. Manual compaction.
13. Auto-compaction/overflow.
14. Multi-lane/navigation/fork.
15. Remote runners.
16. Advanced retention/schema evolution.

## Deferred

- JSONL unless required for product export, debug, or import.
- Postgres partitioning and retention daemon.
- Precise rewrite and general settlement-kernel migrations.
- Multi-lane, queues, compaction, navigation, and serving concerns until their ordered phases.
- SQLite FTS/search and coherent fork operations remain incomplete Part 8 slice-14 work assigned to the product-search and fork phases; Phase 3 does not claim the whole slice.
- Canonical extensible `AgentMessage` ownership and custom-role schemas until before custom messages or the product shell.
