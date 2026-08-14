# Harness Rewrite Plan

## Current checkpoint

- Phase: 4 — Queues and interactive control
- Work item: 4.3 — `waitForIdle` and `runWhenIdle`
- Status: D-056 RuntimeShell-local idle coordinator design passed independent review; implement its authoritative registration, tracked reads, callback batch cutoff, reservation, release pump, and lifecycle settlement
- Done bar: waiters and idle callbacks settle exactly once across prompt, queue, abort, terminal, fault, and close histories; callbacks never become durable work or run while the lane is active; fresh reopen derives only current durable state
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Implement authoritative waiter/callback registration and the process-local idle pump in RuntimeShell.
2. Split tracked read admission from reservation-aware state-mutation admission, including abort and manual drive.
3. Add deterministic batch-cutoff, FIFO, callback-error, reentrancy, and terminal-order coverage.
4. Add close/fault, tracked-read drain, and fresh-reopen coverage.
5. Run complete Harness verification, fresh independent review, and commit Phase 4.3.

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
