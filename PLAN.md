# Harness Rewrite Plan

## Current checkpoint

- Phase: 5 — Hooks, events, and snapshots
- Work item: 5.3 — First public event-catalog increment
- Status: Phase 5.2 passive events foundation is committed and independently accepted; design the next smallest event set around explicit durable commit owners before adding snapshots or `watch()`
- Done bar: every selected event has one explicit publication owner and durable visibility boundary, remains passive and content-safe, and introduces no durable event log or premature snapshot/watch contract
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Re-read the event catalog and current RuntimeShell commit owners; design the smallest coherent public increment.
2. Obtain an independent design review before exposing additional event names or payloads.
3. Implement only the approved publications and public type additions.
4. Add independent ordering, failure, lifecycle, and zero-extra-write evidence; run full verification and fresh review.
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
