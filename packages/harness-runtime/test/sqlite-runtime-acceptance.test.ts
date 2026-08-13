import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type AssistantMessage, type Context, createModels, type ModelRequestLease, Type } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import type { ActionInfo } from "../src/planner.ts";
import { SqliteSessionRepo } from "../src/repo.ts";
import { attachRuntime } from "../src/runtime-port.ts";
import { createRuntimeShell, type RuntimeToolDefinition } from "../src/runtime-shell.ts";
import type { Entry, MessageEntry, Session, SessionMetadata } from "../src/types.ts";
import { user, ZERO_USAGE } from "./fixtures.ts";

const directories: string[] = [];

function messageEntries(entries: Entry[]): MessageEntry[] {
	if (!entries.every((entry) => entry.type === "message")) throw new Error("Expected only message entries");
	return entries;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "current" },
	thinkingLevel: "medium",
	activeToolNames: ["echo"],
};
const firstUsage = { ...ZERO_USAGE, input: 3, output: 2, totalTokens: 5 };
const finalUsage = { ...ZERO_USAGE, input: 7, output: 4, totalTokens: 11 };
const noToolUsage = { ...ZERO_USAGE, input: 5, output: 3, totalTokens: 8 };
const noToolTrace = [
	"start_assistant_step",
	"prepare_assistant_effect",
	"dispatch_assistant_effect",
	"await_assistant_effect",
	"settle_assistant_effect",
	"finish_run",
] as const;
const toolTrace = [
	...noToolTrace.slice(0, 5),
	"prepare_tool_call",
	"dispatch_tool_effect",
	"await_tool_effect",
	"finalize_tool_effect",
	"settle_tool_effect",
	...noToolTrace,
] as const;

function providerMessage(content: AssistantMessage["content"], usage: AssistantMessage["usage"]): AssistantMessage {
	const toolUse = content.some((part) => part.type === "toolCall");
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "test",
		model: "current",
		responseId: toolUse ? "tool-response" : "final-response",
		usage,
		stopReason: toolUse ? "toolUse" : "stop",
		timestamp: 10,
	};
}

async function databasePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "harness-sqlite-runtime-"));
	directories.push(directory);
	return join(directory, "sessions.sqlite");
}

interface DurableEvidence {
	readonly nextSeq: number;
	readonly entryCount: number;
	readonly registerCount: number;
	readonly usageCount: number;
	readonly rows: Record<string, unknown[]>;
}

function evidence(path: string, sessionId: string): DurableEvidence {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const next = db.prepare("SELECT next_seq FROM session_sequences WHERE session_id = ?").get(sessionId) as {
			next_seq: number;
		};
		const count = (table: string) =>
			(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(sessionId) as { count: number })
				.count;
		return {
			nextSeq: next.next_seq,
			entryCount: count("entries"),
			registerCount: count("registers"),
			usageCount: count("usage_ledger"),
			rows: {
				entries: db.prepare("SELECT * FROM entries WHERE session_id = ? ORDER BY seq").all(sessionId),
				registers: db
					.prepare("SELECT * FROM registers WHERE session_id = ? ORDER BY namespace, key")
					.all(sessionId),
				usage: db.prepare("SELECT * FROM usage_ledger WHERE session_id = ? ORDER BY seq").all(sessionId),
				stats: db.prepare("SELECT * FROM session_stats WHERE session_id = ?").all(sessionId),
				branches: db.prepare("SELECT * FROM branch_meta WHERE session_id = ? ORDER BY branch_id").all(sessionId),
				branchEntries: db
					.prepare("SELECT * FROM branch_entries WHERE session_id = ? ORDER BY branch_id, entry_seq")
					.all(sessionId),
			},
		};
	} finally {
		db.close();
	}
}

function registerValue(snapshot: DurableEvidence, namespace: string, key: string): unknown {
	const row = snapshot.rows.registers.find(
		(candidate) =>
			(candidate as { namespace: string }).namespace === namespace && (candidate as { key: string }).key === key,
	) as { value: string } | undefined;
	return row === undefined ? undefined : JSON.parse(row.value);
}

async function freshLifecycle(
	path: string,
	metadata: SessionMetadata,
	terminalLeaf: string,
	terminalSnapshot: DurableEvidence,
): Promise<void> {
	const inspectionRepo = new SqliteSessionRepo({ path });
	let inspection: Session | undefined;
	try {
		inspection = await inspectionRepo.open(metadata);
		expect(inspection.metadata).toEqual(metadata);
		const attached = await attachRuntime(inspection, configuration);
		expect(attached.laneConfiguration.value).toEqual(configuration);
		expect(attached.laneState.value).toEqual({ currentOperationId: null, pendingNextRun: [] });
		expect(attached.mainLeaf.value).toBe(terminalLeaf);
		expect(attached.runOperation).toBeUndefined();
		expect(attached.runState).toBeUndefined();
		expect([...attached.toolArguments]).toEqual([]);
		expect([...attached.usageRows]).toEqual([]);
		expect([...attached.entries.keys()]).toEqual([terminalLeaf]);
		expect(attached.entries.get(terminalLeaf)).toMatchObject({ id: terminalLeaf, message: { role: "assistant" } });
	} finally {
		await inspection?.close();
		await inspectionRepo.close();
	}
	const afterAttachment = evidence(path, metadata.id);
	expect(afterAttachment).toEqual(terminalSnapshot);

	const idleRepo = new SqliteSessionRepo({ path });
	let idleSession: Session | undefined;
	let idleShell: Awaited<ReturnType<typeof createRuntimeShell>> | undefined;
	const models = createModels();
	const lease = vi.spyOn(models, "lease");
	const execute = vi.fn();
	try {
		idleSession = await idleRepo.open(metadata);
		expect(idleSession.metadata).toEqual(metadata);
		idleShell = await createRuntimeShell(idleSession, configuration, {
			models,
			tools: [
				{
					name: "echo",
					label: "Echo",
					description: "echo",
					parameters: Type.Object({ value: Type.String() }),
					execute,
				},
			],
		});
		expect(await idleShell.peekAction()).toBeUndefined();
		await idleShell.runToCompletion();
		expect(await idleShell.peekAction()).toBeUndefined();
		expect(lease).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(await idleSession.getLeafId()).toBe(terminalLeaf);
		const stats = terminalSnapshot.rows.stats[0] as { message_count: number; usage_payload: string };
		expect(await idleSession.getStats()).toEqual({
			messageCount: stats.message_count,
			usage: JSON.parse(stats.usage_payload),
		});
	} finally {
		await idleShell?.close();
		if (!idleShell) await idleSession?.close();
		await idleRepo.close();
	}
	expect(evidence(path, metadata.id)).toEqual(terminalSnapshot);
}

async function runScenario(withTool: boolean): Promise<void> {
	const path = await databasePath();
	const repo = new SqliteSessionRepo({ path });
	let session: Session | undefined;
	let shell: Awaited<ReturnType<typeof createRuntimeShell>> | undefined;
	const providerContexts: Context[] = [];
	const execute = vi.fn(async (_callId: string, args: { value: string }) => ({
		content: [{ type: "text" as const, text: `echoed: ${args.value}` }],
		details: { durable: true },
	}));
	const models = createModels();
	const streamSimple = vi.fn((context: Context) => {
		providerContexts.push(structuredClone(context));
		const hasToolResult = context.messages.some((message) => message.role === "toolResult");
		const response =
			withTool && !hasToolResult
				? providerMessage(
						[{ type: "toolCall", id: "echo-1", name: "echo", arguments: { value: "durable echo" } }],
						firstUsage,
					)
				: providerMessage([{ type: "text", text: "complete" }], withTool ? finalUsage : noToolUsage);
		return { result: () => Promise.resolve(response) } as ReturnType<ModelRequestLease["streamSimple"]>;
	});
	vi.spyOn(models, "lease").mockReturnValue({
		model: { provider: "test", id: "current", maxTokens: 4096, contextWindow: 8192 },
		stream: vi.fn(),
		streamSimple,
		fetchDeferred: vi.fn(),
		cancelDeferred: vi.fn(),
	} as unknown as ModelRequestLease);
	const schema = Type.Object({ value: Type.String() }, { additionalProperties: false });
	const tool: RuntimeToolDefinition<object, typeof schema> = {
		name: "echo",
		label: "Echo",
		description: "echo",
		parameters: schema,
		replay: "safe",
		execute,
	};
	let metadata: SessionMetadata;
	let terminalLeaf = "";
	let operationId = "";
	try {
		session = await repo.create();
		metadata = session.metadata;
		shell = await createRuntimeShell(session, configuration, {
			models,
			tools: [tool],
			toolContext: {},
			retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		const promptAttachment = await shell.prompt(user(withTool ? "run echo" : "answer"));
		const promptEntryId = promptAttachment.runOperation!.value.intent.promptEntryIds[0];
		operationId = promptAttachment.runOperation!.value.operationId;
		const actions: ActionInfo[] = [];
		for (let action = await shell.peekAction(); action; action = await shell.peekAction()) {
			actions.push(action);
			const result = await shell.executeAction();
			expect(result).toEqual(action);
		}
		expect(actions.map(({ kind }) => kind)).toEqual(withTool ? toolTrace : noToolTrace);
		expect(actions.every((action) => action.operationId === operationId)).toBe(true);
		terminalLeaf = (await session.getLeafId())!;
		const branch = messageEntries(await session.findEntriesOnBranch({ order: "oldestFirst" }));
		const firstStep = actions[1] as Extract<ActionInfo, { kind: "prepare_assistant_effect" }>;
		expect(actions[0]).toEqual({ kind: "start_assistant_step", operationId, triggerEntryId: promptEntryId });
		expect(firstStep).toEqual({
			kind: "prepare_assistant_effect",
			operationId,
			stepId: firstStep.stepId,
			nextAttempt: 1,
		});
		expect(actions.slice(2, 5).map((action) => (action as { effectKey: string }).effectKey)).toEqual(
			Array(3).fill(`assistant:${operationId}:${firstStep.stepId}:1`),
		);
		expect(branch.map(({ message }) => message.role)).toEqual(
			withTool ? ["user", "assistant", "toolResult", "assistant"] : ["user", "assistant"],
		);
		expect(branch.map(({ parentId }) => parentId)).toEqual([null, ...branch.slice(0, -1).map(({ id }) => id)]);
		expect(new Set(branch.map(({ id }) => id)).size).toBe(branch.length);
		expect(branch.every((entry, index) => index === 0 || entry.seq > branch[index - 1].seq)).toBe(true);
		expect(branch.at(-1)?.id).toBe(terminalLeaf);
		expect(branch[0].message).toEqual(user(withTool ? "run echo" : "answer"));
		if (withTool) {
			expect(branch[1].message).toEqual(
				providerMessage(
					[{ type: "toolCall", id: "echo-1", name: "echo", arguments: { value: "durable echo" } }],
					firstUsage,
				),
			);
			expect(branch[2].message).toEqual({
				role: "toolResult",
				toolCallId: "echo-1",
				toolName: "echo",
				content: [{ type: "text", text: "echoed: durable echo" }],
				details: { durable: true },
				isError: false,
				timestamp: expect.any(Number),
			});
			expect(branch[3].message).toEqual(providerMessage([{ type: "text", text: "complete" }], finalUsage));
			const prepareTool = actions[5] as Extract<ActionInfo, { kind: "prepare_tool_call" }>;
			expect(prepareTool).toEqual({
				kind: "prepare_tool_call",
				operationId,
				assistantEntryId: branch[1].id,
				sourceIndex: 0,
				resultEntryId: branch[2].id,
			});
			expect(actions.slice(6, 10).map((action) => (action as { effectKey: string }).effectKey)).toEqual(
				Array(4).fill(`tool:${operationId}:${firstStep.stepId}:0`),
			);
			expect(actions[10]).toEqual({ kind: "start_assistant_step", operationId, triggerEntryId: branch[2].id });
			const secondStep = actions[11] as Extract<ActionInfo, { kind: "prepare_assistant_effect" }>;
			expect(secondStep).toEqual({
				kind: "prepare_assistant_effect",
				operationId,
				stepId: secondStep.stepId,
				nextAttempt: 1,
			});
			expect(secondStep.stepId).not.toBe(firstStep.stepId);
			expect(actions.slice(12, 15).map((action) => (action as { effectKey: string }).effectKey)).toEqual(
				Array(3).fill(`assistant:${operationId}:${secondStep.stepId}:1`),
			);
			expect(actions[15]).toEqual({ kind: "finish_run", operationId, triggerEntryId: terminalLeaf });
		} else {
			expect(branch[1].message).toEqual(providerMessage([{ type: "text", text: "complete" }], noToolUsage));
			expect(actions[5]).toEqual({ kind: "finish_run", operationId, triggerEntryId: terminalLeaf });
		}
		expect(streamSimple).toHaveBeenCalledTimes(withTool ? 2 : 1);
		expect(execute).toHaveBeenCalledTimes(withTool ? 1 : 0);
		expect(providerContexts).toHaveLength(withTool ? 2 : 1);
		if (withTool) expect(providerContexts[1].messages).toContainEqual(branch[2].message);
		expect(await session.getStats()).toEqual({
			messageCount: withTool ? 4 : 2,
			usage: withTool ? { ...firstUsage, input: 10, output: 6, totalTokens: 16 } : noToolUsage,
		});
	} finally {
		await shell?.close();
		if (!shell) await session?.close();
		await repo.close();
	}
	const snapshot = evidence(path, metadata!.id);
	expect(snapshot.entryCount).toBe(withTool ? 4 : 2);
	expect(snapshot.usageCount).toBe(withTool ? 2 : 1);
	const usageRows = snapshot.rows.usage as Array<{
		id: string;
		entry_id: string;
		usage: string;
		adjustment: number;
		details: string | null;
	}>;
	expect(new Set(usageRows.map(({ id }) => id)).size).toBe(usageRows.length);
	expect(
		usageRows.map(({ entry_id, usage, adjustment, details }) => ({
			entryId: entry_id,
			usage: JSON.parse(usage),
			adjustment,
			details,
		})),
	).toEqual(
		withTool
			? [
					{
						entryId: (snapshot.rows.entries[1] as { id: string }).id,
						usage: firstUsage,
						adjustment: 0,
						details: null,
					},
					{ entryId: terminalLeaf, usage: finalUsage, adjustment: 0, details: null },
				]
			: [{ entryId: terminalLeaf, usage: noToolUsage, adjustment: 0, details: null }],
	);
	expect(registerValue(snapshot, "lane.lastResult", "main")).toEqual({
		operationId,
		kind: "run",
		outcome: "completed",
		leafId: terminalLeaf,
		finalAssistantEntryId: terminalLeaf,
		runCompletion: "assistant",
	});
	expect(registerValue(snapshot, "lane.state", "main")).toEqual({ currentOperationId: null, pendingNextRun: [] });
	expect(snapshot.rows.registers).not.toContainEqual(
		expect.objectContaining({ namespace: "op.meta", key: operationId }),
	);
	expect(snapshot.rows.registers).not.toContainEqual(
		expect.objectContaining({ namespace: "op.state", key: operationId }),
	);
	expect(
		snapshot.rows.registers.filter(
			(row) =>
				(row as { namespace: string }).namespace === "op.tool_args" &&
				(row as { key: string }).key.startsWith(`${operationId}:`),
		),
	).toEqual([]);
	await freshLifecycle(path, metadata!, terminalLeaf, snapshot);
}

describe("SQLite RuntimeShell acceptance", () => {
	it("restores a terminal no-tool run without effects or writes", async () => {
		await runScenario(false);
	});

	it("restores a terminal sequential-tool run without effects or writes", async () => {
		await runScenario(true);
	});
});
