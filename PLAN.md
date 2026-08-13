# Harness Rewrite Plan

## Current checkpoint

- Phase: 4 — Queues and interactive control
- Work item: 4.2a — Mixed tree and pending-entry codecs
- Status: D-050 and the precommit projector contract passed independent design review; implement the first codec/type increment
- Done bar: message/custom committed and pending entries round-trip with exact absent-data versus JSON-null semantics; mixed queries validate correctly; existing message behavior remains green
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Implement mixed Entry/PendingEntry codecs, query types, and focused tests.
2. Add runtime attachment ownership and the SessionTree façade.
3. Enable durable `inbox.writes`, admission, placement, projector actions, and crash evidence.
4. Add `waitForIdle` and `runWhenIdle`.
5. Complete whole-Phase-4 acceptance and independent done-bar review.

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
