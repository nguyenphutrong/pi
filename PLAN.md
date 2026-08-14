# Harness Rewrite Plan

## Current checkpoint

- Phase: 4 — Queues and interactive control
- Work item: Phase 4 final acceptance
- Status: Phase 4.3 is complete at `26791c55f`; run an independent whole-phase conformance review and Recovery/QA gate before advancing to Phase 5
- Done bar: every Phase 4 queue, deferred-write, idle-waiter, abort, close, and SQLite process-death history satisfies the spec with no forbidden durable or package-boundary regression
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Re-read the Phase 4 queue, deferred-write, abort, idle-control, race-catalog, and testing-tier sections as one acceptance contract.
2. Run Recovery/QA across the complete Harness suite and the real SQLite queue/deferred-write process-death matrices.
3. Run a fresh independent whole-phase review against D-047 through D-056 and the Phase 4 done bar.
4. Record and commit Phase 4 final acceptance if both gates pass.
5. Begin Phase 5 with a narrow hooks/events/snapshots design slice; do not combine all three surfaces in one increment.

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
