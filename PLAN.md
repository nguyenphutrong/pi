# Harness Rewrite Plan

## Current checkpoint

- Phase: 4 — Queues and interactive control
- Work item: 4.2f — Representative SQLite deferred-write process-crash evidence
- Status: D-055 four-case projecting/unprojected × pre/post-placement design passed independent review; implement the dedicated real-SIGKILL matrix without a production seam
- Done bar: real SQLite subprocess deaths before and after deferred-write placement reopen deterministically with exact pending/entry/state/leaf/lease evidence, no duplicate projection or write, lawful fence takeover, and a final fresh no-op without adding a production seam
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Implement the dedicated subprocess support, child protocol, and four-case parent oracle.
2. Run the focused process matrix and correct every exact durable/effect mismatch.
3. Run complete Harness/SQLite verification, fresh independent review, and commit Phase 4.2f.
4. Design `waitForIdle` and `runWhenIdle` settlement behavior against the Phase 4 queue state machine.
5. Implement waiter/idle-callback lifecycle, abort, close, and recovery coverage.

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
