# Harness Rewrite Plan

## Current checkpoint

- Phase: 5 — Hooks, events, and snapshots
- Work item: 5.2 — Passive events foundation
- Status: Phase 5.1 tool-hook pipeline is committed and independently accepted; design the smallest passive event slice that binds the private hook-error reporter without adding snapshots or `watch()` early
- Done bar: typed passive listeners are isolated from execution, handler failures emit bounded `handler_error` observation plus content-free telemetry, and publication occurs only at owned process-local or postcommit boundaries; no snapshot/watch surface yet
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Re-read the passive-event, lifecycle ordering, abort/close, and telemetry sections; design event ownership and publication boundaries around the current RuntimeShell procedures.
2. Obtain an independent design review before exposing any event names or public registry surface.
3. Implement the smallest typed passive registry and bind D-057's private hook-error reporter to `handler_error`.
4. Add isolated-listener ordering, failure, close/fault, and postcommit publication evidence for only the reachable event subset.
5. Run full Harness/root verification and fresh independent review before designing snapshots and subscription gap prevention.

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
