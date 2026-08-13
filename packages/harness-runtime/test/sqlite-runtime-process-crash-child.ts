import { DatabaseSync } from "node:sqlite";
import { SqliteSessionRepo } from "../src/repo.ts";
import { createRuntimeShell, type RuntimeShell } from "../src/runtime-shell.ts";
import type { Session, SessionMetadata } from "../src/types.ts";
import { user } from "./fixtures.ts";
import {
	actionShape,
	configuration,
	type EffectCounts,
	effects,
	emit,
	INITIAL_TIME,
	RECOVERY_TIME,
	type Replay,
} from "./sqlite-runtime-process-crash-support.ts";

const mode = process.argv[2];
const path = process.argv[3];
const replay = process.argv[4] as Replay | undefined;
const cut = Number(process.argv[5]);
if (
	(mode !== "initial" && mode !== "recovery") ||
	!path ||
	(replay !== "safe" && replay !== "never") ||
	!Number.isInteger(cut) ||
	cut < 0 ||
	cut > 16
)
	throw new Error("invalid arguments");
Date.now = () => (mode === "initial" ? INITIAL_TIME : RECOVERY_TIME);

function snapshot(sessionId: string): Record<string, unknown[]> {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const read = (table: string, order: string) =>
			db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${order}`).all(sessionId);
		return {
			sessions: read("sessions", "session_id"),
			sequences: read("session_sequences", "session_id"),
			stats: read("session_stats", "session_id"),
			entries: read("entries", "seq"),
			registers: read("registers", "namespace,key"),
			usage: read("usage_ledger", "seq"),
			branches: read("branch_meta", "branch_id"),
			branchEntries: read("branch_entries", "branch_id,entry_seq"),
			writerLeases: read("writer_leases", "session_id"),
		};
	} finally {
		db.close();
	}
}
async function close(
	shell: RuntimeShell<object> | undefined,
	session: Session | undefined,
	repo: SqliteSessionRepo,
): Promise<void> {
	try {
		await shell?.close();
		if (!shell) await session?.close();
	} finally {
		await repo.close();
	}
}
async function shell(session: Session, phase: "initial" | "recovery" | "idle"): Promise<RuntimeShell<object>> {
	const fixture = effects(replay!, phase);
	return createRuntimeShell(session, configuration, {
		models: fixture.models,
		tools: [fixture.tool],
		toolContext: {},
		retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
	});
}

async function shellWithCounts(
	session: Session,
	phase: "recovery" | "idle",
): Promise<{ runtime: RuntimeShell<object>; counts: EffectCounts }> {
	const fixture = effects(replay!, phase);
	return {
		runtime: await createRuntimeShell(session, configuration, {
			models: fixture.models,
			tools: [fixture.tool],
			toolContext: {},
			retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		}),
		counts: fixture.counts,
	};
}

emit({ event: "ready", phase: mode });
if (mode === "initial") {
	const repo = new SqliteSessionRepo({ path });
	const session = await repo.create();
	const runtime = await shell(session, "initial");
	const accepted = await runtime.prompt(user("run echo"));
	const operationId = accepted.runOperation?.value.operationId;
	const promptEntryId = accepted.runOperation?.value.intent.promptEntryIds[0];
	if (!operationId || !promptEntryId) throw new Error("missing accepted identities");
	emit({ event: "accepted", metadata: session.metadata, operationId, promptEntryId });
	for (let index = 0; index < cut; index++) {
		const peeked = await runtime.peekAction();
		if (!peeked || !actionShape(peeked)) throw new Error(`missing action ${index}`);
		const executed = await runtime.executeAction();
		if (JSON.stringify(executed) !== JSON.stringify(peeked)) throw new Error("peek/execute mismatch");
		emit({ event: "action", phase: "initial", index, info: executed });
	}
	emit({ event: "crash", cut });
	process.kill(process.pid, "SIGKILL");
	throw new Error("SIGKILL returned");
}

const encoded = process.argv[6];
if (!encoded) throw new Error("missing metadata");
const metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionMetadata;
let repo = new SqliteSessionRepo({ path });
let session: Session | undefined;
let runtime: RuntimeShell<object> | undefined;
session = await repo.open(metadata);
const recoveredShell = await shellWithCounts(session, "recovery");
runtime = recoveredShell.runtime;
const firstAction = await runtime.peekAction();
const openingLease = snapshot(metadata.id).writerLeases[0];
emit({ event: "recovery-ready", firstAction: firstAction ?? null, writerLease: openingLease });
let index = 0;
for (let action = firstAction; action; action = await runtime.peekAction()) {
	const executed = await runtime.executeAction();
	if (JSON.stringify(executed) !== JSON.stringify(action)) throw new Error("recovery peek/execute mismatch");
	emit({ event: "action", phase: "recovery", index: index++, info: executed });
}
const branch = await session.findEntriesOnBranch({ order: "oldestFirst" });
const stats = await session.getStats();
const leaf = await session.getLeafId();
await close(runtime, session, repo);
runtime = undefined;
session = undefined;
const terminalSnapshot = snapshot(metadata.id);
repo = new SqliteSessionRepo({ path });
session = await repo.open(metadata);
const idleShell = await shellWithCounts(session, "idle");
runtime = idleShell.runtime;
const idleBefore = {
	metadata: session.metadata,
	branch: await session.findEntriesOnBranch({ order: "oldestFirst" }),
	stats: await session.getStats(),
	leaf: await session.getLeafId(),
};
if (await runtime.peekAction()) throw new Error("idle action");
await runtime.runToCompletion();
if (await runtime.peekAction()) throw new Error("idle action after run");
const idleAfter = {
	metadata: session.metadata,
	branch: await session.findEntriesOnBranch({ order: "oldestFirst" }),
	stats: await session.getStats(),
	leaf: await session.getLeafId(),
};
await close(runtime, session, repo);
const after = snapshot(metadata.id);
if (JSON.stringify(terminalSnapshot) !== JSON.stringify(after)) throw new Error("idle write");
emit({
	event: "terminal",
	evidence: { metadata, branch, stats, leaf },
	idleEvidence: { before: idleBefore, after: idleAfter, effects: idleShell.counts },
	snapshot: terminalSnapshot,
	idleSnapshot: after,
});
emit({ event: "complete" });
