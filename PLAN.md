# Harness Rewrite Plan

## Current checkpoint

- Phase: 1 — Minimal durable run
- Work item: 1.8 — Add prompt acceptance and durable assistant-effect intent before provider dispatch
- Status: 1.7 provider request leases committed as `c9e561a3c`; independent final review PASS
- Done bar: `prompt → provider → final response` on one `main` lane, with deterministic close/reopen recovery at every commit boundary

## Queue

1. Design and implement no-tool prompt acceptance plus durable assistant-effect intent before dispatch.
2. Bind the captured `ModelRequestLease` to effect execution without persisting or exposing it.
3. Implement provider settlement, response/usage commit, classification, and terminal cleanup.
4. Add close/reopen Tier A coverage for every resulting action and transition boundary.
5. Add kill-at-every-boundary recovery coverage, then run independent Phase 1 review and recovery QA.

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
