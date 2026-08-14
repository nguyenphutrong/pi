# Harness Rewrite Plan

## Current checkpoint

- Phase: 5 — Hooks, events, and snapshots
- Work item: 5.3 — First public event-catalog increment
- Status: corrected D-059 passed fresh independent design review; implement the paired private finish result, exact public type, and sole postcommit publication
- Done bar: each successful authoritative RuntimeShell finish action publishes one complete v3 `run_end` after attachment publication and before action resolution; direct Session calls, replay, and process failure after commit are not delivery guarantees, while obsolete/failed/idle-reopen paths publish none
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Implement only the approved private finish-result completion, public type, and postcommit publication.
2. Add independent ordering, outcome, lifecycle, and zero-extra-write evidence.
3. Run focused and complete Harness verification plus root checks.
4. Obtain a fresh independent implementation review and correct any finding before commit.
5. Checkpoint Phase 5.3, then design gap-free snapshots/subscriptions before exposing `watch()`.

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
