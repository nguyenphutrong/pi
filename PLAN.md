# Harness Rewrite Plan

## Current checkpoint

- Phase: 2 — Durable tools and abort
- Work item: 2.7 — Durable abort and terminal reconciliation
- Status: D-030 design committed by `2ae7dbdd9` after corrected independent design review PASS; implementation pending
- Done bar: `prompt → tool call → durable tool result → model → final response` survives a crash at every boundary, with durable abort and terminal reconciliation
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Implement D-030's durable first-abort marker, cancelled codecs, and start gates.
2. Reconcile cancelled assistant and planned, restored-pending, and live tool outputs.
3. Add abort-versus-effect/settlement/finish/close Tier A/B/C coverage.
4. Run the full Harness suite, root check, diff check, and independent final D-030 review.
5. Run the complete Phase 2 crash matrix, done-bar review, and Recovery/QA gate.

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
