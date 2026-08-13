# Harness Rewrite Plan

## Current checkpoint

- Phase: 2 — Durable tools and abort
- Work item: 2.5b — Sequential tool dispatch, finalization, and durable real-result settlement
- Status: D-027 clearance implemented by `be47c4560` after full verification and independent final review; real tool effects are next
- Done bar: `prompt → tool call → durable tool result → model → final response` survives a crash at every boundary, with durable abort and terminal reconciliation
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Re-read the tool effect and settlement sections and design the smallest D-028 boundary.
2. Implement sequential execute/update/finalize through the retained prepared plan.
3. Atomically settle a real durable tool result and advance the batch/checkpoint.
4. Add Tier A/B/C dispatch, finalization, settlement, close, and stale-authority coverage.
5. Independently review D-028, then add replay/interrupted recovery, abort, and the Phase 2 crash matrix.

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
- Canonical extensible `AgentMessage` ownership and custom-role schemas until before custom messages or the product shell.
