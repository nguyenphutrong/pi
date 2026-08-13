import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isUuidV7 } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import type { ActionInfo } from "../src/planner.ts";
import { user } from "./fixtures.ts";
import {
	actionShape,
	assistantMessage,
	configuration,
	finalUsage,
	firstUsage,
	INITIAL_TIME,
	plain,
	RECOVERY_TIME,
	type Replay,
	TRACE,
	VERSION,
} from "./sqlite-runtime-process-crash-support.ts";

const CHILD = fileURLToPath(new URL("./sqlite-runtime-process-crash-child.ts", import.meta.url));
const cases = (["safe", "never"] as const).flatMap((replay) =>
	Array.from({ length: 17 }, (_, cut) => ({ replay, cut })),
);
interface Result {
	readonly events: readonly Record<string, unknown>[];
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

function run(
	mode: "initial" | "recovery",
	path: string,
	replay: Replay,
	cut: number,
	metadata?: unknown,
): Promise<Result> {
	return new Promise((resolve, reject) => {
		const args = ["--no-warnings", CHILD, mode, path, replay, String(cut)];
		if (metadata) args.push(Buffer.from(JSON.stringify(metadata)).toString("base64url"));
		const child = spawn(process.execPath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let out = 0;
		let err = 0;
		let done = false;
		let forcedError: Error | undefined;
		let cleanupSent = false;
		const fail = (error: Error) => {
			if (done || forcedError) return;
			forcedError = error;
			clearTimeout(timer);
			if (!cleanupSent) {
				cleanupSent = true;
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => fail(new Error(`${mode} timed out`)), 15_000);
		child.stdout.on("data", (chunk: Buffer) => {
			if (forcedError) return;
			out += chunk.byteLength;
			if (out > 512 * 1024) return fail(new Error("stdout overflow"));
			stdout += chunk.toString();
			const lines = stdout.split("\n");
			if (lines.length - (lines.at(-1) === "" ? 1 : 0) > 32) return fail(new Error("event overflow"));
			if (lines.some((line) => Buffer.byteLength(line) > 128 * 1024)) fail(new Error("line overflow"));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (forcedError) return;
			err += chunk.byteLength;
			fail(new Error(err > 32 * 1024 ? "stderr overflow" : `unexpected stderr: ${chunk.toString()}`));
		});
		child.on("error", fail);
		child.on("close", (code, signal) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (forcedError) return reject(forcedError);
			try {
				if (!stdout.endsWith("\n")) throw new Error("incomplete protocol");
				const values = stdout
					.slice(0, -1)
					.split("\n")
					.map((line) => JSON.parse(line) as unknown);
				if (values.length > 32 || !values.every(plain)) throw new Error("invalid protocol values");
				resolve({ events: values, code, signal });
			} catch (error) {
				reject(error);
			}
		});
	});
}

function recoveryKinds(replay: Replay, cut: number): readonly string[] {
	const retry = [
		"recover_assistant_effect",
		"wait_assistant_retry",
		"release_assistant_retry",
		"prepare_assistant_effect",
		"dispatch_assistant_effect",
		"await_assistant_effect",
		"settle_assistant_effect",
	];
	if ([2, 3, 4].includes(cut)) return [...retry, ...TRACE.slice(5)];
	if ([12, 13, 14].includes(cut)) return [...retry, ...TRACE.slice(15)];
	if ([6, 7, 8, 9].includes(cut)) return ["recover_tool_effect", ...TRACE.slice(replay === "safe" ? 6 : 10)];
	if (cut === 15) return ["finish_run"];
	return TRACE.slice(cut);
}

function assertGrammar(
	events: readonly Record<string, unknown>[],
	phase: "initial" | "recovery",
	kinds: readonly string[],
): ActionInfo[] {
	let cursor = phase === "initial" ? 2 : 2;
	const result: ActionInfo[] = [];
	for (const [index, kind] of kinds.entries()) {
		if (kind === "dispatch_assistant_effect") {
			const start = events[cursor++];
			exact(start, "provider-start", ["phase", "ordinal", "context"]);
			expect(start.phase).toBe(phase);
			expect(Number.isSafeInteger(start.ordinal)).toBe(true);
			expect(plain(start.context)).toBe(true);
			expect(Array.isArray((start.context as Record<string, unknown>).messages)).toBe(true);
		}
		if (kind === "dispatch_tool_effect") {
			const start = events[cursor++];
			exact(start, "tool-start", ["phase", "ordinal", "callId", "args", "replay"]);
			expect(start.phase).toBe(phase);
			expect(Number.isSafeInteger(start.ordinal)).toBe(true);
			expect(start.callId).toBe("echo-1");
			expect(start.args).toEqual({ value: "durable echo" });
		}
		const event = events[cursor++];
		exact(event, "action", ["phase", "index", "info"]);
		expect(event.phase).toBe(phase);
		expect(event.index).toBe(index);
		if (!actionShape(event.info)) throw new Error("invalid action");
		expect(event.info.kind).toBe(kind);
		result.push(event.info);
	}
	const finalNames = phase === "initial" ? ["crash"] : ["terminal", "complete"];
	expect(events.slice(cursor).map((event) => event.event)).toEqual(finalNames);
	return result;
}

function exact(event: Record<string, unknown>, name: string, keys: readonly string[]): void {
	expect(Object.keys(event).sort()).toEqual(["v", "event", ...keys].sort());
	expect(event.v).toBe(VERSION);
	expect(event.event).toBe(name);
}

function assertPrefix(values: ActionInfo[], operationId: string, promptEntryId: string): void {
	expect(values.map(({ kind }) => kind)).toEqual(TRACE.slice(0, values.length));
	expect(values.every((action) => action.operationId === operationId)).toBe(true);
	if (values[0])
		expect(values[0]).toEqual({ kind: "start_assistant_step", operationId, triggerEntryId: promptEntryId });
	const prepares = values.filter((a) => a.kind === "prepare_assistant_effect");
	for (const prepare of prepares) {
		expect(isUuidV7(prepare.stepId)).toBe(true);
		const key = `assistant:${operationId}:${prepare.stepId}:${prepare.nextAttempt}`;
		for (const kind of ["dispatch_assistant_effect", "await_assistant_effect", "settle_assistant_effect"] as const) {
			const action = values.find((a) => a.kind === kind && a.effectKey === key);
			if (
				values.indexOf(prepare) +
					[1, 2, 3][
						["dispatch_assistant_effect", "await_assistant_effect", "settle_assistant_effect"].indexOf(kind)
					] <
				values.length
			)
				expect(action).toBeDefined();
		}
	}
}

function assertAllActions(
	actions: ActionInfo[],
	operationId: string,
	promptId: string,
	branch: Array<{ id: string }>,
): void {
	expect(actions.every((action) => action.operationId === operationId)).toBe(true);
	const stepIds: string[] = [];
	for (const action of actions) {
		if ("stepId" in action && !stepIds.includes(action.stepId)) stepIds.push(action.stepId);
		for (const key of ["effectKey"] as const)
			if (key in action && action.effectKey.startsWith("assistant:")) {
				const step = action.effectKey.split(":")[2];
				if (!stepIds.includes(step)) stepIds.push(step);
			}
	}
	expect(stepIds).toHaveLength(2);
	expect(stepIds.every(isUuidV7)).toBe(true);
	const starts = actions.filter((a) => a.kind === "start_assistant_step");
	expect(starts).toEqual([
		{ kind: "start_assistant_step", operationId, triggerEntryId: promptId },
		{ kind: "start_assistant_step", operationId, triggerEntryId: branch[2].id },
	]);
	for (const stepId of stepIds) {
		const recovered = actions.find((a) => a.kind === "recover_assistant_effect" && a.stepId === stepId);
		if (recovered?.kind === "recover_assistant_effect") {
			expect(recovered.attempt).toBe(1);
			expect(
				actions.filter(
					(a) =>
						(a.kind === "wait_assistant_retry" || a.kind === "release_assistant_retry") && a.stepId === stepId,
				),
			).toEqual([
				{ kind: "wait_assistant_retry", operationId, stepId, nextAttempt: 2, notBefore: RECOVERY_TIME },
				{ kind: "release_assistant_retry", operationId, stepId, nextAttempt: 2, notBefore: RECOVERY_TIME },
			]);
		}
		const attempt = recovered ? 2 : 1;
		expect(actions).toContainEqual({ kind: "prepare_assistant_effect", operationId, stepId, nextAttempt: attempt });
		const key = `assistant:${operationId}:${stepId}:${attempt}`;
		for (const kind of ["dispatch_assistant_effect", "await_assistant_effect", "settle_assistant_effect"])
			expect(actions).toContainEqual({ kind, operationId, effectKey: key });
	}
	const prepareTool = {
		kind: "prepare_tool_call",
		operationId,
		assistantEntryId: branch[1].id,
		sourceIndex: 0,
		resultEntryId: branch[2].id,
	};
	expect(actions.filter((a) => a.kind === "prepare_tool_call")).toEqual([prepareTool]);
	const recoverTools = actions.filter((a) => a.kind === "recover_tool_effect");
	if (recoverTools.length)
		expect(recoverTools).toEqual([
			{
				kind: "recover_tool_effect",
				operationId,
				assistantEntryId: branch[1].id,
				turnId: stepIds[0],
				sourceIndex: 0,
				resultEntryId: branch[2].id,
			},
		]);
	for (const action of actions) {
		if ("effectKey" in action && action.effectKey.startsWith("tool:"))
			expect(action.effectKey).toBe(`tool:${operationId}:${stepIds[0]}:0`);
	}
	expect(actions.filter((a) => a.kind === "finish_run")).toEqual([
		{ kind: "finish_run", operationId, triggerEntryId: branch[3].id },
	]);
}

describe.skipIf(process.platform === "win32")("SQLite RuntimeShell process crash recovery", () => {
	it.each(cases)("replay=$replay cut=$cut", { timeout: 30_000 }, async ({ replay, cut }) => {
		const directory = await mkdtemp(join(tmpdir(), "harness-runtime-crash-"));
		const path = join(directory, "sessions.sqlite");
		try {
			const initial = await run("initial", path, replay, cut);
			expect(initial).toMatchObject({ code: null, signal: "SIGKILL" });
			const ready = initial.events[0];
			exact(ready, "ready", ["phase"]);
			expect(ready.phase).toBe("initial");
			const accepted = initial.events[1];
			exact(accepted, "accepted", ["metadata", "operationId", "promptEntryId"]);
			expect(accepted.metadata).toEqual({ id: expect.any(String), createdAt: INITIAL_TIME, storageVersion: 1 });
			expect(isUuidV7((accepted.metadata as { id: string }).id)).toBe(true);
			expect(isUuidV7(accepted.operationId as string)).toBe(true);
			expect(isUuidV7(accepted.promptEntryId as string)).toBe(true);
			const prefix = assertGrammar(initial.events, "initial", TRACE.slice(0, cut));
			expect(prefix).toHaveLength(cut);
			assertPrefix(prefix, accepted.operationId as string, accepted.promptEntryId as string);
			const crash = initial.events.at(-1)!;
			exact(crash, "crash", ["cut"]);
			expect(crash.cut).toBe(cut);
			const recovery = await run("recovery", path, replay, cut, accepted.metadata);
			expect(recovery).toMatchObject({ code: 0, signal: null });
			exact(recovery.events[0], "ready", ["phase"]);
			expect(recovery.events[0].phase).toBe("recovery");
			const recoveryReady = recovery.events[1];
			exact(recoveryReady, "recovery-ready", ["firstAction", "writerLease"]);
			const expectedRecoveryKinds = recoveryKinds(replay, cut);
			const recovered = assertGrammar(recovery.events, "recovery", expectedRecoveryKinds);
			expect(recoveryReady.firstAction).toEqual(recovered[0] ?? null);
			expect(recoveryReady.writerLease).toEqual({
				session_id: (accepted.metadata as { id: string }).id,
				owner_id: expect.any(String),
				fence: 2,
				expires_at_ms: RECOVERY_TIME + 30_000,
			});
			expect(isUuidV7((recoveryReady.writerLease as { owner_id: string }).owner_id)).toBe(true);
			const terminal = recovery.events.at(-2)!;
			exact(terminal, "terminal", ["evidence", "idleEvidence", "snapshot", "idleSnapshot"]);
			exact(recovery.events.at(-1)!, "complete", []);
			const provider = [...initial.events, ...recovery.events].filter((event) => event.event === "provider-start");
			const tool = [...initial.events, ...recovery.events].filter((event) => event.event === "tool-start");
			const initialProviderCount = (cut >= 3 ? 1 : 0) + (cut >= 13 ? 1 : 0);
			const initialToolCount = cut >= 7 ? 1 : 0;
			expect(initial.events.filter((event) => event.event === "provider-start")).toHaveLength(initialProviderCount);
			expect(initial.events.filter((event) => event.event === "tool-start")).toHaveLength(initialToolCount);
			expect(provider.map((event) => event.phase)).toEqual([
				...Array(initialProviderCount).fill("initial"),
				...Array(provider.length - initialProviderCount).fill("recovery"),
			]);
			expect(tool.map((event) => event.phase)).toEqual([
				...Array(initialToolCount).fill("initial"),
				...Array(tool.length - initialToolCount).fill("recovery"),
			]);
			for (const phase of ["initial", "recovery"] as const) {
				provider
					.filter((event) => event.phase === phase)
					.forEach((event, ordinal) => {
						exact(event, "provider-start", ["phase", "ordinal", "context"]);
						expect(event.ordinal).toBe(ordinal);
					});
				tool
					.filter((event) => event.phase === phase)
					.forEach((event, ordinal) => {
						exact(event, "tool-start", ["phase", "ordinal", "callId", "args", "replay"]);
						expect(event.ordinal).toBe(ordinal);
						expect(event.args).toEqual({ value: "durable echo" });
						expect(event.callId).toBe("echo-1");
						expect(event.replay).toBe(replay);
					});
			}
			const uncertain = [3, 4, 13, 14].includes(cut);
			const pending = [6, 7, 8, 9].includes(cut);
			expect(provider).toHaveLength(uncertain ? 3 : 2);
			expect(tool).toHaveLength(
				replay === "never" && cut === 6 ? 0 : replay === "safe" && [7, 8, 9].includes(cut) ? 2 : 1,
			);
			expect(Object.keys(terminal.evidence as object).sort()).toEqual(
				["metadata", "branch", "stats", "leaf"].sort(),
			);
			const evidence = terminal.evidence as {
				metadata: unknown;
				branch: Array<{ id: string; parentId: string | null; seq: number; timestamp: number; message: unknown }>;
				stats: unknown;
				leaf: string;
			};
			expect(evidence.metadata).toEqual(accepted.metadata);
			const branch = evidence.branch;
			expect(branch).toHaveLength(4);
			expect(branch.every(({ id }) => isUuidV7(id))).toBe(true);
			expect(new Set(branch.map(({ id }) => id)).size).toBe(4);
			expect(
				branch.map(({ seq }) => seq).every((seq, index, all) => seq > 0 && (index === 0 || seq > all[index - 1])),
			).toBe(true);
			expect(branch.map(({ parentId }) => parentId)).toEqual([null, ...branch.slice(0, -1).map(({ id }) => id)]);
			expect(evidence.leaf).toBe(branch[3].id);
			expect(branch[0].message).toEqual(user("run echo"));
			expect(branch[1].message).toEqual(assistantMessage(false));
			expect(branch[2].message).toEqual(
				replay === "never" && pending
					? {
							role: "toolResult",
							toolCallId: "echo-1",
							toolName: "echo",
							content: [{ type: "text", text: "Tool outcome unknown after interruption" }],
							details: {},
							isError: true,
							timestamp: expect.any(Number),
						}
					: {
							role: "toolResult",
							toolCallId: "echo-1",
							toolName: "echo",
							content: [{ type: "text", text: "echoed: durable echo" }],
							details: { durable: true },
							isError: false,
							timestamp: expect.any(Number),
						},
			);
			expect(branch[3].message).toEqual(assistantMessage(true));
			assertAllActions(
				[...prefix, ...recovered],
				accepted.operationId as string,
				accepted.promptEntryId as string,
				branch,
			);
			const interrupted = replay === "never" && pending;
			expect((branch[2].message as { timestamp: number }).timestamp).toBe(
				interrupted ? RECOVERY_TIME : cut >= 10 ? INITIAL_TIME : RECOVERY_TIME,
			);
			expect(branch[2].message).not.toHaveProperty("usage");
			expect(branch.map((entry) => entry.timestamp)).toEqual([
				INITIAL_TIME,
				cut >= 5 ? INITIAL_TIME : RECOVERY_TIME,
				cut >= 10 ? INITIAL_TIME : RECOVERY_TIME,
				cut >= 15 ? INITIAL_TIME : RECOVERY_TIME,
			]);
			expect(evidence.stats).toEqual({
				messageCount: 4,
				usage: { ...firstUsage, input: 10, output: 6, totalTokens: 16 },
			});
			const contexts = provider.map((event) => {
				expect(event.context).toEqual({ messages: (event.context as { messages: unknown[] }).messages });
				return (event.context as { messages: unknown[] }).messages;
			});
			const initialContext = [branch[0].message];
			const resultContext = branch.slice(0, 3).map(({ message }) => message);
			expect(contexts).toEqual(
				[3, 4].includes(cut)
					? [initialContext, initialContext, resultContext]
					: [13, 14].includes(cut)
						? [initialContext, resultContext, resultContext]
						: [initialContext, resultContext],
			);
			expect(plain(terminal.evidence)).toBe(true);
			expect(plain(terminal.idleEvidence)).toBe(true);
			expect(plain(terminal.snapshot)).toBe(true);
			expect(plain(terminal.idleSnapshot)).toBe(true);
			const snapshot = terminal.snapshot as Record<string, Array<Record<string, unknown>>>;
			expect(Object.values(snapshot).every(Array.isArray)).toBe(true);
			expect(terminal.idleEvidence).toEqual({
				before: evidence,
				after: evidence,
				effects: { modelLeases: 0, providerStarts: 0, toolStarts: 0 },
			});
			expect(Object.keys(snapshot).sort()).toEqual(
				[
					"sessions",
					"sequences",
					"stats",
					"entries",
					"registers",
					"usage",
					"branches",
					"branchEntries",
					"writerLeases",
				].sort(),
			);
			const sessionId = (accepted.metadata as { id: string }).id;
			expect(snapshot.sessions).toEqual([
				{
					session_id: sessionId,
					created_at: INITIAL_TIME,
					parent_session_id: null,
					storage_version: 1,
					metadata: null,
				},
			]);
			expect(snapshot.sequences).toHaveLength(1);
			expect(Object.keys(snapshot.sequences[0]).sort()).toEqual(["session_id", "next_seq"].sort());
			expect(snapshot.sequences[0].session_id).toBe(sessionId);
			const occupiedSeqs = [
				...branch.map((entry) => entry.seq),
				...snapshot.registers.map((row) => row.seq as number),
				...snapshot.usage.map((row) => row.seq as number),
			];
			expect(occupiedSeqs.every((seq) => Number.isSafeInteger(seq) && seq > 0)).toBe(true);
			expect(new Set(occupiedSeqs).size).toBe(occupiedSeqs.length);
			expect(Number.isSafeInteger(snapshot.sequences[0].next_seq)).toBe(true);
			expect(snapshot.sequences[0].next_seq).toBe(Math.max(...occupiedSeqs) + 1);
			const totalUsage = { ...firstUsage, input: 10, output: 6, totalTokens: 16 };
			expect(snapshot.stats).toEqual([
				{ session_id: sessionId, message_count: 4, usage_payload: JSON.stringify(totalUsage) },
			]);
			expect(snapshot.entries).toEqual(
				branch.map((entry) => ({
					session_id: sessionId,
					id: entry.id,
					seq: entry.seq,
					parent_id: entry.parentId,
					timestamp: entry.timestamp,
					type: "message",
					custom_type: null,
					payload: JSON.stringify(entry.message),
				})),
			);
			expect(snapshot.writerLeases).toEqual([]);
			expect(terminal.idleSnapshot).toEqual(snapshot);
			const usageIds = snapshot.usage.map((row) => row.id);
			expect(usageIds.every((id) => typeof id === "string" && isUuidV7(id))).toBe(true);
			expect(new Set(usageIds).size).toBe(2);
			expect(usageIds.every((id) => !branch.some((entry) => entry.id === id))).toBe(true);
			expect(snapshot.usage.map(({ id: _id, ...row }) => row)).toEqual([
				{
					session_id: sessionId,
					seq: branch[1].seq + 2,
					entry_id: branch[1].id,
					usage: JSON.stringify(firstUsage),
					adjustment: 0,
					details: null,
				},
				{
					session_id: sessionId,
					seq: branch[3].seq + 2,
					entry_id: branch[3].id,
					usage: JSON.stringify(finalUsage),
					adjustment: 0,
					details: null,
				},
			]);
			const registerNames = snapshot.registers.map((row) => row.namespace).sort();
			expect(registerNames).toEqual(["lane.config", "lane.lastResult", "lane.leaf", "lane.state"]);
			for (const row of snapshot.registers) {
				expect(Object.keys(row).sort()).toEqual(["session_id", "namespace", "key", "value", "seq"].sort());
				expect(row.session_id).toBe(sessionId);
				expect(row.key).toBe("main");
				expect(Number.isSafeInteger(row.seq)).toBe(true);
			}
			const value = (namespace: string) =>
				JSON.parse(snapshot.registers.find((row) => row.namespace === namespace)!.value as string);
			expect(value("lane.config")).toEqual(configuration);
			expect(value("lane.leaf")).toBe(branch[3].id);
			expect(value("lane.state")).toEqual({ currentOperationId: null, pendingNextRun: [] });
			const last = snapshot.registers.find((row) => row.namespace === "lane.lastResult");
			expect(JSON.parse(last?.value as string)).toEqual({
				operationId: accepted.operationId,
				kind: "run",
				outcome: "completed",
				leafId: branch[3].id,
				finalAssistantEntryId: branch[3].id,
				runCompletion: "assistant",
			});
			expect(snapshot.branches).toEqual([
				{
					session_id: sessionId,
					branch_id: `segment:${branch[0].id}`,
					tip_entry_id: branch[3].id,
					tip_seq: branch[3].seq,
					base_branch_id: null,
					base_seq: null,
				},
			]);
			expect(snapshot.branchEntries).toEqual(
				branch.map((entry) => ({
					session_id: sessionId,
					branch_id: `segment:${branch[0].id}`,
					entry_seq: entry.seq,
					entry_id: entry.id,
					entry_type: "message",
				})),
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
