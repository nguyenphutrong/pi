# Harness Rewrite Plan

## Current checkpoint

- Phase: 5 — Hooks, events, and snapshots
- Work item: 5.4 — Gap-free snapshot/subscription prerequisites
- Status: D-059 `run_end` is committed and independently accepted; design the smallest complete mutation-to-event coverage required before a spec-faithful `watch()` can buffer across snapshot delivery
- Done bar: every currently reachable snapshot field has an explicit authoritative source and every mutation during the snapshot/start gap has an owned event, or the design names the prerequisite catalog increments that must land before `watch()`
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Map every current `LaneSnapshot` field to durable/process-local ownership and every mutation procedure.
2. Compare implementing `watch()` now against first completing the required entry/queue/write event owners.
3. Record the smallest spec-faithful sequence and obtain an independent design review.
4. Implement and independently test/review only the first approved prerequisite increment.
5. Repeat until the snapshot/buffer/start contract can be exposed without gaps or replay inference.

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
