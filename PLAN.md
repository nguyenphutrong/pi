# Harness Rewrite Plan

## Current checkpoint

- Phase: 5 — Hooks, events, and snapshots
- Work item: 5.2 — Passive events foundation
- Status: corrected D-058 `run_start` + `handler_error` foundation passed independent design review; implement the typed process-local registry and exact RuntimeShell publication seams
- Done bar: `run_start` publishes only after accepted prompt durability; hook/listener failures publish bounded `handler_error`; typed FIFO-start listener snapshots, detachment, lifecycle registration, and content-free telemetry are isolated from execution; no other event or snapshot/watch surface yet
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Implement the typed passive registry, frozen `RuntimeShell.events.on`, and private publisher.
2. Bind D-057's private hook-error reporter and publish `run_start` after successful prompt acceptance only.
3. Add registry plus RuntimeShell ordering, failure, close/fault, reopen, telemetry, and zero-write evidence.
4. Run full Harness/root verification and fresh independent review.
5. Checkpoint Phase 5.2, then design explicit owners for the next event-catalog increment before snapshots/watch.

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
