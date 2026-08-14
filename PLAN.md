# Harness Rewrite Plan

## Current checkpoint

- Phase: 4 — Queues and interactive control
- Work item: 4.2e — Projector/context and planner integration
- Status: Phase 4.2d committed and independently accepted; start the D-050 4.2e design slice from the authoritative spec
- Done bar: RuntimeShell projects the selected FIFO write prefix sequentially outside the mutation line, invokes atomic placement with exact authority, makes stale/fault/close behavior deterministic, projects committed custom entries identically into provider context, and planner order obeys writes-before-queues plus cancellation reconciliation without changing Storage or durable codecs
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Design projector/context and planner integration against D-050 and `harness-v3.md`.
2. Implement committed custom-entry context projection and the deferred-write planner action.
3. Add stale projector, fault, abort, admission, and close interleaving coverage.
4. Add representative SQLite deferred-write crash evidence.
5. Add `waitForIdle` and `runWhenIdle`.

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
