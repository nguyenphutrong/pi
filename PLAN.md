# Harness Rewrite Plan

## Current checkpoint

- Phase: 1 — Minimal durable run
- Work item: 1.13 — Kill-at-every-boundary recovery coverage
- Status: B-006 option 1 selected by the human; complete the fully exact end-to-end writer audit and re-run the independent gate
- Done bar: `prompt → provider → final response` on one `main` lane, with deterministic close/reopen recovery at every commit boundary

## Queue

1. Complete the exact D-019 writer audit selected in B-006 and obtain an independent PASS.
2. Run independent Phase 1 done-bar review.
3. Run the Phase 1 recovery/QA pass.
4. Begin Phase 2 only after Phase 1 is accepted.

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
- Multi-lane, queues, tools, compaction, navigation, and serving concerns until their ordered phases.
- Canonical extensible `AgentMessage` ownership and custom-role schemas until before custom messages or the product shell.
