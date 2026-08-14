import { SqliteSessionRepo } from "../src/repo.ts";
import { createRuntimeShell, type RuntimeShell } from "../src/runtime-shell.ts";
import type { Session, SessionMetadata } from "../src/types.ts";
import {
	actionShape,
	type Classification,
	type Cut,
	configuration,
	effects,
	emit,
	INITIAL_TIME,
	prompt,
	RECOVERY_TIME,
	snapshot,
} from "./sqlite-deferred-writes-process-crash-support.ts";

const mode = process.argv[2];
const path = process.argv[3];
const classification = process.argv[4] as Classification;
const cut = process.argv[5] as Cut;
if (
	(mode !== "initial" && mode !== "recovery") ||
	!path ||
	!["projecting", "unprojected"].includes(classification) ||
	!["pre-placement", "post-placement"].includes(cut)
)
	throw new Error("invalid arguments");
Date.now = () => (mode === "initial" ? INITIAL_TIME : RECOVERY_TIME);

async function makeShell(session: Session, phase: "initial" | "recovery" | "idle") {
	const fixture = effects(classification, phase);
	const shell = await createRuntimeShell(session, configuration, {
		models: fixture.models,
		tools: [fixture.tool],
		toolContext: {},
		entryProjectors: fixture.entryProjectors,
	});
	return { shell, counts: fixture.counts };
}

async function execute(shell: RuntimeShell<object>, kind: "apply_deferred_writes" | "finish_aborted_run") {
	const peeked = await shell.peekAction();
	if (!actionShape(peeked) || peeked.kind !== kind) throw new Error(`expected ${kind}`);
	const executed = await shell.executeAction();
	if (JSON.stringify(peeked) !== JSON.stringify(executed)) throw new Error("peek/execute mismatch");
	emit({ event: "action", info: executed });
}

if (mode === "initial") {
	const repo = new SqliteSessionRepo({ path });
	const session = await repo.create();
	const fixture = await makeShell(session, "initial");
	const accepted = await fixture.shell.prompt(prompt);
	const operationId = accepted.runOperation?.value.operationId;
	const promptEntryId = accepted.runOperation?.value.intent.promptEntryIds[0];
	if (!operationId || !promptEntryId) throw new Error("missing identities");
	emit({ event: "accepted", metadata: session.metadata, operationId, promptEntryId, effects: fixture.counts });
	const writeEntryId =
		classification === "projecting"
			? await fixture.shell.session.appendCustomEntry(classification, null)
			: await fixture.shell.session.appendCustomEntry(classification);
	emit({ event: "admitted", writeEntryId });
	if (cut === "post-placement") await execute(fixture.shell, "apply_deferred_writes");
	emit({ event: "crash", classification, cut, effects: fixture.counts });
	process.kill(process.pid, "SIGKILL");
	throw new Error("SIGKILL returned");
}

const encoded = process.argv[6];
if (!encoded) throw new Error("missing metadata");
const metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionMetadata;
let repo = new SqliteSessionRepo({ path });
let session = await repo.open(metadata);
let fixture = await makeShell(session, "recovery");
const firstAction = await fixture.shell.peekAction();
if (firstAction !== undefined && !actionShape(firstAction)) throw new Error("invalid opening action");
emit({
	event: "opening",
	firstAction: firstAction ?? null,
	snapshot: snapshot(path, metadata.id),
	effects: fixture.counts,
});
if (cut === "pre-placement") await execute(fixture.shell, "apply_deferred_writes");
const abortResult = await fixture.shell.abort();
emit({ event: "abort", result: abortResult });
await execute(fixture.shell, "finish_aborted_run");
if (await fixture.shell.peekAction()) throw new Error("terminal action remains");
await fixture.shell.close();
await repo.close();
const terminalSnapshot = snapshot(path, metadata.id);
const recoveryEffects = fixture.counts;

repo = new SqliteSessionRepo({ path });
session = await repo.open(metadata);
fixture = await makeShell(session, "idle");
const idleAction = await fixture.shell.peekAction();
await fixture.shell.runToCompletion();
const idleActionAfterRun = await fixture.shell.peekAction();
await fixture.shell.close();
await repo.close();
const idleSnapshot = snapshot(path, metadata.id);
emit({
	event: "terminal",
	snapshot: terminalSnapshot,
	idleSnapshot,
	idleAction: idleAction ?? null,
	idleActionAfterRun: idleActionAfterRun ?? null,
	recoveryEffects,
	idleEffects: fixture.counts,
});
emit({ event: "complete" });
