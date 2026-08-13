# Harness Rewrite Plan

## Current checkpoint

- Phase: 3 — SQLite and production durability
- Work item: 3.3c — Per-file FIFO, repository, and fenced handle lifecycle
- Status: 3.3b committed as `cdd033a62` after final independent review PASS; 3.3c design is next
- Done bar: Memory and SQLite pass one shared storage conformance suite; each Harness commit is one SQLite transaction using `BEGIN IMMEDIATE`; writer lease/fencing, reopen, and process-crash recovery are verified
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Design the private per-file FIFO, repository catalog operations, writer-lease acquisition/renewal/release, handle gate, heartbeat, close, and fault precedence.
2. Implement and test that repository and fenced handle lifecycle over the ordered engine.
3. Add ordinary bounded reads and pass shared backend conformance outside branch scans.
4. Implement segmented projection/scans, plan guards, and explicit repair; then add `SqliteSessionRepo` to Harness runtime.
5. Add storage, creation, and RuntimeShell subprocess crash matrices, then run whole-Phase-3 review and Recovery/QA.

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
