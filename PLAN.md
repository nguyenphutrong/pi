# Harness Rewrite Plan

## Current checkpoint

- Phase: 2 — Durable tools and abort
- Work item: 2.1 — Durable sequential tool plan, arguments, replay, and recovery design
- Status: implementing/reviewing the fork-owned npm identity migration decided in D-021
- Done bar: `prompt → tool call → durable tool result → model → final response` survives a crash at every boundary, with durable abort and terminal reconciliation

## Queue

1. Verify the atomic npm identity migration.
2. Resolve how public `@earendil-works/pi-agent-core` consumes private `@nguyenphutrong/pi-agent-loop` before extraction.
3. Correct the 2.1 design tool state so `ToolCall` does not duplicate durable assistant-entry identity, then obtain an independent design PASS.
4. Extract the three behavior-preserving agent-loop tool phases at the selected package boundary.
5. Implement generation unknown-effect recovery required by the Phase 2 crash done bar.
6. Implement and test the first durable tool-plan increment before tool effects.

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
