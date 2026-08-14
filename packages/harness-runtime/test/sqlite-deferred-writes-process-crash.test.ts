import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isUuidV7 } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import {
	type Classification,
	type Cut,
	configuration,
	INITIAL_TIME,
	plain,
	prompt,
	RECOVERY_TIME,
	VERSION,
	ZERO_USAGE,
} from "./sqlite-deferred-writes-process-crash-support.ts";

const CHILD = fileURLToPath(new URL("./sqlite-deferred-writes-process-crash-child.ts", import.meta.url));
const cases = (["projecting", "unprojected"] as const).flatMap((classification) =>
	(["pre-placement", "post-placement"] as const).map((cut) => ({ classification, cut })),
);
interface Result {
	events: Record<string, unknown>[];
	code: number | null;
	signal: NodeJS.Signals | null;
}

function run(
	mode: "initial" | "recovery",
	path: string,
	classification: Classification,
	cut: Cut,
	metadata?: unknown,
): Promise<Result> {
	return new Promise((resolve, reject) => {
		const args = ["--no-warnings", CHILD, mode, path, classification, cut];
		if (metadata) args.push(Buffer.from(JSON.stringify(metadata)).toString("base64url"));
		const child = spawn(process.execPath, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "",
			out = 0,
			err = 0,
			forced: Error | undefined;
		const fail = (error: Error) => {
			if (forced) return;
			forced = error;
			clearTimeout(timer);
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => fail(new Error(`${mode} timeout`)), 15_000);
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.byteLength;
			if (out > 512 * 1024) return fail(new Error("stdout overflow"));
			stdout += chunk;
			const lines = stdout.split("\n");
			if (lines.length - (lines.at(-1) === "" ? 1 : 0) > 24) return fail(new Error("event overflow"));
			if (lines.some((line) => Buffer.byteLength(line) > 128 * 1024)) fail(new Error("line overflow"));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.byteLength;
			fail(new Error(err > 32 * 1024 ? "stderr overflow" : `unexpected stderr: ${chunk}`));
		});
		child.on("error", fail);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (forced) return reject(forced);
			try {
				if (!stdout.endsWith("\n")) throw new Error("incomplete protocol");
				const events = stdout
					.slice(0, -1)
					.split("\n")
					.map((line) => JSON.parse(line) as unknown);
				if (events.length > 24 || !events.every(plain)) throw new Error("invalid protocol");
				if (!events.every((event) => event.v === VERSION && typeof event.event === "string"))
					throw new Error("invalid protocol envelope");
				resolve({ events, code, signal });
			} catch (error) {
				reject(error);
			}
		});
	});
}

function exact(event: Record<string, unknown>, name: string, keys: string[]) {
	expect(Object.keys(event).sort()).toEqual(["v", "event", ...keys].sort());
	expect(event).toMatchObject({ v: VERSION, event: name });
}

describe.skipIf(process.platform === "win32")("D-055 SQLite deferred-write process crash recovery", () => {
	it.each(cases)("classification=$classification cut=$cut", { timeout: 30_000 }, async ({ classification, cut }) => {
		const directory = await mkdtemp(join(tmpdir(), "harness-write-crash-"));
		try {
			const path = join(directory, "sessions.sqlite");
			const initial = await run("initial", path, classification, cut);
			expect(initial).toMatchObject({ code: null, signal: "SIGKILL" });
			const accepted = initial.events[0];
			exact(accepted, "accepted", ["metadata", "operationId", "promptEntryId", "effects"]);
			expect(accepted.effects).toEqual({ modelLeases: 1, providerStarts: 0, toolStarts: 0, projectors: 0 });
			const admitted = initial.events[1];
			exact(admitted, "admitted", ["writeEntryId"]);
			const crash = initial.events.at(-1)!;
			exact(crash, "crash", ["classification", "cut", "effects"]);
			expect(crash).toMatchObject({
				classification,
				cut,
				effects: {
					modelLeases: 1,
					providerStarts: 0,
					toolStarts: 0,
					projectors: cut === "post-placement" ? 1 : 0,
				},
			});
			const recovery = await run("recovery", path, classification, cut, accepted.metadata);
			expect(recovery).toMatchObject({ code: 0, signal: null });
			const combined = [...initial.events, ...recovery.events];
			expect(combined.filter((event) => event.event === "admitted")).toHaveLength(1);
			expect(combined.filter((event) => event.event === "projector")).toEqual([
				{
					v: VERSION,
					event: "projector",
					phase: cut === "post-placement" ? "initial" : "recovery",
					classification,
				},
			]);
			const apply = combined.filter(
				(event) => event.event === "action" && (event.info as { kind?: string }).kind === "apply_deferred_writes",
			);
			expect(apply).toEqual([
				{
					v: VERSION,
					event: "action",
					info: {
						kind: "apply_deferred_writes",
						operationId: accepted.operationId,
						entryIds: [admitted.writeEntryId],
					},
				},
			]);
			const opening = recovery.events[0];
			exact(opening, "opening", ["firstAction", "snapshot", "effects"]);
			expect(opening.effects).toEqual({ modelLeases: 0, providerStarts: 0, toolStarts: 0, projectors: 0 });
			expect(opening.firstAction).toEqual(
				cut === "pre-placement"
					? { kind: "apply_deferred_writes", operationId: accepted.operationId, entryIds: [admitted.writeEntryId] }
					: {
							kind: "start_assistant_step",
							operationId: accepted.operationId,
							triggerEntryId: classification === "projecting" ? admitted.writeEntryId : accepted.promptEntryId,
						},
			);
			const openingRows = opening.snapshot as Rows;
			assertSnapshot(
				openingRows,
				accepted,
				admitted.writeEntryId as string,
				classification,
				cut === "post-placement",
				true,
				false,
			);
			const abort = recovery.events.find((event) => event.event === "abort")!;
			exact(abort, "abort", ["result"]);
			expect(abort.result).toEqual({ operationId: accepted.operationId, drainedSteer: [], drainedFollowUp: [] });
			const finish = recovery.events.find(
				(event) => event.event === "action" && (event.info as { kind?: string }).kind === "finish_aborted_run",
			)!;
			expect(finish.info).toEqual({ kind: "finish_aborted_run", operationId: accepted.operationId });
			const terminal = recovery.events.at(-2)!;
			exact(terminal, "terminal", [
				"snapshot",
				"idleSnapshot",
				"idleAction",
				"idleActionAfterRun",
				"recoveryEffects",
				"idleEffects",
			]);
			expect(terminal).toMatchObject({ idleAction: null, idleActionAfterRun: null });
			expect(terminal.idleSnapshot).toEqual(terminal.snapshot);
			expect(terminal.recoveryEffects).toEqual({
				modelLeases: 0,
				providerStarts: 0,
				toolStarts: 0,
				projectors: cut === "pre-placement" ? 1 : 0,
			});
			expect(terminal.idleEffects).toEqual({ modelLeases: 0, providerStarts: 0, toolStarts: 0, projectors: 0 });
			assertSnapshot(
				terminal.snapshot as Rows,
				accepted,
				admitted.writeEntryId as string,
				classification,
				true,
				false,
				cut === "pre-placement",
			);
			expect(recovery.events.at(-1)).toEqual({ v: VERSION, event: "complete" });
			const ids = [
				(accepted.metadata as { id: string }).id,
				accepted.operationId,
				accepted.promptEntryId,
				admitted.writeEntryId,
			] as string[];
			expect(ids.every(isUuidV7)).toBe(true);
			expect(new Set(ids).size).toBe(4);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

type Row = Record<string, unknown>;
type Rows = Record<string, Row[]>;
function assertSnapshot(
	rows: Rows,
	accepted: Record<string, unknown>,
	writeId: string,
	classification: Classification,
	placed: boolean,
	opening: boolean,
	placedAtRecovery: boolean,
) {
	const sessionId = (accepted.metadata as { id: string }).id,
		operationId = accepted.operationId as string,
		promptId = accepted.promptEntryId as string;
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
	expect(rows.sequences).toEqual([{ session_id: sessionId, next_seq: placed ? (opening ? 15 : 20) : 11 }]);
	expect(rows.stats).toEqual([{ session_id: sessionId, message_count: 1, usage_payload: JSON.stringify(ZERO_USAGE) }]);
	expect(rows.usage).toEqual([]);
	const custom = {
		session_id: sessionId,
		id: writeId,
		seq: 11,
		parent_id: promptId,
		timestamp: placedAtRecovery ? RECOVERY_TIME : INITIAL_TIME,
		type: "custom",
		custom_type: classification,
		payload: classification === "projecting" ? "null" : null,
	};
	expect(rows.entries).toEqual([
		{
			session_id: sessionId,
			id: promptId,
			seq: 4,
			parent_id: null,
			timestamp: INITIAL_TIME,
			type: "message",
			custom_type: null,
			payload: JSON.stringify(prompt),
		},
		...(placed ? [custom] : []),
	]);
	expect(rows.branches).toEqual([
		{
			session_id: sessionId,
			branch_id: `segment:${promptId}`,
			tip_entry_id: placed ? writeId : promptId,
			tip_seq: placed ? 11 : 4,
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
			entry_type: entry.type,
		})),
	);
	const regs = new Map(rows.registers.map((row) => [`${row.namespace}/${row.key}`, row]));
	if (opening) {
		expect([...regs.keys()].sort()).toEqual(
			[
				"lane.config/main",
				"lane.leaf/main",
				"lane.state/main",
				`op.meta/${operationId}`,
				`op.state/${operationId}`,
				...(placed ? [] : [`pending.entry/${writeId}`]),
			].sort(),
		);
		expect(Object.fromEntries([...regs].map(([key, row]) => [key, row.seq]))).toEqual({
			"lane.leaf/main": placed ? 13 : 5,
			"lane.state/main": 8,
			"lane.config/main": 3,
			[`op.meta/${operationId}`]: 6,
			[`op.state/${operationId}`]: placed ? 14 : 10,
			...(placed ? {} : { [`pending.entry/${writeId}`]: 9 }),
		});
		expect(JSON.parse(regs.get("lane.config/main")!.value as string)).toEqual(configuration);
		expect(JSON.parse(regs.get("lane.leaf/main")!.value as string)).toBe(placed ? writeId : promptId);
		expect(JSON.parse(regs.get("lane.state/main")!.value as string)).toEqual({
			currentOperationId: operationId,
			pendingNextRun: [],
		});
		expect(rows.writerLeases).toEqual([
			{ session_id: sessionId, owner_id: expect.any(String), fence: 2, expires_at_ms: RECOVERY_TIME + 30_000 },
		]);
		expect(isUuidV7(rows.writerLeases[0].owner_id as string)).toBe(true);
		expect(JSON.parse(regs.get(`op.meta/${operationId}`)!.value as string)).toEqual({
			operationId,
			lane: "main",
			sourceLeafId: null,
			startedAt: INITIAL_TIME,
			intent: { kind: "run", promptEntryIds: [promptId] },
		});
		const operation = JSON.parse(regs.get(`op.state/${operationId}`)!.value as string);
		expect(operation).toMatchObject({
			kind: "run",
			control: { status: "running" },
			inbox: { steer: [], followUp: [], writes: placed ? [] : [writeId] },
			latestAssistantEntryId: null,
		});
		expect(operation.phase).toEqual(
			placed && classification === "projecting"
				? {
						kind: "checkpoint",
						continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
						triggerEntryId: writeId,
						skipInboxOnce: true,
					}
				: {
						kind: "checkpoint",
						continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
						triggerEntryId: promptId,
					},
		);
		if (!placed) {
			const pending = JSON.parse(regs.get(`pending.entry/${writeId}`)!.value as string);
			expect(pending).toEqual(
				classification === "projecting"
					? { type: "custom", customType: classification, payload: null }
					: { type: "custom", customType: classification },
			);
		}
	} else {
		expect(rows.writerLeases).toEqual([]);
		expect([...regs.keys()].sort()).toEqual(
			["lane.config/main", "lane.lastResult/main", "lane.leaf/main", "lane.state/main"].sort(),
		);
		expect(JSON.parse(regs.get("lane.config/main")!.value as string)).toEqual(configuration);
		expect(JSON.parse(regs.get("lane.leaf/main")!.value as string)).toBe(writeId);
		expect(JSON.parse(regs.get("lane.state/main")!.value as string)).toEqual({
			currentOperationId: null,
			pendingNextRun: [],
		});
		expect(JSON.parse(regs.get("lane.lastResult/main")!.value as string)).toEqual({
			operationId,
			kind: "run",
			outcome: "aborted",
			leafId: writeId,
		});
		expect(Object.fromEntries([...regs].map(([key, row]) => [key, row.seq]))).toEqual({
			"lane.config/main": 3,
			"lane.leaf/main": 13,
			"lane.lastResult/main": 18,
			"lane.state/main": 19,
		});
	}
}
