# Harness Rewrite Plan

## Current checkpoint

- Phase: 2 — Durable tools and abort
- Work item: 2.1 — Durable sequential tool plan, arguments, replay, and recovery design
- Status: Phase 1 accepted after independent done-bar review and Recovery/QA PASS; re-read the Phase 2 spec sections before design delegation
- Done bar: `prompt → tool call → durable tool result → model → final response` survives a crash at every boundary, with durable abort and terminal reconciliation

## Queue

1. Re-read the records catalog, tool lifecycle, recovery, abort, terminal, public API, and testing-tier sections for Phase 2.
2. Delegate 2.1 design options for exact durable sequential tool planning, persisted arguments, and `replay: safe|never` recovery.
3. Select and independently review the 2.1 design before implementation.
4. Implement the first commit-sized durable tool-state increment.
5. Add Tier A/B/C crash-boundary coverage before widening to abort.

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
