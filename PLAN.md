# Harness Rewrite Plan

## Current checkpoint

- Phase: 3 — SQLite and production durability
- Work item: 3.4a — RuntimeShell SQLite commit-boundary audit
- Status: blocked by B-015 after repeated review rejection of the exact test-oracle boundary; uncommitted matrix passes 34/34 but cannot be committed pending the human choice
- Done bar: Memory and SQLite pass one shared storage conformance suite; each Harness commit is one SQLite transaction using `BEGIN IMMEDIATE`; writer lease/fencing, reopen, and process-crash recovery are verified
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Audit every RuntimeShell SQLite commit boundary against the Phase 2 manual driver.
2. Add storage and creation subprocess crash matrices.
3. Add RuntimeShell subprocess crash matrices.
4. Run whole-Phase-3 review and Recovery/QA.

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
