# Harness Rewrite Plan

## Current checkpoint

- Phase: 5 — Hooks, events, and snapshots
- Work item: 5.4 — Gap-free snapshot/subscription prerequisites
- Status: BLOCKED on B-018 — choose how the public event stream represents `cancelQueued(writeId)` removal from `LaneSnapshot.pendingWrites`
- Done bar: after human selection, D-061 identifies every authoritative queue and pending-write snapshot mutation, fixes one exact private metadata/projection contract and ordering policy, passes independent design review, and still exposes neither snapshots nor `watch()`
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Resolve B-018 by selecting the public pending-write removal contract.
2. Record D-061 with the selected event shape and the verified mutation-owner matrix.
3. Obtain fresh independent design review and correct every blocking finding before implementation.
4. Implement and test the approved queue/pending-write slice, then run complete Harness and root verification.
5. Checkpoint D-061, then design control/retry lifecycle prerequisites; do not expose snapshot/watch yet.

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
