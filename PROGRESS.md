# Harness Rewrite Progress

Chronological completed work items. Timestamps are UTC.

| Timestamp | Phase | Work item | Commit | Verification |
|---|---|---|---|---|
| 2026-08-11T07:50:10Z | 1 | 1.1 Storage boundary design and orchestration bootstrap | `60d980501` | Independent checkpoint review: PASS; architecture review selected domain-neutral storage envelopes. |
| 2026-08-11T08:43:51Z | 1 | 1.2 Atomic storage contract and Memory backend | `495e100e9` | Storage tests 25/25; `npm run check` PASS; independent review PASS after D-005 resolution. |
| 2026-08-11T09:31:37Z | 1 | 1.3a Reopenable Memory storage state and disposable handles | `48dfa1e0f` | Storage tests 30/30; `npm run check` PASS; independent review PASS after D-007 resolution. |
| 2026-08-11T10:37:59Z | 1 | 1.3b Typed Memory Session tree/repository and built-in message codecs | `c4506dbd5` | Storage 30/30 and Session 26/26; `npm run check` PASS; independent review PASS after D-008 resolution. Storage follow-ups: `99d4a4930`, `98996c8bd`. |
| 2026-08-11T13:23:07Z | 1 | 1.4 Phase 1 runtime-shell and pure-planner design | `44538f6fa` | Independent design review PASS after D-010 corrections; B-004 resolved by exact usage lookup `8f31fd0ba` (storage 31/31, `npm run check` PASS, independent implementation review PASS). |
| 2026-08-11T14:14:24Z | 1 | 1.5 Canonical Phase 1 durable state boundary and runtime attachment | `3dbf5d7c0` | Storage 31/31 and Harness runtime 91/91; `npm run check` PASS; independent conformance gate PASS after rooted-closure, schema, and reservation-collision rework. |
| 2026-08-11T14:26:53Z | 1 | 1.6 Pure planner and one-step manual-scheduler design | `59cd1bed5` | D-011 approved by independent design gate; no public or Storage contract change and no active escalation. |
| 2026-08-11T14:57:31Z | 1 | 1.6 Pure planner and one-step manual scheduler | `0ba92a6a8` | Storage 31/31 and Harness runtime 113/113; `npm run check` PASS; independent conformance gate PASS after precommit rooted-validation and settings-boundary rework. |
| 2026-08-11T15:43:44Z | 1 | 1.7 Additive provider request leases | `c9e561a3c` | AI lease 44/44, coding-agent lease 6/6, Storage 31/31, Harness runtime 113/113, and `npm run check` PASS; independent final review PASS after replacing a rejected auth-internal export with a lease-bound header binder. Full `./test.sh` remained non-green only in unrelated coding-agent environment cases missing built package artifacts and `fd`, plus one watcher timeout. |
| 2026-08-11T16:16:34Z | 1 | 1.8a Durable idle prompt acceptance | `32ef80020` | Runtime-shell 29/29 and Harness runtime 129/129; `npm run check` PASS; independent conformance gate PASS after separating `LaneBusy` from missing-identity unavailability. |
| 2026-08-11T16:41:14Z | 1 | 1.8b Durable assistant-effect intent | `2eca9c11f` | Runtime-shell/planner 62/62, Harness runtime 153/153, Storage 31/31, and `npm run check` PASS; independent conformance gate PASS. Exact lease/context/options remain process-local; reopen selects uncertain recovery. |
| 2026-08-12T01:46:59Z | 1 | 1.9 Retained assistant-effect dispatch and await | `7eea8b445` | Runtime-shell 74/74, Harness runtime 181/181, Storage 31/31, and `npm run check` PASS; independent conformance gate PASS after D-015 established first-terminal-condition ordering for close and provider faults. |
| 2026-08-12T02:21:23Z | 1 | 1.10 Atomic no-tool assistant settlement | `c0dae84c2` | Harness runtime 202/202, Storage 31/31, `npm run check` PASS, and `git diff --check` PASS; independent conformance gate PASS. Response, leaf, usage, and latest total operation state commit atomically. |
