import { type AssistantMessage, type Context, createModels, type ModelRequestLease, Type } from "@earendil-works/pi-ai";
import { MemoryStorageState, type Storage, type Transaction } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it, vi } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import { createRuntimeShell, type RuntimeShell, type RuntimeToolDefinition } from "../src/runtime-shell.ts";
import { StoredSession } from "../src/session.ts";
import { CURRENT_STORAGE_VERSION } from "../src/types.ts";
import { id, user, ZERO_USAGE } from "./fixtures.ts";

const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "current" },
	thinkingLevel: "medium",
	activeToolNames: ["echo"],
};

const firstUsage = { ...ZERO_USAGE, input: 3, output: 2, totalTokens: 5 };
const finalUsage = { ...ZERO_USAGE, input: 7, output: 4, totalTokens: 11 };

function providerMessage(content: AssistantMessage["content"], usage: AssistantMessage["usage"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "test",
		model: "current",
		responseId: content.some((part) => part.type === "toolCall") ? "tool-response" : "final-response",
		usage,
		stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 10,
	};
}

function session(storage: Storage): StoredSession {
	return new StoredSession(
		{ id: id(), createdAt: 1, storageVersion: CURRENT_STORAGE_VERSION },
		storage,
		() => undefined,
	);
}

interface Scenario {
	readonly state: MemoryStorageState;
	readonly providerContexts: unknown[];
	readonly execute: ReturnType<typeof vi.fn>;
	readonly transactions: Transaction[];
	readonly open: () => Promise<RuntimeShell<{ source: string }>>;
}

function scenario(replay: "safe" | "never"): Scenario {
	const state = new MemoryStorageState();
	const transactions: Transaction[] = [];
	const providerContexts: unknown[] = [];
	const execute = vi.fn(async (_callId: string, args: { value: string }) => ({
		content: [{ type: "text" as const, text: `echoed: ${args.value}` }],
		details: { durable: true },
	}));
	const schema = Type.Object({ value: Type.String() }, { additionalProperties: false });
	const tool: RuntimeToolDefinition<{ source: string }, typeof schema> = {
		name: "echo",
		label: "Echo",
		description: "echo",
		parameters: schema,
		replay,
		execute,
	};
	return {
		state,
		providerContexts,
		execute,
		transactions,
		open: async () => {
			const storage = state.createStorage();
			const commit = storage.commit.bind(storage);
			storage.commit = async (transaction) => {
				const result = await commit(transaction);
				transactions.push(structuredClone(transaction));
				return result;
			};
			if (!(await storage.getRegister("lane.state", "main"))) {
				await storage.commit({
					writes: [
						{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
						{
							kind: "register",
							op: "set",
							namespace: "lane.state",
							key: "main",
							value: { currentOperationId: null, pendingNextRun: [] },
						},
					],
				});
			}
			const models = createModels();
			const lease = {
				model: { provider: "test", id: "current", maxTokens: 4096, contextWindow: 8192 },
				stream: vi.fn(),
				streamSimple: vi.fn((context: Context) => {
					providerContexts.push(structuredClone(context));
					const hasToolResult = context.messages.some((message) => message.role === "toolResult");
					const response = hasToolResult
						? providerMessage([{ type: "text", text: "complete" }], finalUsage)
						: providerMessage(
								[{ type: "toolCall", id: "echo-1", name: "echo", arguments: { value: "durable echo" } }],
								firstUsage,
							);
					return { result: () => Promise.resolve(response) } as ReturnType<ModelRequestLease["streamSimple"]>;
				}),
				fetchDeferred: vi.fn(),
				cancelDeferred: vi.fn(),
			} as unknown as ModelRequestLease;
			vi.spyOn(models, "lease").mockReturnValue(lease);
			return createRuntimeShell(session(storage), configuration, {
				models,
				tools: [tool],
				toolContext: { source: "acceptance" },
				retryPolicy: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			});
		},
	};
}

async function assertTerminal(
	test: Scenario,
	expected: { providerCalls: number; providerToolResultCalls: number; toolCalls: number; interruptedTool: boolean },
): Promise<void> {
	const storage = test.state.createStorage();
	const leaf = await storage.getRegister("lane.leaf", "main");
	expect(leaf?.value).toEqual(expect.any(String));
	const branch = await storage.scanBranch({ start: leaf?.value as string, order: "oldestFirst" });
	const messages = branch.map((entry) => entry.payload as { role: string; content: unknown });
	expect(messages.map(({ role }) => role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
	if (expected.interruptedTool) {
		expect(messages[2]).toMatchObject({ role: "toolResult", isError: true });
	} else {
		expect(messages[2]).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "echoed: durable echo" }],
			details: { durable: true },
			isError: false,
		});
	}
	expect(messages[3]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "complete" }] });
	expect(test.providerContexts).toHaveLength(expected.providerCalls);
	const contextsWithToolResult = test.providerContexts.filter((context) =>
		(context as { messages: Array<{ role: string }> }).messages.some((message) => message.role === "toolResult"),
	);
	expect(contextsWithToolResult).toHaveLength(expected.providerToolResultCalls);
	for (const context of contextsWithToolResult)
		expect(context).toMatchObject({ messages: expect.arrayContaining([messages[2]]) });
	expect(test.execute).toHaveBeenCalledTimes(expected.toolCalls);
	const stats = await storage.getStats();
	expect(stats.usage).toEqual({ ...firstUsage, input: 10, output: 6, totalTokens: 16 });
	const lastResult = await storage.getRegister("lane.lastResult", "main");
	expect(lastResult).toMatchObject({
		value: { kind: "run", outcome: "completed", leafId: leaf?.value, finalAssistantEntryId: leaf?.value },
	});
	const operationId = (lastResult?.value as { operationId: string }).operationId;
	expect(await storage.getRegister("op.meta", operationId)).toBeUndefined();
	expect(await storage.getRegister("op.state", operationId)).toBeUndefined();
	expect((await storage.listRegisters("op.tool_args")).filter(({ key }) => key.startsWith(`${operationId}:`))).toEqual(
		[],
	);
	expect(await storage.getRegister("lane.state", "main")).toMatchObject({
		value: { currentOperationId: null, pendingNextRun: [] },
	});
	const writes = test.transactions.flatMap(({ writes }) => writes);
	const entryIds = writes.flatMap((write) => (write.kind === "entry" ? [write.entry.id] : []));
	const usageIds = writes.flatMap((write) => (write.kind === "usage" ? [write.row.id] : []));
	expect(new Set(entryIds).size).toBe(entryIds.length);
	expect(new Set(usageIds).size).toBe(usageIds.length);
	expect(
		writes.filter(
			(write) => write.kind === "register" && write.namespace === "lane.lastResult" && write.key === "main",
		),
	).toHaveLength(1);
	const reopened = await test.open();
	expect(await reopened.peekAction()).toBeUndefined();
	await reopened.runToCompletion();
	expect(await reopened.peekAction()).toBeUndefined();
	await reopened.close();
}

const expectedActions = [
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

async function traceActions(replay: "safe" | "never"): Promise<string[]> {
	const test = scenario(replay);
	const shell = await test.open();
	await shell.prompt(user("run echo"));
	const actions: string[] = [];
	for (let action = await shell.peekAction(); action; action = await shell.peekAction()) {
		actions.push(action.kind);
		await shell.executeAction();
	}
	await shell.close();
	return actions;
}

describe("Phase 2 composed acceptance", () => {
	it.each(["safe", "never"] as const)(
		"drives an uninterrupted %s tool turn through every interpreter stage",
		async (replay) => {
			expect(await traceActions(replay)).toEqual(expectedActions);
			const test = scenario(replay);
			const shell = await test.open();
			await shell.prompt(user("run echo"));
			await shell.runToCompletion();
			await shell.close();
			await assertTerminal(test, {
				providerCalls: 2,
				providerToolResultCalls: 1,
				toolCalls: 1,
				interruptedTool: false,
			});
		},
	);

	it.each(["safe", "never"] as const)(
		"reopens %s replay after every action boundary and converges",
		async (replay) => {
			const actions = await traceActions(replay);
			expect(actions).toEqual(expectedActions);
			for (let cut = 0; cut <= actions.length; cut++) {
				const test = scenario(replay);
				let shell = await test.open();
				await shell.prompt(user("run echo"));
				for (let action = 0; action < cut; action++) await shell.executeAction();
				await shell.close();
				shell = await test.open();
				await shell.runToCompletion();
				await shell.close();
				const uncertainAssistant = [3, 4, 13, 14].includes(cut);
				const pendingTool = [6, 7, 8, 9].includes(cut);
				const replayedSafeTool = [7, 8, 9].includes(cut);
				await assertTerminal(test, {
					providerCalls: uncertainAssistant ? 3 : 2,
					providerToolResultCalls: [13, 14].includes(cut) ? 2 : 1,
					toolCalls: replay === "never" && cut === 6 ? 0 : replay === "safe" && replayedSafeTool ? 2 : 1,
					interruptedTool: replay === "never" && pendingTool,
				});
			}
		},
	);
});
