# Harness Rewrite Plan

## Current checkpoint

- Phase: 2 — Durable tools and abort
- Work item: 2.3 — Generation unknown-effect recovery
- Status: private stateless agent-loop commit `bd7cefe5b` passed independent review; implement retry-or-synthetic recovery for restored provider intents
- Done bar: `prompt → tool call → durable tool result → model → final response` survives a crash at every boundary, with durable abort and terminal reconciliation
- Escalation policy: proceed automatically with the evidence-backed recommendation; ask only when available evidence cannot distinguish materially different outcomes

## Queue

1. Implement generation unknown-effect recovery required by the Phase 2 crash done bar.
2. Implement and test the first complete durable tool-plan commit before clearance or effects.
3. Add durable clearance, persisted effective arguments, replay policy, and sequential tool settlement.
4. Add durable abort/reconciliation after sequential tool states are abort-ready.
5. Add close/reopen crash matrices at every Phase 2 commit boundary and run the done-bar gate.

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
- Multi-lane, queues, tools, compaction, navigation, and serving concerns until their ordered phases.
- Canonical extensible `AgentMessage` ownership and custom-role schemas until before custom messages or the product shell.
