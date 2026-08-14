# Harness Rewrite Plan

## Current checkpoint

- Phase: 5 — Hooks, events, and snapshots
- Work item: 5.1 — Hook pipeline foundation
- Status: Phase 4 final acceptance passed independent whole-phase review and Recovery/QA; re-read the Phase 5 hook/event/watch contracts and design the smallest complete hook slice
- Done bar: the approved first slice has one explicit owner, exact hook ordering and failure semantics, deterministic close/abort behavior, and no speculative event or snapshot surface
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Re-read `harness-v3.md` hook pipeline, callback failure, effect start/settlement, abort, close, event, watch, and testing-tier sections.
2. Produce 2–3 concrete ownership/ordering options for the smallest complete hook pipeline foundation.
3. Run an independent design review against package boundaries and later passive-event/watch requirements.
4. Implement one atomic hook slice only after the design gate passes.
5. Add Tier B/C hook ordering, abort, close, callback-failure, and reopen evidence before expanding to passive events.

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
