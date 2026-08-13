import { SqliteSessionRepo } from "../src/repo.ts";
import { createRuntimeShell, type RuntimeShell } from "../src/runtime-shell.ts";
import type { Session, SessionMetadata } from "../src/types.ts";
import {
	configuration,
	effects,
	emit,
	INITIAL_TIME,
	messages,
	RECOVERY_TIME,
	snapshot,
} from "./sqlite-operation-queues-process-crash-support.ts";

const mode = process.argv[2];
const path = process.argv[3];
const cut = Number(process.argv[4]);
if ((mode !== "initial" && mode !== "recovery") || !path || !Number.isInteger(cut) || cut < 0 || cut > 4)
	throw new Error("invalid arguments");
Date.now = () => (mode === "initial" ? INITIAL_TIME : RECOVERY_TIME);

async function makeShell(
	session: Session,
): Promise<{ shell: RuntimeShell<object>; counts: ReturnType<typeof effects>["counts"] }> {
	const fixture = effects();
	return {
		shell: await createRuntimeShell(session, configuration, {
			models: fixture.models,
			tools: [fixture.tool],
			toolContext: {},
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
		}),
		counts: fixture.counts,
	};
}

async function execute(shell: RuntimeShell<object>, kind: "consume_queue" | "finish_aborted_run"): Promise<void> {
	const first = await shell.peekAction();
	if (first?.kind !== kind) throw new Error(`expected ${kind}, got ${first?.kind ?? "none"}`);
	const action = await shell.executeAction();
	if (JSON.stringify(action) !== JSON.stringify(first)) throw new Error("peek/execute mismatch");
	emit({ event: "action", kind, info: action });
}

if (mode === "initial") {
	const repo = new SqliteSessionRepo({ path });
	const session = await repo.create();
	const fixture = await makeShell(session);
	const accepted = await fixture.shell.prompt(messages.prompt);
	const operationId = accepted.runOperation?.value.operationId;
	const promptEntryId = accepted.runOperation?.value.intent.promptEntryIds[0];
	if (!operationId || !promptEntryId) throw new Error("missing prompt identities");
	const followUpEntryId = (await fixture.shell.followUp(messages.followUp)).entryId;
	const nextRunEntryId = (await fixture.shell.nextRun(messages.nextRun)).entryId;
	emit({
		event: "baseline",
		metadata: session.metadata,
		operationId,
		promptEntryId,
		followUpEntryId,
		nextRunEntryId,
		effects: fixture.counts,
	});
	if (cut >= 1) {
		const steerEntryId = (await fixture.shell.steer(messages.steer)).entryId;
		emit({ event: "admitted", steerEntryId });
	}
	if (cut >= 2) await execute(fixture.shell, "consume_queue");
	if (cut >= 3) {
		const result = await fixture.shell.abort();
		emit({ event: "aborted", result });
	}
	if (cut >= 4) await execute(fixture.shell, "finish_aborted_run");
	emit({ event: "crash", cut, effects: fixture.counts });
	process.kill(process.pid, "SIGKILL");
	throw new Error("SIGKILL returned");
}

const encoded = process.argv[5];
if (!encoded) throw new Error("missing metadata");
const metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionMetadata;
let repo = new SqliteSessionRepo({ path });
let session = await repo.open(metadata);
let fixture = await makeShell(session);
const firstAction = await fixture.shell.peekAction();
emit({
	event: "opening",
	firstAction: firstAction ?? null,
	snapshot: snapshot(path, metadata.id),
	effects: fixture.counts,
});
if (cut === 0) {
	const steerEntryId = (await fixture.shell.steer(messages.steer)).entryId;
	emit({ event: "admitted", steerEntryId });
}
if (cut <= 1) await execute(fixture.shell, "consume_queue");
if (cut <= 2) {
	const result = await fixture.shell.abort();
	emit({ event: "aborted", result });
}
if (cut <= 3) await execute(fixture.shell, "finish_aborted_run");
if (await fixture.shell.peekAction()) throw new Error("terminal action remains");
await fixture.shell.close();
await repo.close();
const terminalSnapshot = snapshot(path, metadata.id);
const recoveryEffects = fixture.counts;

repo = new SqliteSessionRepo({ path });
session = await repo.open(metadata);
fixture = await makeShell(session);
const before = terminalSnapshot;
if (await fixture.shell.peekAction()) throw new Error("idle action");
await fixture.shell.runToCompletion();
if (await fixture.shell.peekAction()) throw new Error("idle action after drive");
await fixture.shell.close();
await repo.close();
const after = snapshot(path, metadata.id);
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("idle lifecycle wrote");
emit({
	event: "terminal",
	snapshot: terminalSnapshot,
	idleBefore: before,
	idleAfter: after,
	recoveryEffects,
	idleEffects: fixture.counts,
});
emit({ event: "complete" });
