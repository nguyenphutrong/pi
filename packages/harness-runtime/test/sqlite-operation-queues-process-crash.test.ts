import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isUuidV7 } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import {
	configuration,
	INITIAL_TIME,
	messages,
	plain,
	RECOVERY_TIME,
	VERSION,
	ZERO_USAGE,
} from "./sqlite-operation-queues-process-crash-support.ts";

const CHILD = fileURLToPath(new URL("./sqlite-operation-queues-process-crash-child.ts", import.meta.url));
interface Result {
	readonly events: readonly Record<string, unknown>[];
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

function run(mode: "initial" | "recovery", path: string, cut: number, metadata?: unknown): Promise<Result> {
	return new Promise((resolve, reject) => {
		const args = ["--no-warnings", CHILD, mode, path, String(cut)];
		if (metadata) args.push(Buffer.from(JSON.stringify(metadata)).toString("base64url"));
		const child = spawn(process.execPath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let bytes = 0;
		let stderrBytes = 0;
		let forced: Error | undefined;
		let cleanup = false;
		const fail = (error: Error) => {
			if (forced) return;
			forced = error;
			clearTimeout(timer);
			cleanup = true;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => fail(new Error(`${mode} timeout (parent cleanup kill)`)), 15_000);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
			if (bytes > 512 * 1024) return fail(new Error("stdout overflow"));
			stdout += chunk.toString();
			const lines = stdout.split("\n");
			if (lines.length - (lines.at(-1) === "" ? 1 : 0) > 32) return fail(new Error("event overflow"));
			if (lines.some((line) => Buffer.byteLength(line) > 128 * 1024)) fail(new Error("line overflow"));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.byteLength;
			fail(new Error(stderrBytes > 32 * 1024 ? "stderr overflow" : `unexpected stderr: ${chunk.toString()}`));
		});
		child.on("error", fail);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (forced || cleanup) return reject(forced ?? new Error("parent cleanup kill"));
			try {
				if (!stdout.endsWith("\n")) throw new Error("incomplete protocol");
				const events = stdout
					.slice(0, -1)
					.split("\n")
					.map((line) => JSON.parse(line) as unknown);
				if (events.length > 32 || !events.every(plain)) throw new Error("invalid protocol values");
				resolve({ events, code, signal });
			} catch (error) {
				reject(error);
			}
		});
	});
}

function exact(event: Record<string, unknown>, name: string, keys: readonly string[]): void {
	expect(Object.keys(event).sort()).toEqual(["v", "event", ...keys].sort());
	expect(event.v).toBe(VERSION);
	expect(event.event).toBe(name);
}

function assertAction(
	event: Record<string, unknown>,
	operationId: unknown,
	kind: "consume_queue" | "finish_aborted_run",
	steerEntryId?: unknown,
): void {
	exact(event, "action", ["kind", "info"]);
	expect(event.kind).toBe(kind);
	expect(event.info).toEqual(
		kind === "consume_queue"
			? { kind, operationId, queue: "steer", entryIds: [steerEntryId] }
			: { kind, operationId },
	);
}

function assertAborted(event: Record<string, unknown>, operationId: unknown): void {
	exact(event, "aborted", ["result"]);
	expect(event.result).toEqual({ operationId, drainedSteer: [], drainedFollowUp: [messages.followUp] });
}

describe.skipIf(process.platform === "win32")("SQLite operation queue process crash recovery", () => {
	it.each([0, 1, 2, 3, 4])("S%i", { timeout: 30_000 }, async (cut) => {
		const directory = await mkdtemp(join(tmpdir(), "harness-queue-crash-"));
		try {
			const path = join(directory, "sessions.sqlite");
			const initial = await run("initial", path, cut);
			expect(initial).toMatchObject({ code: null, signal: "SIGKILL" });
			const expectedInitial = [
				"baseline",
				...(cut >= 1 ? ["admitted"] : []),
				...(cut >= 2 ? ["action"] : []),
				...(cut >= 3 ? ["aborted"] : []),
				...(cut >= 4 ? ["action"] : []),
				"crash",
			];
			expect(initial.events.map((event) => event.event)).toEqual(expectedInitial);
			const baseline = initial.events[0];
			exact(baseline, "baseline", [
				"metadata",
				"operationId",
				"promptEntryId",
				"followUpEntryId",
				"nextRunEntryId",
				"effects",
			]);
			expect(baseline.metadata).toEqual({ id: expect.any(String), createdAt: INITIAL_TIME, storageVersion: 1 });
			expect(baseline.effects).toEqual({ modelLeases: 1, providerStarts: 0, toolStarts: 0 });
			const initialAdmitted = initial.events.find((event) => event.event === "admitted");
			if (initialAdmitted) exact(initialAdmitted, "admitted", ["steerEntryId"]);
			let initialIndex = 1 + (cut >= 1 ? 1 : 0);
			if (cut >= 2)
				assertAction(
					initial.events[initialIndex++],
					baseline.operationId,
					"consume_queue",
					initialAdmitted?.steerEntryId,
				);
			if (cut >= 3) assertAborted(initial.events[initialIndex++], baseline.operationId);
			if (cut >= 4) assertAction(initial.events[initialIndex++], baseline.operationId, "finish_aborted_run");
			const crash = initial.events.at(-1)!;
			exact(crash, "crash", ["cut", "effects"]);
			expect(crash).toMatchObject({ cut, effects: { modelLeases: 1, providerStarts: 0, toolStarts: 0 } });
			const recovery = await run("recovery", path, cut, baseline.metadata);
			expect(recovery).toMatchObject({ code: 0, signal: null });
			const expectedRecovery = [
				"opening",
				...(cut === 0 ? ["admitted"] : []),
				...(cut <= 1 ? ["action"] : []),
				...(cut <= 2 ? ["aborted"] : []),
				...(cut <= 3 ? ["action"] : []),
				"terminal",
				"complete",
			];
			expect(recovery.events.map((event) => event.event)).toEqual(expectedRecovery);
			const admitted = [...initial.events, ...recovery.events].filter((event) => event.event === "admitted");
			expect(admitted).toHaveLength(1);
			exact(admitted[0], "admitted", ["steerEntryId"]);
			const baselineIds = [
				(baseline.metadata as { id: string }).id,
				baseline.operationId,
				baseline.promptEntryId,
				baseline.followUpEntryId,
				baseline.nextRunEntryId,
			] as string[];
			const ids = [...baselineIds, admitted[0].steerEntryId] as string[];
			expect(ids.every((id) => typeof id === "string" && isUuidV7(id))).toBe(true);
			expect(new Set(ids).size).toBe(ids.length);
			const opening = recovery.events.find((event) => event.event === "opening")!;
			exact(opening, "opening", ["firstAction", "snapshot", "effects"]);
			expect(opening.effects).toEqual({ modelLeases: 0, providerStarts: 0, toolStarts: 0 });
			const expectedFirst =
				cut <= 2
					? {
							kind: cut <= 1 ? (cut === 0 ? "start_assistant_step" : "consume_queue") : "start_assistant_step",
							operationId: baseline.operationId,
							...(cut === 1
								? { queue: "steer", entryIds: [admitted[0].steerEntryId] }
								: { triggerEntryId: cut === 0 ? baseline.promptEntryId : admitted[0].steerEntryId }),
						}
					: cut === 3
						? { kind: "finish_aborted_run", operationId: baseline.operationId }
						: null;
			expect(opening.firstAction).toEqual(expectedFirst);
			const snapshot = opening.snapshot as Record<string, Array<Record<string, unknown>>>;
			assertSnapshot(
				snapshot,
				cut,
				baselineIds,
				true,
				cut <= 1 ? RECOVERY_TIME : INITIAL_TIME,
				cut === 0 ? undefined : ids[5],
			);
			let recoveryIndex = 1;
			if (cut === 0) {
				exact(recovery.events[recoveryIndex], "admitted", ["steerEntryId"]);
				expect(recovery.events[recoveryIndex++].steerEntryId).toBe(ids[5]);
			}
			if (cut <= 1) assertAction(recovery.events[recoveryIndex++], baseline.operationId, "consume_queue", ids[5]);
			if (cut <= 2) assertAborted(recovery.events[recoveryIndex++], baseline.operationId);
			if (cut <= 3) assertAction(recovery.events[recoveryIndex++], baseline.operationId, "finish_aborted_run");
			const terminal = recovery.events.at(-2)!;
			exact(terminal, "terminal", ["snapshot", "idleBefore", "idleAfter", "recoveryEffects", "idleEffects"]);
			exact(recovery.events.at(-1)!, "complete", []);
			expect(terminal.recoveryEffects).toEqual({ modelLeases: 0, providerStarts: 0, toolStarts: 0 });
			expect(terminal.idleEffects).toEqual({ modelLeases: 0, providerStarts: 0, toolStarts: 0 });
			expect(terminal.idleBefore).toEqual(terminal.snapshot);
			expect(terminal.idleAfter).toEqual(terminal.snapshot);
			assertSnapshot(
				terminal.snapshot as Record<string, Array<Record<string, unknown>>>,
				4,
				baselineIds,
				false,
				cut <= 1 ? RECOVERY_TIME : INITIAL_TIME,
				ids[5],
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function assertSnapshot(
	rows: Record<string, Array<Record<string, unknown>>>,
	cut: number,
	ids: string[],
	opening: boolean,
	steerTimestamp: number,
	steerAuthority?: string,
): void {
	const [sessionId, operationId, promptId, followId, nextId] = ids;
	const steerId = steerAuthority;
	if (cut > 0) expect(steerId).toEqual(expect.any(String));
	expect(Object.keys(rows).sort()).toEqual(
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
	expect(rows.sessions).toEqual([
		{ session_id: sessionId, created_at: INITIAL_TIME, parent_session_id: null, storage_version: 1, metadata: null },
	]);
	expect(rows.sequences).toEqual([{ session_id: sessionId, next_seq: [13, 15, 19, 20, 25][cut] }]);
	expect(rows.stats).toEqual([
		{ session_id: sessionId, message_count: cut < 2 ? 1 : 2, usage_payload: JSON.stringify(ZERO_USAGE) },
	]);
	expect(rows.usage).toEqual([]);
	expect(rows.entries).toEqual([
		{
			session_id: sessionId,
			id: promptId,
			seq: 4,
			parent_id: null,
			timestamp: INITIAL_TIME,
			type: "message",
			custom_type: null,
			payload: JSON.stringify(messages.prompt),
		},
		...(cut >= 2
			? [
					{
						session_id: sessionId,
						id: steerId,
						seq: 15,
						parent_id: promptId,
						timestamp: steerTimestamp,
						type: "message",
						custom_type: null,
						payload: JSON.stringify(messages.steer),
					},
				]
			: []),
	]);
	expect(rows.branches).toEqual([
		{
			session_id: sessionId,
			branch_id: `segment:${promptId}`,
			tip_entry_id: cut >= 2 ? steerId : promptId,
			tip_seq: cut >= 2 ? 15 : 4,
			base_branch_id: null,
			base_seq: null,
		},
	]);
	expect(rows.branchEntries).toEqual(
		rows.entries.map((entry) => ({
			session_id: sessionId,
			branch_id: `segment:${promptId}`,
			entry_seq: entry.seq,
			entry_id: entry.id,
			entry_type: "message",
		})),
	);
	const registers = new Map(rows.registers.map((row) => [`${row.namespace}/${row.key}`, row]));
	const expectedSeqs: Record<string, number> = {
		"lane.config/main": 3,
		"lane.leaf/main": cut >= 2 ? 17 : 5,
		"lane.state/main": cut === 4 ? 24 : 12,
		[`pending.entry/${nextId}`]: 11,
	};
	if (cut < 4) {
		expectedSeqs[`op.meta/${operationId}`] = 6;
		expectedSeqs[`op.state/${operationId}`] = [10, 14, 18, 19][cut];
		expectedSeqs[`pending.entry/${followId}`] = 9;
		if (cut === 1) expectedSeqs[`pending.entry/${steerId}`] = 13;
	} else expectedSeqs["lane.lastResult/main"] = 23;
	expect(Object.fromEntries([...registers].map(([key, row]) => [key, row.seq]))).toEqual(expectedSeqs);
	expect(JSON.parse(registers.get("lane.config/main")!.value as string)).toEqual(configuration);
	expect(JSON.parse(registers.get("lane.leaf/main")!.value as string)).toBe(cut >= 2 ? steerId : promptId);
	expect(JSON.parse(registers.get(`pending.entry/${nextId}`)!.value as string)).toEqual({
		type: "message",
		payload: messages.nextRun,
	});
	expect(JSON.parse(registers.get("lane.state/main")!.value as string)).toEqual({
		currentOperationId: cut === 4 ? null : operationId,
		pendingNextRun: [nextId],
	});
	if (cut < 4) {
		expect(JSON.parse(registers.get(`pending.entry/${followId}`)!.value as string)).toEqual({
			type: "message",
			payload: messages.followUp,
		});
		if (cut === 1) {
			expect(JSON.parse(registers.get(`pending.entry/${steerId}`)!.value as string)).toEqual({
				type: "message",
				payload: messages.steer,
			});
		}
		expect(JSON.parse(registers.get(`op.meta/${operationId}`)!.value as string)).toEqual({
			operationId,
			lane: "main",
			sourceLeafId: null,
			startedAt: INITIAL_TIME,
			intent: { kind: "run", promptEntryIds: [promptId] },
		});
		const control =
			cut >= 3
				? { status: "cancel_requested", requestedAt: INITIAL_TIME, drainedSteer: [], drainedFollowUp: [followId] }
				: { status: "running" };
		expect(JSON.parse(registers.get(`op.state/${operationId}`)!.value as string)).toEqual({
			kind: "run",
			control,
			settings: {
				compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				toolExecution: "sequential",
			},
			phase: {
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: cut >= 2 ? steerId : promptId,
				...(cut >= 2 ? { skipInboxOnce: true } : {}),
			},
			inbox: { steer: cut === 1 ? [steerId] : [], followUp: cut >= 3 ? [] : [followId], writes: [] },
			latestAssistantEntryId: null,
		});
	} else {
		expect(JSON.parse(registers.get("lane.lastResult/main")!.value as string)).toEqual({
			operationId,
			kind: "run",
			outcome: "aborted",
			leafId: steerId,
		});
	}
	if (opening) {
		expect(rows.writerLeases).toEqual([
			{ session_id: sessionId, owner_id: expect.any(String), fence: 2, expires_at_ms: RECOVERY_TIME + 30_000 },
		]);
		expect(isUuidV7(rows.writerLeases[0].owner_id as string)).toBe(true);
	} else expect(rows.writerLeases).toEqual([]);
}
