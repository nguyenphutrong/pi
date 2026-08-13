# Harness Rewrite Plan

## Current checkpoint

- Phase: 4 — Queues and interactive control
- Work item: 4.2d — Active write admission and atomic placement
- Status: blocked at B-017 after two independent reviews rejected the same dual-owner placement-test fixture; production and 695/695 Harness tests remain uncommitted
- Done bar: active façade writes reserve an id and atomically persist pending content plus total `op.state`, idle writes retain their existing direct path, placement commits entries/deletes/leaf/total state in one transaction after exact authority recheck, stale placement writes nothing, and cancel/abort races produce one of the two serialized valid outcomes
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Resolve B-017 and replace all D-052 placement fixtures with one lawful owner/mutation line.
2. Re-run full verification and obtain a fresh independent Phase 4.2d PASS.
3. Add projector/context and planner actions with stale/fault/close coverage.
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
