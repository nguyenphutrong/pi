# Harness Rewrite Plan

## Current checkpoint

- Phase: 5 — Hooks, events, and snapshots
- Work item: 5.1 — Hook pipeline foundation
- Status: D-057 tool-hook registry design passed corrected independent review; implement the behavior-preserving agent-loop validator seam before RuntimeShell registry integration
- Done bar: `before_tool` and `after_tool` run as typed FIFO aggregate pipelines with exact validation, reporting, telemetry, durability, abort, close, and reopen semantics; no future hook names or public event/watch surface
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Extract additive before/after callback-output normalizers in `pi-agent-loop` without changing existing behavior; test and independently review the refactor.
2. Add the tool-only typed registry, private handler-error reporter, and canonical hook telemetry in `harness-runtime`.
3. Replace RuntimeShell singleton tool callbacks with `hooks.on` aggregation and remove the temporary options without a compatibility shim.
4. Add Tier A/B/C FIFO snapshot, validation, reporter, telemetry, durability, abort, close, and reopen evidence.
5. Run full Harness/root verification and fresh independent review before beginning passive events.

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
