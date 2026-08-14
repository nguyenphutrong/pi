# Harness Rewrite Plan

## Current checkpoint

- Phase: 4 — Queues and interactive control
- Work item: 4.3 — `waitForIdle` and `runWhenIdle`
- Status: Phase 4.2 is complete at `d89d1875d`; re-read the waiter public API and settlement semantics, then design the smallest process-local lifecycle over the durable lane state
- Done bar: waiters and idle callbacks settle exactly once across prompt, queue, abort, terminal, fault, and close histories; callbacks never become durable work or run while the lane is active; fresh reopen derives only current durable state
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Re-read `harness-v3.md` public API, terminal, restore, and queue sections for waiter ownership and exact idle definition.
2. Produce and independently review concrete `waitForIdle`/`runWhenIdle` lifecycle options.
3. Implement the approved process-local waiter and callback behavior without changing Storage or durable state.
4. Add deterministic settlement, abort, close, fault, reentrancy, and fresh-reopen coverage.
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
