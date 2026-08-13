import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type AssistantMessage, type Context, createModels, type ModelRequestLease, Type } from "@earendil-works/pi-ai";
import { isUuidV7 } from "@nguyenphutrong/pi-session-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import type { ActionInfo } from "../src/planner.ts";
import { SqliteSessionRepo } from "../src/repo.ts";
import { createRuntimeShell, type RuntimeShell, type RuntimeToolDefinition } from "../src/runtime-shell.ts";
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
const totalUsage = { ...firstUsage, input: 10, output: 6, totalTokens: 16 };
const trace = [
	"start_assistant_step",
	"prepare_assistant_effect",
	"dispatch_assistant_effect",
	"await_assistant_effect",
	"settle_assistant_effect",
	"prepare_tool_call",
	"dispatch_tool_effect",
	"await_tool_effect",
	"finalize_tool_effect",
	"settle_tool_effect",
	"start_assistant_step",
	"prepare_assistant_effect",
	"dispatch_assistant_effect",
	"await_assistant_effect",
	"settle_assistant_effect",
	"finish_run",
] as const;

const cases = (["safe", "never"] as const).flatMap((replay) =>
	Array.from({ length: trace.length + 1 }, (_, cut) => ({ replay, cut, boundary: trace[cut] ?? "terminal" })),
);

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
	const directory = await mkdtemp(join(tmpdir(), "harness-sqlite-boundary-"));
	directories.push(directory);
	return join(directory, "sessions.sqlite");
}

interface DurableSnapshot {
	readonly sessions: Record<string, unknown>[];
	readonly sequences: Record<string, unknown>[];
	readonly stats: Record<string, unknown>[];
	readonly entries: Record<string, unknown>[];
	readonly registers: Record<string, unknown>[];
	readonly usage: Record<string, unknown>[];
	readonly branches: Record<string, unknown>[];
	readonly branchEntries: Record<string, unknown>[];
	readonly writerLeases: Record<string, unknown>[];
}

function snapshot(path: string, sessionId: string): DurableSnapshot {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const rows = (sql: string) => db.prepare(sql).all(sessionId) as Record<string, unknown>[];
		return {
			sessions: rows("SELECT * FROM sessions WHERE session_id = ? ORDER BY session_id"),
			sequences: rows("SELECT * FROM session_sequences WHERE session_id = ? ORDER BY session_id"),
			stats: rows("SELECT * FROM session_stats WHERE session_id = ? ORDER BY session_id"),
			entries: rows("SELECT * FROM entries WHERE session_id = ? ORDER BY seq"),
			registers: rows("SELECT * FROM registers WHERE session_id = ? ORDER BY namespace, key"),
			usage: rows("SELECT * FROM usage_ledger WHERE session_id = ? ORDER BY seq"),
			branches: rows("SELECT * FROM branch_meta WHERE session_id = ? ORDER BY branch_id"),
			branchEntries: rows("SELECT * FROM branch_entries WHERE session_id = ? ORDER BY branch_id, entry_seq"),
			writerLeases: rows("SELECT * FROM writer_leases WHERE session_id = ? ORDER BY session_id"),
		};
	} finally {
		db.close();
	}
}

function registerValue(value: DurableSnapshot, namespace: string, key: string): unknown {
	const row = value.registers.find((candidate) => candidate.namespace === namespace && candidate.key === key) as
		| { value: string }
		| undefined;
	return row === undefined ? undefined : JSON.parse(row.value);
}

interface EffectsFixture {
	readonly models: ReturnType<typeof createModels>;
	readonly lease: ReturnType<typeof vi.fn>;
	readonly streamSimple: ReturnType<typeof vi.fn>;
	readonly contexts: Context[];
	readonly execute: ReturnType<typeof vi.fn>;
	readonly tool: RuntimeToolDefinition<object>;
}

function effects(replay: "safe" | "never"): EffectsFixture {
	const contexts: Context[] = [];
	const execute = vi.fn(async (_callId: string, args: { value: string }) => ({
		content: [{ type: "text" as const, text: `echoed: ${args.value}` }],
		details: { durable: true },
	}));
	const models = createModels();
	const streamSimple = vi.fn((context: Context) => {
		contexts.push(structuredClone(context));
		const hasToolResult = context.messages.some((message) => message.role === "toolResult");
		const response = hasToolResult
			? providerMessage([{ type: "text", text: "complete" }], finalUsage)
			: providerMessage(
					[{ type: "toolCall", id: "echo-1", name: "echo", arguments: { value: "durable echo" } }],
					firstUsage,
				);
		return { result: () => Promise.resolve(response) } as ReturnType<ModelRequestLease["streamSimple"]>;
	});
	const lease = vi.spyOn(models, "lease").mockReturnValue({
		model: { provider: "test", id: "current", maxTokens: 4096, contextWindow: 8192 },
		stream: vi.fn(),
		streamSimple,
		fetchDeferred: vi.fn(),
		cancelDeferred: vi.fn(),
	} as unknown as ModelRequestLease);
	const schema = Type.Object({ value: Type.String() }, { additionalProperties: false });
	return {
		models,
		lease,
		streamSimple,
		contexts,
		execute,
		tool: {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: schema,
			replay,
			execute,
		},
	};
}

async function shellFor(session: Session, fixture: EffectsFixture): Promise<RuntimeShell<object>> {
	return createRuntimeShell(session, configuration, {
		models: fixture.models,
		tools: [fixture.tool],
		toolContext: {},
		retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
	});
}

function assertActions(
	actions: ActionInfo[],
	operationId: string,
	promptEntryId: string,
	branch: MessageEntry[],
	cut: number,
): void {
	expect(actions.map(({ kind }) => kind)).toEqual(trace.slice(0, cut));
	expect(actions.every((action) => action.operationId === operationId)).toBe(true);
	const action0 = actions[0];
	if (action0) expect(action0).toEqual({ kind: "start_assistant_step", operationId, triggerEntryId: promptEntryId });
	const action1 = actions[1];
	let firstStepId: string | undefined;
	if (action1) {
		expect(action1.kind).toBe("prepare_assistant_effect");
		if (action1.kind === "prepare_assistant_effect") {
			firstStepId = action1.stepId;
			expect(action1).toEqual({
				kind: "prepare_assistant_effect",
				operationId,
				stepId: firstStepId,
				nextAttempt: 1,
			});
		}
	}
	if (firstStepId) {
		const assistantKey = `assistant:${operationId}:${firstStepId}:1`;
		for (const [index, kind] of trace.slice(2, 5).entries()) {
			const action = actions[index + 2];
			if (action) expect(action).toEqual({ kind, operationId, effectKey: assistantKey });
		}
		const action5 = actions[5];
		if (action5)
			expect(action5).toEqual({
				kind: "prepare_tool_call",
				operationId,
				assistantEntryId: branch[1].id,
				sourceIndex: 0,
				resultEntryId: branch[2].id,
			});
		const toolKey = `tool:${operationId}:${firstStepId}:0`;
		for (const [index, kind] of trace.slice(6, 10).entries()) {
			const action = actions[index + 6];
			if (action) expect(action).toEqual({ kind, operationId, effectKey: toolKey });
		}
	}
	const action10 = actions[10];
	if (action10) expect(action10).toEqual({ kind: "start_assistant_step", operationId, triggerEntryId: branch[2].id });
	const action11 = actions[11];
	let secondStepId: string | undefined;
	if (action11) {
		expect(action11.kind).toBe("prepare_assistant_effect");
		if (action11.kind === "prepare_assistant_effect") {
			secondStepId = action11.stepId;
			expect(action11).toEqual({
				kind: "prepare_assistant_effect",
				operationId,
				stepId: secondStepId,
				nextAttempt: 1,
			});
			expect(secondStepId).not.toBe(firstStepId);
		}
	}
	if (secondStepId) {
		const assistantKey = `assistant:${operationId}:${secondStepId}:1`;
		for (const [index, kind] of trace.slice(12, 15).entries()) {
			const action = actions[index + 12];
			if (action) expect(action).toEqual({ kind, operationId, effectKey: assistantKey });
		}
	}
	const action15 = actions[15];
	if (action15) expect(action15).toEqual({ kind: "finish_run", operationId, triggerEntryId: branch[3].id });
}

async function closeOwners(
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

async function assertTerminal(
	session: Session,
	fixture: EffectsFixture,
	expected: { providerCalls: number; providerToolResultCalls: number; toolCalls: number; interrupted: boolean },
	cut: number,
): Promise<MessageEntry[]> {
	const branch = messageEntries(await session.findEntriesOnBranch({ order: "oldestFirst" }));
	expect(branch).toHaveLength(4);
	expect(branch.map(({ message }) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	expect(new Set(branch.map(({ id }) => id)).size).toBe(4);
	expect(branch.map(({ parentId }) => parentId)).toEqual([null, ...branch.slice(0, -1).map(({ id }) => id)]);
	expect(branch.every((entry, index) => index === 0 || entry.seq > branch[index - 1].seq)).toBe(true);
	expect(await session.getLeafId()).toBe(branch[3].id);
	expect(branch[0].message).toEqual(user("run echo"));
	expect(branch[1].message).toEqual(
		providerMessage(
			[{ type: "toolCall", id: "echo-1", name: "echo", arguments: { value: "durable echo" } }],
			firstUsage,
		),
	);
	const expectedTool = expected.interrupted
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
			};
	expect(branch[2].message).toEqual(expectedTool);
	expect(branch[2].message).not.toHaveProperty("usage");
	expect(branch[3].message).toEqual(providerMessage([{ type: "text", text: "complete" }], finalUsage));
	expect(fixture.streamSimple).toHaveBeenCalledTimes(expected.providerCalls);
	expect(fixture.contexts.filter(({ messages }) => messages.some(({ role }) => role === "toolResult"))).toHaveLength(
		expected.providerToolResultCalls,
	);
	const initialContext = [branch[0].message];
	const toolResultContext = branch.slice(0, 3).map(({ message }) => message);
	expect(fixture.contexts.map(({ messages }) => messages)).toEqual(
		[3, 4].includes(cut)
			? [initialContext, initialContext, toolResultContext]
			: [13, 14].includes(cut)
				? [initialContext, toolResultContext, toolResultContext]
				: [initialContext, toolResultContext],
	);
	expect(fixture.execute).toHaveBeenCalledTimes(expected.toolCalls);
	expect(await session.getStats()).toEqual({ messageCount: 4, usage: totalUsage });
	return branch;
}

describe("SQLite RuntimeShell commit boundaries", () => {
	it.each(cases)("replay=$replay cut=$cut boundary=$boundary", async ({ replay, cut }) => {
		const path = await databasePath();
		const fixture = effects(replay);
		const initialRepo = new SqliteSessionRepo({ path });
		let initialSession: Session | undefined;
		let initialShell: RuntimeShell<object> | undefined;
		let metadata: SessionMetadata | undefined;
		let operationId = "";
		let promptEntryId = "";
		const actions: ActionInfo[] = [];
		try {
			initialSession = await initialRepo.create();
			metadata = initialSession.metadata;
			initialShell = await shellFor(initialSession, fixture);
			const attachment = await initialShell.prompt(user("run echo"));
			operationId = attachment.runOperation!.value.operationId;
			promptEntryId = attachment.runOperation!.value.intent.promptEntryIds[0];
			for (let index = 0; index < cut; index++) {
				const peeked = await initialShell.peekAction();
				expect(peeked).toBeDefined();
				const executed = await initialShell.executeAction();
				expect(executed).toEqual(peeked);
				actions.push(executed!);
			}
		} finally {
			await closeOwners(initialShell, initialSession, initialRepo);
		}

		const recoveryRepo = new SqliteSessionRepo({ path });
		let recoverySession: Session | undefined;
		let recoveryShell: RuntimeShell<object> | undefined;
		let branch: MessageEntry[] = [];
		try {
			recoverySession = await recoveryRepo.open(metadata!);
			recoveryShell = await shellFor(recoverySession, fixture);
			await recoveryShell.runToCompletion();
			const uncertainAssistant = [3, 4, 13, 14].includes(cut);
			const pendingTool = [6, 7, 8, 9].includes(cut);
			const replayedSafe = [7, 8, 9].includes(cut);
			branch = await assertTerminal(
				recoverySession,
				fixture,
				{
					providerCalls: uncertainAssistant ? 3 : 2,
					providerToolResultCalls: [13, 14].includes(cut) ? 2 : 1,
					toolCalls: replay === "never" && cut === 6 ? 0 : replay === "safe" && replayedSafe ? 2 : 1,
					interrupted: replay === "never" && pendingTool,
				},
				cut,
			);
			assertActions(actions, operationId, promptEntryId, branch, cut);
		} finally {
			await closeOwners(recoveryShell, recoverySession, recoveryRepo);
		}

		const terminal = snapshot(path, metadata!.id);
		expect(terminal.entries).toHaveLength(4);
		expect(terminal.usage).toHaveLength(2);
		expect(terminal.writerLeases).toEqual([]);
		const usageRows = terminal.usage as Array<{
			session_id: string;
			id: unknown;
			seq: unknown;
			entry_id: string;
			usage: string;
			adjustment: number;
			details: string | null;
		}>;
		expect(usageRows.every(({ session_id }) => session_id === metadata!.id)).toBe(true);
		expect(usageRows.every(({ id }) => typeof id === "string" && isUuidV7(id))).toBe(true);
		const usageIds = usageRows.map(({ id }) => id as string);
		expect(new Set(usageIds).size).toBe(usageIds.length);
		expect(usageIds.every((id) => !branch.some((entry) => entry.id === id))).toBe(true);
		expect(
			usageRows.map(({ seq, entry_id, usage, adjustment, details }) => ({
				seq,
				entryId: entry_id,
				usage: JSON.parse(usage),
				adjustment,
				details,
			})),
		).toEqual([
			{ seq: branch[1].seq + 2, entryId: branch[1].id, usage: firstUsage, adjustment: 0, details: null },
			{ seq: branch[3].seq + 2, entryId: branch[3].id, usage: finalUsage, adjustment: 0, details: null },
		]);
		expect(registerValue(terminal, "lane.lastResult", "main")).toEqual({
			operationId,
			kind: "run",
			outcome: "completed",
			leafId: branch[3].id,
			finalAssistantEntryId: branch[3].id,
			runCompletion: "assistant",
		});
		expect(registerValue(terminal, "lane.state", "main")).toEqual({ currentOperationId: null, pendingNextRun: [] });
		expect(terminal.registers.filter((row) => (row.namespace as string).startsWith("op."))).toEqual([]);
		expect(terminal.registers.filter((row) => row.namespace === "pending.entry")).toEqual([]);
		expect(terminal.stats).toEqual([
			expect.objectContaining({ message_count: 4, usage_payload: JSON.stringify(totalUsage) }),
		]);

		const idleFixture = effects(replay);
		const idleRepo = new SqliteSessionRepo({ path });
		let idleSession: Session | undefined;
		let idleShell: RuntimeShell<object> | undefined;
		try {
			idleSession = await idleRepo.open(metadata!);
			idleShell = await shellFor(idleSession, idleFixture);
			expect(await idleShell.peekAction()).toBeUndefined();
			await idleShell.runToCompletion();
			expect(await idleShell.peekAction()).toBeUndefined();
			expect(idleFixture.lease).not.toHaveBeenCalled();
			expect(idleFixture.streamSimple).not.toHaveBeenCalled();
			expect(idleFixture.execute).not.toHaveBeenCalled();
			expect(await idleSession.findEntriesOnBranch({ order: "oldestFirst" })).toEqual(branch);
			expect(await idleSession.getStats()).toEqual({ messageCount: 4, usage: totalUsage });
		} finally {
			await closeOwners(idleShell, idleSession, idleRepo);
		}
		expect(snapshot(path, metadata!.id)).toEqual(terminal);
	});
});
