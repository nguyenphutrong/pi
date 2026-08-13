import { type AssistantMessage, type Context, createModels, type ModelRequestLease, Type } from "@earendil-works/pi-ai";
import {
	createIdGenerator,
	isUuidV7,
	type JsonValue,
	MemoryStorage,
	MemoryStorageState,
	type Register,
	type Storage,
	uuidV7Timestamp,
	type Write,
} from "@nguyenphutrong/pi-session-storage";
import { type InstrumentedStorage, instrumentStorage } from "@nguyenphutrong/pi-session-storage/testing";
import { describe, expect, it, vi } from "vitest";
import type { LaneConfiguration, RunOperation, RunState } from "../src/durable.ts";
import { MemorySessionRepo } from "../src/repo.ts";
import { createRuntimeShell, type RuntimeShellOptions, type RuntimeToolDefinition } from "../src/runtime-shell.ts";
import { MemorySession } from "../src/session.ts";
import { CURRENT_STORAGE_VERSION } from "../src/types.ts";
import { asMessage, assistant, id, toolResult, user, ZERO_USAGE } from "./fixtures.ts";

const config = (activeToolNames: string[] = []): LaneConfiguration => ({
	model: { provider: "test", modelId: "current" },
	thinkingLevel: "medium",
	activeToolNames,
});
const json = (value: unknown): JsonValue => value as JsonValue;

async function rooted(
	position: "idle" | "need" | "ready" | "pending" | "finish" = "need",
	storage: Storage = new MemoryStorage(),
	streamOptions: JsonValue = {},
	finalPayload?: JsonValue,
	recovery: { attempt: number; maxAttempts: number; baseDelayMs: number } = {
		attempt: 1,
		maxAttempts: 1,
		baseDelayMs: 1,
	},
	laneConfiguration: LaneConfiguration = config(),
) {
	const operationId = id();
	const source = id();
	const prompt = id();
	const response = id();
	const reservedResponse = id();
	const reservedUsage = id();
	const stepId = id();
	const writes: Write[] = [
		{
			kind: "register",
			op: "set",
			namespace: "lane.leaf",
			key: "main",
			value: position === "idle" ? null : position === "finish" ? response : prompt,
		},
		{
			kind: "register",
			op: "set",
			namespace: "lane.state",
			key: "main",
			value: { currentOperationId: position === "idle" ? null : operationId, pendingNextRun: [] },
		},
	];
	if (position !== "idle") {
		const trigger = position === "finish" ? response : prompt;
		const context = {
			stepId,
			triggerEntryId: trigger,
			configuration: laneConfiguration,
			streamOptions,
			retryPolicy: { maxAttempts: recovery.maxAttempts, baseDelayMs: recovery.baseDelayMs },
			overflowRecoveryUsed: false,
		};
		const phase =
			position === "ready"
				? { kind: "assistant", generation: { status: "ready", context, nextAttempt: 1 } }
				: position === "pending"
					? {
							kind: "assistant",
							generation: {
								status: "effect_pending",
								context,
								attempt: recovery.attempt,
								responseEntryId: reservedResponse,
								usageId: reservedUsage,
								intendedOutputLimit: 1,
								contextWindow: 2,
							},
						}
					: {
							kind: "checkpoint",
							continuation:
								position === "finish"
									? { kind: "may_finish", includeFinalAssistant: true }
									: { kind: "need_assistant", overflowRecoveryUsed: false },
							triggerEntryId: trigger,
						};
		writes.push(
			{ kind: "entry", entry: { id: source, parentId: null, type: "message", payload: json(user("source")) } },
			{ kind: "entry", entry: { id: prompt, parentId: source, type: "message", payload: json(user("prompt")) } },
			...(position === "finish"
				? [
						{
							kind: "entry" as const,
							entry: {
								id: response,
								parentId: prompt,
								type: "message" as const,
								payload:
									finalPayload ??
									json({
										role: "assistant",
										content: [{ type: "text", text: "done" }],
										api: "anthropic-messages",
										provider: "test",
										model: "current",
										usage: {
											input: 0,
											output: 0,
											cacheRead: 0,
											cacheWrite: 0,
											totalTokens: 0,
											cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
										},
										stopReason: "stop",
										timestamp: 1,
									}),
							},
						},
					]
				: []),
			{
				kind: "register",
				op: "set",
				namespace: "lane.config",
				key: "main",
				value: laneConfiguration as unknown as JsonValue,
			},
			{
				kind: "register",
				op: "set",
				namespace: "op.meta",
				key: operationId,
				value: json({
					operationId,
					lane: "main",
					sourceLeafId: source,
					startedAt: 1,
					intent: { kind: "run", promptEntryIds: [prompt] },
				}),
			},
			{
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: operationId,
				value: json({
					kind: "run",
					control: { status: "running" },
					settings: {
						compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
						steeringMode: "all",
						followUpMode: "all",
						toolExecution: "sequential",
					},
					phase,
					inbox: { steer: [], followUp: [], writes: [] },
					latestAssistantEntryId: position === "finish" ? response : null,
				}),
			},
		);
	}
	await storage.commit({ writes });
	return { storage, operationId, prompt, response, source, stepId, reservedResponse, reservedUsage };
}

function session(storage: Storage) {
	return new MemorySession(
		{ id: id(), createdAt: 1, storageVersion: CURRENT_STORAGE_VERSION },
		storage,
		() => undefined,
	);
}

function availableModels(
	limits: { maxTokens: number; contextWindow: number } = { maxTokens: 4096, contextWindow: 8192 },
) {
	const models = createModels();
	const never = new Promise<AssistantMessage>(() => undefined);
	const lease = {
		model: { provider: "test", id: "current", ...limits },
		stream: vi.fn(),
		streamSimple: vi.fn(() => ({ result: () => never }) as ReturnType<ModelRequestLease["streamSimple"]>),
		fetchDeferred: vi.fn(),
		cancelDeferred: vi.fn(),
	} as unknown as ModelRequestLease;
	const leaseSpy = vi.spyOn(models, "lease").mockReturnValue(lease);
	return { models, lease, leaseSpy };
}

function expectLeaseUnused(lease: ModelRequestLease): void {
	expect(lease.stream).not.toHaveBeenCalled();
	expect(lease.streamSimple).not.toHaveBeenCalled();
	expect(lease.fetchDeferred).not.toHaveBeenCalled();
	expect(lease.cancelDeferred).not.toHaveBeenCalled();
}

function terminal(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		...assistant(stopReason),
		provider: "test",
		model: "current",
		responseId: "upstream-response",
	};
}

const toolSchema = Type.Object({ value: Type.String() }, { additionalProperties: false });

function runtimeTool(
	overrides: Partial<RuntimeToolDefinition<{ batch: string }, typeof toolSchema>> = {},
): RuntimeToolDefinition<{ batch: string }, typeof toolSchema> {
	return {
		name: "echo",
		label: "Echo",
		description: "echo",
		parameters: toolSchema,
		replay: "never",
		execute: async (_callId, args) => ({ content: [{ type: "text", text: args.value }], details: null }),
		...overrides,
	};
}

function toolMessage(
	calls: Array<{ id: string; name?: string; arguments?: Record<string, unknown> }>,
): AssistantMessage {
	return {
		...terminal("toolUse"),
		content: calls.map((call) => ({
			type: "toolCall" as const,
			id: call.id,
			name: call.name ?? "echo",
			arguments: call.arguments ?? { value: call.id },
		})),
	};
}

async function settledToolBatch<TContext extends object | undefined>(
	message: AssistantMessage,
	options: Omit<RuntimeShellOptions<TContext>, "models">,
	activeToolNames: string[],
) {
	const prepared = await preparedShell(() => message, options, activeToolNames);
	await settlePrepared(prepared);
	return prepared;
}

async function settlePrepared(prepared: Awaited<ReturnType<typeof preparedShell>>) {
	await prepared.shell.executeAction();
	await prepared.shell.executeAction();
	expect(await prepared.shell.peekAction()).toMatchObject({ kind: "settle_assistant_effect" });
	return prepared.shell.executeAction();
}

async function preparedShell<TContext extends object | undefined = object | undefined>(
	result: () => Promise<AssistantMessage> | AssistantMessage,
	options: Omit<RuntimeShellOptions<TContext>, "models"> = {},
	activeToolNames: string[] = [],
) {
	const state = new MemoryStorageState();
	const durableOptions = { headers: { retained: "yes" }, metadata: { nested: [1] } };
	const fixture = await rooted(
		"ready",
		state.createStorage(),
		durableOptions,
		undefined,
		undefined,
		config(activeToolNames),
	);
	const instrumented = instrumentStorage(fixture.storage);
	const runtimeSession = session(instrumented);
	const projection = vi.spyOn(runtimeSession, "projectBuiltinContext");
	vi.spyOn(runtimeSession.idGenerator, "next").mockReturnValueOnce(id()).mockReturnValueOnce(id());
	const { models, lease, leaseSpy } = availableModels();
	const streamSimple = vi.mocked(lease.streamSimple);
	streamSimple.mockReturnValue({ result } as ReturnType<ModelRequestLease["streamSimple"]>);
	const shell = await createRuntimeShell(runtimeSession, config(), {
		models,
		...options,
	});
	await shell.executeAction();
	return {
		state,
		durableOptions,
		fixture,
		instrumented,
		runtimeSession,
		projection,
		models,
		lease,
		leaseSpy,
		streamSimple,
		shell,
	};
}

async function expectUncertainReopen(state: MemoryStorageState): Promise<void> {
	const storage = state.createStorage();
	const instrumented = instrumentStorage(storage);
	const models = createModels();
	const lease = vi.spyOn(models, "lease");
	const shell = await createRuntimeShell(session(instrumented), config(), { models });
	expect(await shell.peekAction()).toMatchObject({ kind: "recover_assistant_effect" });
	await expect(shell.executeAction()).resolves.toMatchObject({ kind: "recover_assistant_effect" });
	expect(lease).not.toHaveBeenCalled();
	expect(instrumented.committedTransactions).toHaveLength(1);
	expect(await shell.peekAction()).toMatchObject({ kind: "finish_failed_run" });
	await shell.close();
	expect(instrumented.committedTransactions).toHaveLength(1);
}

const commitCuts = [
	["prompt acceptance", 0, "start_assistant_step"],
	["assistant step ready", 1, "prepare_assistant_effect"],
	["assistant effect intent", 2, "recover_assistant_effect"],
	["assistant settlement", 5, "finish_run"],
	["terminal finish", 6, undefined],
] as const;

describe("D-019 no-tool fresh-handle lifecycle", () => {
	it.each(commitCuts)("restores %s through MemorySessionRepo", async (_cut, actions, nextKind) => {
		const now = 1_800_000_000_000 + actions;
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const handles: InstrumentedStorage[] = [];
		const createStorage = MemoryStorageState.prototype.createStorage;
		const storageSpy = vi.spyOn(MemoryStorageState.prototype, "createStorage").mockImplementation(function (
			this: MemoryStorageState,
		): MemoryStorage {
			const instrumented = instrumentStorage(createStorage.call(this));
			handles.push(instrumented);
			return instrumented as unknown as MemoryStorage;
		});
		try {
			const repo = new MemorySessionRepo();
			const created = await repo.create();
			expect(created).toBeInstanceOf(MemorySession);
			expect(created.metadata.createdAt).toBe(now);
			const operationId = id();
			const promptEntryId = id();
			const stepId = id();
			const responseEntryId = id();
			const usageId = id();
			const activeSession = created as MemorySession;
			vi.spyOn(activeSession.idGenerator, "next")
				.mockReturnValueOnce(operationId)
				.mockReturnValueOnce(promptEntryId)
				.mockReturnValueOnce(stepId)
				.mockReturnValueOnce(responseEntryId)
				.mockReturnValueOnce(usageId);
			const { models, lease } = availableModels();
			vi.mocked(lease.streamSimple).mockReturnValue({
				result: () => Promise.resolve(terminal()),
			} as ReturnType<ModelRequestLease["streamSimple"]>);
			const shell = await createRuntimeShell(activeSession, config(), { models });
			await shell.prompt(user("audit prompt"));
			for (let index = 0; index < actions; index++) await shell.executeAction();
			await shell.close();

			const reopened = await repo.open(created.metadata);
			const freshHandle = handles.at(-1);
			if (!freshHandle || handles.length !== 2) throw new Error("fresh repository storage handle missing");
			const restoredModels = createModels();
			const restoredLease = vi.spyOn(restoredModels, "lease");
			const restored = await createRuntimeShell(reopened, config(), { models: restoredModels });
			const expectedAction =
				nextKind === "start_assistant_step"
					? { kind: nextKind, operationId, triggerEntryId: promptEntryId }
					: nextKind === "prepare_assistant_effect"
						? { kind: nextKind, operationId, stepId, nextAttempt: 1 }
						: nextKind === "recover_assistant_effect"
							? { kind: nextKind, operationId, stepId, attempt: 1 }
							: nextKind === "finish_run"
								? { kind: nextKind, operationId, triggerEntryId: responseEntryId }
								: undefined;
			expect(await restored.peekAction()).toEqual(expectedAction);
			expect(freshHandle.committedTransactions).toEqual([]);
			expect(restoredLease).not.toHaveBeenCalled();
			await restored.close();
			expect(freshHandle.committedTransactions).toEqual([]);
		} finally {
			storageSpy.mockRestore();
			clock.mockRestore();
		}
	});
});

describe("D-019 no-tool ordered writer audit", () => {
	it.each([...commitCuts] as const)("records the complete transaction prefix at %s", async (_cut, actions) => {
		const now = 1_900_000_000_000 + actions;
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const handles: InstrumentedStorage[] = [];
		const createStorage = MemoryStorageState.prototype.createStorage;
		const storageSpy = vi.spyOn(MemoryStorageState.prototype, "createStorage").mockImplementation(function (
			this: MemoryStorageState,
		): MemoryStorage {
			const instrumented = instrumentStorage(createStorage.call(this));
			handles.push(instrumented);
			return instrumented as unknown as MemoryStorage;
		});
		try {
			const repo = new MemorySessionRepo();
			const activeSession = await repo.create();
			expect(activeSession).toBeInstanceOf(MemorySession);
			expect(activeSession.metadata.createdAt).toBe(now);
			const activeStorage = handles[0];
			if (!activeStorage) throw new Error("repository creation storage handle missing");
			const operationId = id();
			const promptEntryId = id();
			const stepId = id();
			const responseEntryId = id();
			const usageId = id();
			const memorySession = activeSession as MemorySession;
			vi.spyOn(memorySession.idGenerator, "next")
				.mockReturnValueOnce(operationId)
				.mockReturnValueOnce(promptEntryId)
				.mockReturnValueOnce(stepId)
				.mockReturnValueOnce(responseEntryId)
				.mockReturnValueOnce(usageId);
			const { models, lease } = availableModels();
			vi.mocked(lease.streamSimple).mockReturnValue({
				result: () => Promise.resolve(terminal()),
			} as ReturnType<ModelRequestLease["streamSimple"]>);
			const shell = await createRuntimeShell(memorySession, config(), { models });
			await shell.prompt(user("audit prompt"));
			const operation: RunOperation = {
				operationId,
				lane: "main",
				sourceLeafId: null,
				startedAt: now,
				intent: { kind: "run", promptEntryIds: [promptEntryId] },
			};
			const commonState = {
				kind: "run" as const,
				control: { status: "running" as const },
				settings: {
					compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
					steeringMode: "all" as const,
					followUpMode: "all" as const,
					toolExecution: "sequential" as const,
				},
				inbox: { steer: [] as [], followUp: [] as [], writes: [] as [] },
			};
			const acceptedState: RunState = {
				...commonState,
				phase: {
					kind: "checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: promptEntryId,
				},
				latestAssistantEntryId: null,
			};
			const generationContext = {
				stepId,
				triggerEntryId: promptEntryId,
				configuration: config(),
				streamOptions: {},
				retryPolicy: { maxAttempts: 1, baseDelayMs: 1000 },
				overflowRecoveryUsed: false,
			};
			const readyState: RunState = {
				...commonState,
				phase: { kind: "assistant", generation: { status: "ready", context: generationContext, nextAttempt: 1 } },
				latestAssistantEntryId: null,
			};
			const pendingState: RunState = {
				...commonState,
				phase: {
					kind: "assistant",
					generation: {
						status: "effect_pending",
						context: generationContext,
						attempt: 1,
						responseEntryId,
						usageId,
						intendedOutputLimit: 4096,
						contextWindow: 8192,
					},
				},
				latestAssistantEntryId: null,
			};
			const settledState: RunState = {
				...commonState,
				phase: {
					kind: "checkpoint",
					continuation: { kind: "may_finish", includeFinalAssistant: true },
					triggerEntryId: responseEntryId,
				},
				latestAssistantEntryId: responseEntryId,
			};
			const lastResult = {
				operationId,
				kind: "run" as const,
				outcome: "completed" as const,
				leafId: responseEntryId,
				finalAssistantEntryId: responseEntryId,
				runCompletion: "assistant" as const,
			};
			const expectedTransactions = [
				[
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { currentOperationId: null, pendingNextRun: [] },
					},
				],
				[{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: json(config()) }],
				[
					{
						kind: "entry",
						entry: { id: promptEntryId, parentId: null, type: "message", payload: json(user("audit prompt")) },
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: promptEntryId },
					{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: json(operation) },
					{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: json(acceptedState) },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { currentOperationId: operationId, pendingNextRun: [] },
					},
				],
				[{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: json(readyState) }],
				[{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: json(pendingState) }],
				[
					{
						kind: "entry",
						entry: { id: responseEntryId, parentId: promptEntryId, type: "message", payload: json(terminal()) },
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: responseEntryId },
					{
						kind: "usage",
						row: { id: usageId, entryId: responseEntryId, usage: terminal().usage, adjustment: false },
					},
					{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: json(settledState) },
				],
				[
					{ kind: "register", op: "delete", namespace: "op.meta", key: operationId },
					{ kind: "register", op: "delete", namespace: "op.state", key: operationId },
					{ kind: "register", op: "set", namespace: "lane.lastResult", key: "main", value: lastResult },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { currentOperationId: null, pendingNextRun: [] },
					},
				],
			] satisfies Write[][];
			for (let index = 0; index < actions; index++) await shell.executeAction();

			const expectedCount = actions === 0 ? 3 : actions === 1 ? 4 : actions === 2 ? 5 : actions === 5 ? 6 : 7;
			expect(activeStorage.committedTransactions.map(({ writes }) => writes)).toEqual(
				expectedTransactions.slice(0, expectedCount),
			);
			expect((await activeStorage.getRegister("lane.config", "main"))?.value).toEqual(config());
			expect((await activeStorage.getEntries([promptEntryId])).get(promptEntryId)).toEqual({
				id: promptEntryId,
				parentId: null,
				seq: 4,
				timestamp: now,
				type: "message",
				payload: user("audit prompt"),
			});
			const expectedCurrentState =
				actions === 0 ? acceptedState : actions === 1 ? readyState : actions === 2 ? pendingState : settledState;
			if (actions < 6) {
				expect((await activeStorage.getRegister("lane.state", "main"))?.value).toEqual({
					currentOperationId: operationId,
					pendingNextRun: [],
				});
				expect((await activeStorage.getRegister("op.meta", operationId))?.value).toEqual(operation);
				expect((await activeStorage.getRegister("op.state", operationId))?.value).toEqual(expectedCurrentState);
				expect(await activeStorage.getRegister("lane.lastResult", "main")).toBeUndefined();
			}
			if (actions === 2) {
				expect(isUuidV7(responseEntryId)).toBe(true);
				expect(isUuidV7(usageId)).toBe(true);
				expect(responseEntryId).not.toBe(usageId);
				expect((await activeStorage.getEntries([responseEntryId, usageId])).size).toBe(0);
				expect((await activeStorage.getUsageRows([responseEntryId, usageId])).size).toBe(0);
				expect((await activeStorage.getRegister("lane.leaf", "main"))?.value).toBe(promptEntryId);
			}
			if (actions >= 5) {
				expect((await activeStorage.getEntries([responseEntryId])).get(responseEntryId)).toEqual({
					id: responseEntryId,
					parentId: promptEntryId,
					seq: 11,
					timestamp: now,
					type: "message",
					payload: terminal(),
				});
				expect((await activeStorage.getUsageRows([usageId])).get(usageId)).toEqual({
					id: usageId,
					seq: 13,
					entryId: responseEntryId,
					adjustment: false,
					usage: terminal().usage,
				});
				expect((await activeStorage.getRegister("lane.leaf", "main"))?.value).toBe(responseEntryId);
			}
			if (actions === 6) {
				expect((await activeStorage.getRegister("lane.lastResult", "main"))?.value).toEqual(lastResult);
				expect((await activeStorage.getRegister("lane.leaf", "main"))?.value).toBe(responseEntryId);
				expect((await activeStorage.getRegister("lane.state", "main"))?.value).toEqual({
					currentOperationId: null,
					pendingNextRun: [],
				});
				expect(await activeStorage.getRegister("op.meta", operationId)).toBeUndefined();
				expect(await activeStorage.getRegister("op.state", operationId)).toBeUndefined();
				for (const namespace of ["op.tool_args", "op.preparation", "pending.entry"])
					expect(await activeStorage.listRegisters(namespace)).toEqual([]);
			}
			await shell.close();
		} finally {
			storageSpy.mockRestore();
			clock.mockRestore();
		}
	});
});

describe("Phase 1 runtime shell", () => {
	it("prepares one detached durable assistant intent and parks the retained live plan", async () => {
		const fixture = await rooted("ready");
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const responseEntryId = id();
		const usageId = id();
		vi.spyOn(runtimeSession.idGenerator, "next").mockReturnValueOnce(responseEntryId).mockReturnValueOnce(usageId);
		const projection = vi.spyOn(runtimeSession, "projectBuiltinContext");
		const { models, lease, leaseSpy } = availableModels({ maxTokens: 321, contextWindow: 654 });
		const shell = await createRuntimeShell(runtimeSession, config(), { models });

		await expect(shell.executeAction()).resolves.toMatchObject({
			kind: "prepare_assistant_effect",
			operationId: fixture.operationId,
			stepId: fixture.stepId,
			nextAttempt: 1,
		});
		expect(leaseSpy).toHaveBeenCalledExactlyOnceWith("test", "current");
		expect(projection).toHaveBeenCalledTimes(1);
		expectLeaseUnused(lease);
		expect(instrumented.committedTransactions).toHaveLength(1);
		expect(instrumented.committedTransactions[0].writes).toEqual([
			expect.objectContaining({ kind: "register", op: "set", namespace: "op.state", key: fixture.operationId }),
		]);
		const durable = (await fixture.storage.getRegister("op.state", fixture.operationId))!.value;
		expect(durable).toMatchObject({
			phase: {
				kind: "assistant",
				generation: {
					status: "effect_pending",
					attempt: 1,
					responseEntryId,
					usageId,
					intendedOutputLimit: 321,
					contextWindow: 654,
					context: { configuration: config(), streamOptions: {} },
				},
			},
		});
		const serialized = JSON.stringify(durable);
		for (const forbidden of ["lease", "messages", "streamSimple", "fetchDeferred", "cancelDeferred", "reasoning"])
			expect(serialized).not.toContain(forbidden);
		expect(await shell.peekAction()).toMatchObject({ kind: "dispatch_assistant_effect" });
		const beforePark = instrumented.committedTransactions.length;
		await expect(shell.executeAction()).resolves.toMatchObject({ kind: "dispatch_assistant_effect" });
		expect(instrumented.committedTransactions).toHaveLength(beforePark);
		expect(projection).toHaveBeenCalledTimes(1);
		expect(lease.streamSimple).toHaveBeenCalledTimes(1);
		await shell.close();
	});

	it.each([
		["missing", undefined],
		["throwing", undefined],
		["provider mismatch", { provider: "other", id: "current", maxTokens: 1, contextWindow: 2 }],
		["model mismatch", { provider: "test", id: "other", maxTokens: 1, contextWindow: 2 }],
		["zero max", { provider: "test", id: "current", maxTokens: 0, contextWindow: 2 }],
		["fractional context", { provider: "test", id: "current", maxTokens: 1, contextWindow: 2.5 }],
	] as const)("rejects %s assistant leases before projection, IDs, or writes", async (name, model) => {
		const fixture = await rooted("ready");
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const next = vi.spyOn(runtimeSession.idGenerator, "next");
		const projection = vi.spyOn(runtimeSession, "projectBuiltinContext");
		const models = createModels();
		const lease =
			model === undefined
				? undefined
				: ({
						model,
						stream: vi.fn(),
						streamSimple: vi.fn(),
						fetchDeferred: vi.fn(),
						cancelDeferred: vi.fn(),
					} as unknown as ModelRequestLease);
		const leaseSpy = vi.spyOn(models, "lease");
		if (name === "throwing")
			leaseSpy.mockImplementation(() => {
				throw new Error("lease failed");
			});
		else leaseSpy.mockReturnValue(lease);
		const shell = await createRuntimeShell(runtimeSession, config(), { models });
		await expect(shell.executeAction()).rejects.toMatchObject({ code: "unavailable" });
		expect(projection).not.toHaveBeenCalled();
		expect(next).not.toHaveBeenCalled();
		expect(instrumented.committedTransactions).toHaveLength(0);
		if (lease) expectLeaseUnused(lease);
		expect(await shell.peekAction()).toMatchObject({ kind: "prepare_assistant_effect" });
		await shell.close();
	});

	it("snapshots limits before blocked projection and retains a replaced registry lease", async () => {
		const fixture = await rooted("ready");
		const runtimeSession = session(fixture.storage);
		vi.spyOn(runtimeSession.idGenerator, "next").mockReturnValueOnce(id()).mockReturnValueOnce(id());
		const { models, lease, leaseSpy } = availableModels({ maxTokens: 100, contextWindow: 200 });
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const projected = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const originalProjection = runtimeSession.projectBuiltinContext.bind(runtimeSession);
		vi.spyOn(runtimeSession, "projectBuiltinContext").mockImplementation(async () => {
			entered();
			await blocked;
			return originalProjection();
		});
		const shell = await createRuntimeShell(runtimeSession, config(), { models });
		const execute = shell.executeAction();
		await projected;
		Object.assign(lease.model, { maxTokens: 999, contextWindow: 999 });
		leaseSpy.mockImplementation(() => {
			throw new Error("registry replaced");
		});
		release();
		await execute;
		const state = (await fixture.storage.getRegister("op.state", fixture.operationId))!.value as Record<
			string,
			JsonValue
		>;
		const generation = (state.phase as Record<string, JsonValue>).generation as Record<string, JsonValue>;
		expect(generation).toMatchObject({ intendedOutputLimit: 100, contextWindow: 200 });
		expect(leaseSpy).toHaveBeenCalledTimes(1);
		expectLeaseUnused(lease);
		await shell.close();
	});

	it.each(["op.state", "lane.state", "lane.config", "lane.leaf"] as const)(
		"discards the prepared plan when canonical %s sequence changes after projection",
		async (namespace) => {
			const fixture = await rooted("ready");
			const instrumented = instrumentStorage(fixture.storage);
			const runtimeSession = session(instrumented);
			const next = vi.spyOn(runtimeSession.idGenerator, "next");
			const originalProjection = runtimeSession.projectBuiltinContext.bind(runtimeSession);
			const projection = vi.spyOn(runtimeSession, "projectBuiltinContext");
			const { models, leaseSpy } = availableModels();
			const shell = await createRuntimeShell(runtimeSession, config(), { models });
			const key = namespace === "op.state" ? fixture.operationId : "main";
			const current = await fixture.storage.getRegister(namespace, key);
			projection.mockImplementationOnce(async () => {
				await fixture.storage.commit({
					writes: [{ kind: "register", op: "set", namespace, key, value: current!.value }],
				});
				return originalProjection();
			});
			const before = instrumented.committedTransactions.length;
			await expect(shell.executeAction()).rejects.toMatchObject({ code: "stale" });
			expect(leaseSpy).toHaveBeenCalledTimes(1);
			expect(next).not.toHaveBeenCalled();
			expect(instrumented.committedTransactions).toHaveLength(before);
			expect(await shell.peekAction()).toMatchObject({ kind: "prepare_assistant_effect" });
			expect(leaseSpy).toHaveBeenCalledTimes(1);
			await shell.close();
		},
	);

	it("retains the ready generation model after a stale configuration refresh", async () => {
		const fixture = await rooted("ready");
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const next = vi.spyOn(runtimeSession.idGenerator, "next");
		const projection = vi.spyOn(runtimeSession, "projectBuiltinContext");
		const { models, lease, leaseSpy } = availableModels();
		const replacement: LaneConfiguration = { ...config(), model: { provider: "test", modelId: "replacement" } };
		const originalProjection = runtimeSession.projectBuiltinContext.bind(runtimeSession);
		projection.mockImplementationOnce(async () => {
			await fixture.storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "lane.config",
						key: "main",
						value: replacement as unknown as JsonValue,
					},
				],
			});
			return originalProjection();
		});
		const shell = await createRuntimeShell(runtimeSession, config(), { models });

		await expect(shell.executeAction()).rejects.toMatchObject({ code: "stale" });
		expect(next).not.toHaveBeenCalled();
		expect(instrumented.committedTransactions).toHaveLength(0);
		expect(await shell.peekAction()).toMatchObject({ kind: "prepare_assistant_effect" });

		const responseEntryId = id();
		const usageId = id();
		next.mockReturnValueOnce(responseEntryId).mockReturnValueOnce(usageId);
		await expect(shell.executeAction()).resolves.toMatchObject({ kind: "prepare_assistant_effect" });
		expect(leaseSpy.mock.calls).toEqual([
			["test", "current"],
			["test", "current"],
		]);
		expectLeaseUnused(lease);
		expect(instrumented.committedTransactions).toHaveLength(1);
		const durable = (await fixture.storage.getRegister("op.state", fixture.operationId))!.value;
		expect(durable).toMatchObject({
			phase: {
				kind: "assistant",
				generation: {
					status: "effect_pending",
					responseEntryId,
					usageId,
					context: { configuration: config() },
				},
			},
		});
		await shell.close();
	});

	it("rejects rooted closure corruption after projection before IDs, write, or live plan", async () => {
		const fixture = await rooted("ready");
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const next = vi.spyOn(runtimeSession.idGenerator, "next");
		const { models } = availableModels();
		vi.spyOn(runtimeSession, "projectBuiltinContext").mockImplementationOnce(async () => {
			await fixture.storage.commit({
				writes: [{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: fixture.source }],
			});
			return [user("projected")];
		});
		const shell = await createRuntimeShell(runtimeSession, config(), { models });
		const before = instrumented.committedTransactions.length;
		await expect(shell.executeAction()).rejects.toMatchObject({ code: "corruption" });
		expect(next).not.toHaveBeenCalled();
		expect(instrumented.committedTransactions).toHaveLength(before);
		await shell.close();
	});

	it.each(["same", "operation", "step", "prompt", "entry", "usage", "op.meta", "op.state"] as const)(
		"rejects assistant reservation collision with %s without changing ready state",
		async (kind) => {
			const fixture = await rooted("ready");
			const collision = id();
			if (["entry", "usage", "op.meta", "op.state"].includes(kind)) {
				const owner = id();
				await fixture.storage.commit({
					writes:
						kind === "entry"
							? [
									{
										kind: "entry",
										entry: {
											id: collision,
											parentId: null,
											type: "message",
											payload: json(user("occupied")),
										},
									},
								]
							: kind === "usage"
								? [
										{
											kind: "entry",
											entry: { id: owner, parentId: null, type: "message", payload: json(user("owner")) },
										},
										{
											kind: "usage",
											row: { id: collision, entryId: owner, adjustment: false, usage: ZERO_USAGE },
										},
									]
								: [{ kind: "register", op: "set", namespace: kind, key: collision, value: null }],
				});
			}
			const instrumented = instrumentStorage(fixture.storage);
			const runtimeSession = session(instrumented);
			const first =
				kind === "operation"
					? fixture.operationId
					: kind === "step"
						? fixture.stepId
						: kind === "prompt"
							? fixture.prompt
							: collision;
			vi.spyOn(runtimeSession.idGenerator, "next")
				.mockReturnValueOnce(first)
				.mockReturnValueOnce(kind === "same" ? first : id());
			const { models } = availableModels();
			const shell = await createRuntimeShell(runtimeSession, config(), { models });
			const before = instrumented.committedTransactions.length;
			await expect(shell.executeAction()).rejects.toMatchObject({ code: "storage" });
			expect(instrumented.committedTransactions).toHaveLength(before);
			expect(await shell.peekAction()).toMatchObject({ kind: "prepare_assistant_effect" });
			await shell.close();
		},
	);
	it("accepts an ordered multi-role prompt as one atomic canonical run and detaches caller data", async () => {
		const fixture = await rooted("idle");
		const priorLeafId = id();
		await fixture.storage.commit({
			writes: [
				{
					kind: "entry",
					entry: { id: priorLeafId, parentId: null, type: "message", payload: json(user("prior leaf")) },
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: priorLeafId },
			],
		});
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const operationId = id();
		const assistantId = id();
		const toolResultId = id();
		vi.spyOn(runtimeSession.idGenerator, "next")
			.mockReturnValueOnce(operationId)
			.mockReturnValueOnce(assistantId)
			.mockReturnValueOnce(toolResultId);
		const { models, lease, leaseSpy } = availableModels();
		const assistantMessage = assistant();
		const toolResultMessage = toolResult();
		const messages = [assistantMessage, toolResultMessage];
		const shell = await createRuntimeShell(runtimeSession, config(), { models });
		const oldLeaf = (await fixture.storage.getRegister("lane.leaf", "main"))!;
		const prompt = shell.prompt(messages);
		assistantMessage.content[0] = { type: "text", text: "caller mutation" };
		toolResultMessage.details = { path: "mutated" };
		messages.length = 0;
		const accepted = await prompt;

		expect(leaseSpy).toHaveBeenCalledExactlyOnceWith("test", "current");
		expect(lease.stream).not.toHaveBeenCalled();
		expect(lease.streamSimple).not.toHaveBeenCalled();
		expect(lease.fetchDeferred).not.toHaveBeenCalled();
		expect(lease.cancelDeferred).not.toHaveBeenCalled();
		expect(instrumented.committedTransactions).toHaveLength(2); // config seed, then acceptance
		const writes = instrumented.committedTransactions[1].writes;
		expect(
			writes.map((write) => {
				if (write.kind === "register") return `${write.namespace}:${write.key}`;
				if (write.kind === "entry") return `entry:${write.entry.id}`;
				return `usage:${write.row.id}`;
			}),
		).toEqual([
			`entry:${assistantId}`,
			`entry:${toolResultId}`,
			"lane.leaf:main",
			`op.meta:${operationId}`,
			`op.state:${operationId}`,
			"lane.state:main",
		]);
		expect(writes[0]).toMatchObject({ entry: { id: assistantId, parentId: oldLeaf.value, payload: assistant() } });
		expect(writes[1]).toMatchObject({ entry: { id: toolResultId, parentId: assistantId, payload: toolResult() } });
		expect(accepted.mainLeaf.value).toBe(toolResultId);
		expect(accepted.runOperation?.value).toMatchObject({
			operationId,
			sourceLeafId: oldLeaf.value,
			intent: { kind: "run", promptEntryIds: [assistantId, toolResultId] },
		});
		expect(accepted.runState?.value).toEqual({
			kind: "run",
			control: { status: "running" },
			settings: {
				compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
				steeringMode: "all",
				followUpMode: "all",
				toolExecution: "sequential",
			},
			phase: {
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: toolResultId,
			},
			inbox: { steer: [], followUp: [], writes: [] },
			latestAssistantEntryId: null,
		});
		expect(accepted.entries.get(assistantId)?.message).toEqual(assistant());
		expect(accepted.entries.get(toolResultId)?.message).toEqual(toolResult());
		expect(await shell.peekAction()).toMatchObject({ kind: "start_assistant_step", operationId });
		await shell.close();
	});

	it.each([
		["empty", []],
		["malformed", [asMessage({ role: "user", content: 1, timestamp: 1 })]],
		["pending assistant", [assistant("pending")]],
	] as const)("rejects %s prompts before lease, IDs, and writes", async (_name, messages) => {
		const fixture = await rooted("idle");
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const next = vi.spyOn(runtimeSession.idGenerator, "next");
		const { models, leaseSpy } = availableModels();
		const shell = await createRuntimeShell(runtimeSession, config(), { models });
		const before = instrumented.committedTransactions.length;
		await expect(shell.prompt(messages)).rejects.toBeDefined();
		expect(leaseSpy).not.toHaveBeenCalled();
		expect(next).not.toHaveBeenCalled();
		expect(instrumented.committedTransactions).toHaveLength(before);
		await shell.close();
	});

	it.each(["missing", "throwing"] as const)("keeps idle prompt %s-model unavailable write-free", async (kind) => {
		const fixture = await rooted("idle");
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const next = vi.spyOn(runtimeSession.idGenerator, "next");
		const models = createModels();
		const leaseSpy = vi.spyOn(models, "lease");
		if (kind === "throwing")
			leaseSpy.mockImplementation(() => {
				throw new Error("lease failed");
			});
		const shell = await createRuntimeShell(runtimeSession, config(), { models });
		const before = instrumented.committedTransactions.length;
		await expect(shell.prompt(user("prompt"))).rejects.toMatchObject({ code: "unavailable" });
		expect(leaseSpy).toHaveBeenCalledExactlyOnceWith("test", "current");
		expect(next).not.toHaveBeenCalled();
		expect(instrumented.committedTransactions).toHaveLength(before);
		expect(await shell.peekAction()).toBeUndefined();
		await shell.close();
	});

	it.each(["lane.config", "lane.state", "lane.leaf"] as const)(
		"refreshes stale %s without acceptance IDs or writes",
		async (namespace) => {
			const fixture = await rooted("idle");
			const instrumented = instrumentStorage(fixture.storage);
			const runtimeSession = session(instrumented);
			const next = vi.spyOn(runtimeSession.idGenerator, "next");
			const { models } = availableModels();
			const shell = await createRuntimeShell(runtimeSession, config(), { models });
			const current = await instrumented.getRegister(namespace, "main");
			await fixture.storage.commit({
				writes: [{ kind: "register", op: "set", namespace, key: "main", value: current!.value }],
			});
			const before = instrumented.committedTransactions.length;
			await expect(shell.prompt(user("prompt"))).rejects.toMatchObject({ code: "stale" });
			expect(next).not.toHaveBeenCalled();
			expect(instrumented.committedTransactions).toHaveLength(before);
			expect(await shell.peekAction()).toBeUndefined();
			await shell.close();
		},
	);

	it("serializes concurrent prompts so exactly one wins and the loser preserves the operation", async () => {
		const fixture = await rooted("idle");
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const operationId = id();
		vi.spyOn(runtimeSession.idGenerator, "next").mockReturnValueOnce(operationId).mockReturnValueOnce(id());
		const { models } = availableModels();
		const shell = await createRuntimeShell(runtimeSession, config(), { models });
		const results = await Promise.allSettled([shell.prompt(user("first")), shell.prompt(user("second"))]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "busy" } });
		expect(instrumented.committedTransactions).toHaveLength(2);
		expect(await shell.peekAction()).toMatchObject({ kind: "start_assistant_step", operationId });
		await shell.close();
	});

	it.each(["duplicate", "entry", "usage", "register"] as const)(
		"rejects generated ID collision with %s without acceptance writes",
		async (kind) => {
			const fixture = await rooted("idle");
			const collision = id();
			if (kind !== "duplicate") {
				const usageEntryId = id();
				await fixture.storage.commit({
					writes: [
						...(kind === "usage"
							? [
									{
										kind: "entry" as const,
										entry: {
											id: usageEntryId,
											parentId: null,
											type: "message" as const,
											payload: json(user("usage owner")),
										},
									},
								]
							: []),
						kind === "entry"
							? {
									kind: "entry",
									entry: { id: collision, parentId: null, type: "message", payload: json(user("occupied")) },
								}
							: kind === "usage"
								? {
										kind: "usage",
										row: { id: collision, entryId: usageEntryId, adjustment: false, usage: ZERO_USAGE },
									}
								: { kind: "register", op: "set", namespace: "op.meta", key: collision, value: null },
					],
				});
			}
			const instrumented = instrumentStorage(fixture.storage);
			const runtimeSession = session(instrumented);
			vi.spyOn(runtimeSession.idGenerator, "next")
				.mockReturnValueOnce(collision)
				.mockReturnValueOnce(kind === "duplicate" ? collision : id());
			const { models } = availableModels();
			const shell = await createRuntimeShell(runtimeSession, config(), { models });
			const before = instrumented.committedTransactions.length;
			await expect(shell.prompt(user("prompt"))).rejects.toMatchObject({ code: "storage" });
			expect(instrumented.committedTransactions).toHaveLength(before);
			await shell.close();
		},
	);
	it("keeps repeated peeks stable and executes need_assistant with one exact state write", async () => {
		const fixture = await rooted();
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config(), {
			streamOptions: { transport: "sse", headers: { x: "y" } },
			retryPolicy: { enabled: true, maxRetries: 2, baseDelayMs: 25 },
		});
		const before = await shell.peekAction();
		expect(await shell.peekAction()).toEqual(before);
		expect(instrumented.committedTransactions).toHaveLength(0);
		expect(await shell.executeAction()).toEqual(before);
		expect(instrumented.committedTransactions).toHaveLength(1);
		expect(instrumented.committedTransactions[0].writes).toEqual([
			expect.objectContaining({ kind: "register", op: "set", namespace: "op.state", key: fixture.operationId }),
		]);
		const state = (await fixture.storage.getRegister("op.state", fixture.operationId))?.value as Record<
			string,
			JsonValue
		>;
		const generation = (state.phase as Record<string, JsonValue>).generation as Record<string, JsonValue>;
		const context = generation.context as Record<string, JsonValue>;
		expect(generation).toMatchObject({ status: "ready", nextAttempt: 1 });
		expect(context).toMatchObject({
			triggerEntryId: fixture.prompt,
			configuration: config(),
			streamOptions: { transport: "sse", headers: { x: "y" } },
			retryPolicy: { maxAttempts: 3, baseDelayMs: 25 },
			overflowRecoveryUsed: false,
		});
		expect(context.stepId).toEqual(expect.any(String));
		expect(await shell.peekAction()).toMatchObject({
			kind: "prepare_assistant_effect",
			operationId: fixture.operationId,
			nextAttempt: 1,
		});
		await expect(shell.executeAction()).rejects.toMatchObject({ code: "unavailable" });
		expect(instrumented.committedTransactions).toHaveLength(1);
		await shell.close();
	});

	it("keeps parked ready actions visible and write-free", async () => {
		const position = "ready" as const;
		const fixture = await rooted(position);
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		const action = await shell.peekAction();
		expect(action).toBeDefined();
		await expect(shell.executeAction()).rejects.toMatchObject({ code: "unavailable" });
		expect(await shell.peekAction()).toEqual(action);
		expect(instrumented.committedTransactions).toHaveLength(0);
		await shell.close();
	});

	it("recovers a parked pending action at the captured cap without resolving a provider", async () => {
		const fixture = await rooted("pending");
		const instrumented = instrumentStorage(fixture.storage);
		const models = createModels();
		const lease = vi.spyOn(models, "lease");
		const shell = await createRuntimeShell(session(instrumented), config(), { models });
		await expect(shell.executeAction()).resolves.toMatchObject({ kind: "recover_assistant_effect" });
		expect(instrumented.committedTransactions).toHaveLength(1);
		expect(lease).not.toHaveBeenCalled();
		expect(await shell.peekAction()).toMatchObject({ kind: "finish_failed_run" });
		await shell.close();
	});

	it("crosses a below-cap durable retry boundary, then prepares fresh attempt-two reservations", async () => {
		const now = 2_000_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const state = new MemoryStorageState();
		const fixture = await rooted("pending", state.createStorage(), {}, undefined, {
			attempt: 1,
			maxAttempts: 3,
			baseDelayMs: 25,
		});
		const firstStorage = instrumentStorage(fixture.storage);
		const firstModels = createModels();
		const firstLease = vi.spyOn(firstModels, "lease");
		const first = await createRuntimeShell(session(firstStorage), config(), { models: firstModels });
		expect(await first.executeAction()).toEqual({
			kind: "recover_assistant_effect",
			operationId: fixture.operationId,
			stepId: fixture.stepId,
			attempt: 1,
		});
		expect(firstStorage.committedTransactions).toHaveLength(1);
		expect(firstStorage.committedTransactions[0].writes).toEqual([
			expect.objectContaining({ kind: "register", op: "set", namespace: "op.state", key: fixture.operationId }),
		]);
		const waiting = (await fixture.storage.getRegister("op.state", fixture.operationId))!
			.value as unknown as RunState;
		expect(waiting.phase).toEqual({
			kind: "assistant",
			generation: {
				status: "retry_wait",
				context: expect.objectContaining({
					stepId: fixture.stepId,
					configuration: config(),
					retryPolicy: { maxAttempts: 3, baseDelayMs: 25 },
				}),
				nextAttempt: 2,
				notBefore: now + 25,
				errorMessage: "Provider outcome unknown after interruption",
			},
		});
		expect(await fixture.storage.getEntries([fixture.reservedResponse])).toEqual(new Map());
		expect(await fixture.storage.getUsageRows([fixture.reservedUsage])).toEqual(new Map());
		expect((await fixture.storage.getRegister("lane.leaf", "main"))?.value).toBe(fixture.prompt);
		expect(firstLease).not.toHaveBeenCalled();
		await first.close();

		const secondStorage = instrumentStorage(state.createStorage());
		const second = await createRuntimeShell(session(secondStorage), config());
		const wait = {
			kind: "wait_assistant_retry" as const,
			operationId: fixture.operationId,
			stepId: fixture.stepId,
			nextAttempt: 2,
			notBefore: now + 25,
		};
		expect(await second.peekAction()).toEqual(wait);
		expect(secondStorage.committedTransactions).toEqual([]);
		clock.mockReturnValue(now + 25);
		expect(await second.peekAction()).toEqual(wait);
		expect(await second.executeAction()).toEqual(wait);
		expect(secondStorage.committedTransactions).toEqual([]);
		expect(await second.peekAction()).toEqual({ ...wait, kind: "release_assistant_retry" });
		expect(await second.executeAction()).toEqual({ ...wait, kind: "release_assistant_retry" });
		expect(secondStorage.committedTransactions).toHaveLength(1);
		expect(secondStorage.committedTransactions[0].writes).toEqual([
			expect.objectContaining({ kind: "register", op: "set", namespace: "op.state", key: fixture.operationId }),
		]);
		await second.close();

		const thirdStorage = instrumentStorage(state.createStorage());
		const thirdSession = session(thirdStorage);
		const response2 = id();
		const usage2 = id();
		vi.spyOn(thirdSession.idGenerator, "next").mockReturnValueOnce(response2).mockReturnValueOnce(usage2);
		const available = availableModels();
		const third = await createRuntimeShell(thirdSession, config(), { models: available.models });
		expect(await third.peekAction()).toEqual({
			kind: "prepare_assistant_effect",
			operationId: fixture.operationId,
			stepId: fixture.stepId,
			nextAttempt: 2,
		});
		await third.executeAction();
		const pending = (await thirdStorage.getRegister("op.state", fixture.operationId))!.value as unknown as RunState;
		expect(pending.phase).toEqual({
			kind: "assistant",
			generation: expect.objectContaining({
				status: "effect_pending",
				attempt: 2,
				responseEntryId: response2,
				usageId: usage2,
				context: expect.objectContaining({
					retryPolicy: { maxAttempts: 3, baseDelayMs: 25 },
					configuration: config(),
				}),
			}),
		});
		expect([response2, usage2]).not.toContain(fixture.reservedResponse);
		expect([response2, usage2]).not.toContain(fixture.reservedUsage);
		await third.close();
		const fourth = await createRuntimeShell(session(state.createStorage()), config());
		expect(await fourth.peekAction()).toEqual({
			kind: "recover_assistant_effect",
			operationId: fixture.operationId,
			stepId: fixture.stepId,
			attempt: 2,
		});
		await fourth.close();
		clock.mockRestore();
	});

	it("cancels a retry timer on close without proof or durable writes", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(10_000);
			const state = new MemoryStorageState();
			const fixture = await rooted("pending", state.createStorage(), {}, undefined, {
				attempt: 1,
				maxAttempts: 2,
				baseDelayMs: 1_000,
			});
			const initial = await createRuntimeShell(session(fixture.storage), config());
			await initial.executeAction();
			await initial.close();
			const storage = instrumentStorage(state.createStorage());
			const shell = await createRuntimeShell(session(storage), config());
			const waiting = shell.executeAction();
			await vi.advanceTimersByTimeAsync(100);
			const closing = shell.close();
			await expect(waiting).rejects.toMatchObject({ code: "closed" });
			await closing;
			expect(storage.committedTransactions).toEqual([]);
			await vi.runAllTimersAsync();
			const reopened = await createRuntimeShell(session(state.createStorage()), config());
			expect(await reopened.peekAction()).toMatchObject({ kind: "wait_assistant_retry", notBefore: 11_000 });
			await reopened.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("writes the exact capped synthetic failure and exact failed terminal transaction", async () => {
		const now = 9_876;
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const state = new MemoryStorageState();
		const fixture = await rooted("pending", state.createStorage(), {}, undefined, {
			attempt: 3,
			maxAttempts: 3,
			baseDelayMs: 7,
		});
		const storage = instrumentStorage(fixture.storage);
		const runtimeSession = session(storage);
		const ids = vi.spyOn(runtimeSession.idGenerator, "next");
		const models = createModels();
		const lease = vi.spyOn(models, "lease");
		const shell = await createRuntimeShell(runtimeSession, config(), { models });
		await shell.executeAction();
		const zero = ZERO_USAGE;
		const error = { code: "provider_interrupted", message: "Provider outcome unknown after interruption" };
		expect(storage.committedTransactions[0].writes).toEqual([
			{
				kind: "entry",
				entry: {
					id: fixture.reservedResponse,
					parentId: fixture.prompt,
					type: "message",
					payload: {
						role: "assistant",
						content: [],
						api: "harness",
						provider: "test",
						model: "current",
						usage: zero,
						stopReason: "error",
						errorMessage: error.message,
						timestamp: now,
					},
				},
			},
			{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: fixture.reservedResponse },
			{
				kind: "usage",
				row: { id: fixture.reservedUsage, entryId: fixture.reservedResponse, usage: zero, adjustment: false },
			},
			expect.objectContaining({ kind: "register", op: "set", namespace: "op.state", key: fixture.operationId }),
		]);
		const drainWrite = storage.committedTransactions[0].writes[3];
		if (drainWrite.kind !== "register" || drainWrite.op !== "set") throw new Error("failure state write missing");
		expect((drainWrite.value as unknown as RunState).phase).toEqual({
			kind: "failure_drain",
			error,
			provenance: { kind: "response", entryId: fixture.reservedResponse },
		});
		expect((drainWrite.value as unknown as RunState).latestAssistantEntryId).toBe(fixture.reservedResponse);
		expect(ids).not.toHaveBeenCalled();
		expect(lease).not.toHaveBeenCalled();
		await shell.close();

		const terminalStorage = instrumentStorage(state.createStorage());
		const terminalModels = createModels();
		const terminalLease = vi.spyOn(terminalModels, "lease");
		const terminalShell = await createRuntimeShell(session(terminalStorage), config(), { models: terminalModels });
		expect(await terminalShell.peekAction()).toEqual({
			kind: "finish_failed_run",
			operationId: fixture.operationId,
			responseEntryId: fixture.reservedResponse,
		});
		expect(terminalStorage.committedTransactions).toEqual([]);
		await terminalShell.executeAction();
		expect(terminalStorage.committedTransactions[0].writes).toEqual([
			{ kind: "register", op: "delete", namespace: "op.meta", key: fixture.operationId },
			{ kind: "register", op: "delete", namespace: "op.state", key: fixture.operationId },
			{
				kind: "register",
				op: "set",
				namespace: "lane.lastResult",
				key: "main",
				value: {
					operationId: fixture.operationId,
					kind: "run",
					outcome: "failed",
					leafId: fixture.reservedResponse,
					finalAssistantEntryId: fixture.reservedResponse,
					error,
				},
			},
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: {
					currentOperationId: null,
					pendingNextRun: [],
				},
			},
		]);
		expect(await terminalShell.peekAction()).toBeUndefined();
		expect(terminalLease).not.toHaveBeenCalled();
		await terminalShell.close();
		clock.mockRestore();
	});

	it.each([
		["exponential", 1_000, 2, 7, 1_014],
		["saturated", Number.MAX_SAFE_INTEGER - 5, 2, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	] as const)(
		"computes the exact %s retry deadline in the Session transition",
		async (_label, now, attempt, baseDelayMs, deadline) => {
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			const fixture = await rooted("pending", new MemoryStorage(), {}, undefined, {
				attempt,
				maxAttempts: 3,
				baseDelayMs,
			});
			const instrumented = instrumentStorage(fixture.storage);
			const runtimeSession = session(instrumented);
			const operationState = (await fixture.storage.getRegister("op.state", fixture.operationId))!;
			const laneState = (await fixture.storage.getRegister("lane.state", "main"))!;
			const result = await runtimeSession.recoverAssistantEffect({
				operationId: fixture.operationId,
				stepId: fixture.stepId,
				attempt,
				responseEntryId: fixture.reservedResponse,
				usageId: fixture.reservedUsage,
				expectedOperationStateSeq: operationState.seq,
				expectedLaneStateSeq: laneState.seq,
			});
			expect(result.status).toBe("committed");
			const phase = result.attachment.runState?.value.phase;
			expect(phase?.kind === "assistant" ? phase.generation : undefined).toEqual(
				expect.objectContaining({
					status: "retry_wait",
					nextAttempt: 3,
					notBefore: deadline,
				}),
			);
			expect(instrumented.committedTransactions).toHaveLength(1);
			await runtimeSession.close();
			clock.mockRestore();
		},
	);

	it("makes mismatched recovery and retry-release proofs obsolete and commits each exact proof once", async () => {
		const fixture = await rooted("pending", new MemoryStorage(), {}, undefined, {
			attempt: 1,
			maxAttempts: 3,
			baseDelayMs: 10,
		});
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const operationState = (await fixture.storage.getRegister("op.state", fixture.operationId))!;
		const laneState = (await fixture.storage.getRegister("lane.state", "main"))!;
		const exactRecovery = {
			operationId: fixture.operationId,
			stepId: fixture.stepId,
			attempt: 1,
			responseEntryId: fixture.reservedResponse,
			usageId: fixture.reservedUsage,
			expectedOperationStateSeq: operationState.seq,
			expectedLaneStateSeq: laneState.seq,
		};
		for (const transition of [
			{
				...exactRecovery,
				operationId: id(),
			},
			{
				...exactRecovery,
				stepId: id(),
			},
			{
				...exactRecovery,
				attempt: 2,
			},
			{
				...exactRecovery,
				responseEntryId: id(),
			},
			{ ...exactRecovery, expectedOperationStateSeq: exactRecovery.expectedOperationStateSeq + 1 },
			{ ...exactRecovery, expectedLaneStateSeq: exactRecovery.expectedLaneStateSeq + 1 },
		])
			expect(await runtimeSession.recoverAssistantEffect(transition)).toMatchObject({ status: "obsolete" });
		expect(instrumented.committedTransactions).toEqual([]);
		const recovered = await runtimeSession.recoverAssistantEffect(exactRecovery);
		const generation = recovered.attachment.runState?.value.phase;
		if (generation?.kind !== "assistant" || generation.generation.status !== "retry_wait")
			throw new Error("wait missing");
		const exact = {
			operationId: fixture.operationId,
			stepId: fixture.stepId,
			nextAttempt: 2,
			notBefore: generation.generation.notBefore,
			expectedOperationStateSeq: recovered.attachment.runState!.seq,
			expectedLaneStateSeq: recovered.attachment.laneState.seq,
		};
		for (const wrong of [
			{ ...exact, operationId: id() },
			{ ...exact, stepId: id() },
			{ ...exact, nextAttempt: 3 },
			{ ...exact, notBefore: exact.notBefore + 1 },
			{ ...exact, expectedOperationStateSeq: exact.expectedOperationStateSeq + 1 },
			{ ...exact, expectedLaneStateSeq: exact.expectedLaneStateSeq + 1 },
		])
			expect(await runtimeSession.releaseAssistantRetry(wrong)).toMatchObject({ status: "obsolete" });
		expect(instrumented.committedTransactions).toHaveLength(1);
		expect(await runtimeSession.releaseAssistantRetry(exact)).toMatchObject({ status: "committed" });
		expect(await runtimeSession.releaseAssistantRetry(exact)).toMatchObject({ status: "obsolete" });
		expect(instrumented.committedTransactions).toHaveLength(2);
		await runtimeSession.close();
	});

	it("rejects stale recovery after identical operation and lane state rewrites", async () => {
		const fixture = await rooted("pending");
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		expect(await shell.peekAction()).toMatchObject({ kind: "recover_assistant_effect" });
		const operationState = (await fixture.storage.getRegister("op.state", fixture.operationId))!;
		const laneState = (await fixture.storage.getRegister("lane.state", "main"))!;
		await fixture.storage.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: fixture.operationId,
					value: operationState.value,
				},
				{ kind: "register", op: "set", namespace: "lane.state", key: "main", value: laneState.value },
			],
		});

		await expect(shell.executeAction()).rejects.toMatchObject({ code: "stale" });
		expect(instrumented.committedTransactions).toEqual([]);
		const current = (await fixture.storage.getRegister("op.state", fixture.operationId))!
			.value as unknown as RunState;
		expect(current.phase).toMatchObject({
			kind: "assistant",
			generation: { status: "effect_pending" },
		});
		await shell.close();
	});

	it("returns undefined for idle peek and execute without writing", async () => {
		const fixture = await rooted("idle");
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		expect(await shell.peekAction()).toBeUndefined();
		expect(await shell.executeAction()).toBeUndefined();
		expect(instrumented.committedTransactions).toHaveLength(1); // config seed only
		await shell.close();
	});

	it("treats an atomically deleted old operation plus idle lane as stale, not corruption", async () => {
		const fixture = await rooted();
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		const before = instrumented.committedTransactions.length;
		await fixture.storage.commit({
			writes: [
				{ kind: "register", op: "delete", namespace: "op.meta", key: fixture.operationId },
				{ kind: "register", op: "delete", namespace: "op.state", key: fixture.operationId },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			],
		});
		await expect(shell.executeAction()).rejects.toMatchObject({ code: "stale" });
		expect(instrumented.committedTransactions).toHaveLength(before);
		await shell.close();
	});

	it("replans a canonically unchanged operation after its sequence becomes stale", async () => {
		const fixture = await rooted();
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		const current = await fixture.storage.getRegister("op.state", fixture.operationId);
		await fixture.storage.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "op.state", key: fixture.operationId, value: current!.value },
			],
		});
		const before = instrumented.committedTransactions.length;
		await expect(shell.executeAction()).rejects.toMatchObject({ code: "stale" });
		expect(instrumented.committedTransactions).toHaveLength(before);
		expect(await shell.peekAction()).toMatchObject({
			kind: "start_assistant_step",
			operationId: fixture.operationId,
		});
		await shell.close();
	});

	it("rejects a changed rooted closure before minting or committing a shell transition", async () => {
		const fixture = await rooted();
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const next = vi.spyOn(runtimeSession.idGenerator, "next");
		const shell = await createRuntimeShell(runtimeSession, config());
		await expect(shell.peekAction()).resolves.toMatchObject({ kind: "start_assistant_step" });

		await instrumented.commit({
			writes: [{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: fixture.source }],
		});
		const commitsAfterExternalMutation = instrumented.committedTransactions.length;

		await expect(shell.executeAction()).rejects.toMatchObject({ code: "corruption" });
		expect(instrumented.committedTransactions).toHaveLength(commitsAfterExternalMutation);
		expect(next).not.toHaveBeenCalled();
		await shell.close();
	});

	it("replans a canonically unchanged lane after its sequence becomes stale", async () => {
		const fixture = await rooted();
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		const current = await fixture.storage.getRegister("lane.state", "main");
		await fixture.storage.commit({
			writes: [{ kind: "register", op: "set", namespace: "lane.state", key: "main", value: current!.value }],
		});
		const before = instrumented.committedTransactions.length;
		await expect(shell.executeAction()).rejects.toMatchObject({ code: "stale" });
		expect(instrumented.committedTransactions).toHaveLength(before);
		expect(await shell.peekAction()).toMatchObject({
			kind: "start_assistant_step",
			operationId: fixture.operationId,
		});
		await shell.close();
	});

	it("captures the authoritative configuration after a stale configuration replan", async () => {
		const fixture = await rooted();
		const shell = await createRuntimeShell(session(fixture.storage), config());
		const replacement: LaneConfiguration = { ...config(), model: { provider: "test", modelId: "replacement" } };
		await fixture.storage.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "lane.config",
					key: "main",
					value: replacement as unknown as JsonValue,
				},
			],
		});
		await expect(shell.executeAction()).rejects.toMatchObject({ code: "stale" });
		expect(await shell.executeAction()).toMatchObject({ kind: "start_assistant_step" });
		const state = (await fixture.storage.getRegister("op.state", fixture.operationId))!.value as Record<
			string,
			JsonValue
		>;
		const phase = state.phase as Record<string, JsonValue>;
		const generation = phase.generation as Record<string, JsonValue>;
		const context = generation.context as Record<string, JsonValue>;
		expect(context.configuration).toEqual(replacement);
		await shell.close();
	});

	it("lets an admitted execute commit before close completes", async () => {
		const fixture = await rooted();
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		const original = instrumented.getRegister.bind(instrumented);
		let release!: () => void;
		let markEntered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		let gate = true;
		instrumented.getRegister = async (namespace, key) => {
			if (gate && namespace === "lane.config" && key === "main") {
				gate = false;
				markEntered();
				await blocked;
			}
			return original(namespace, key);
		};
		const execute = shell.executeAction();
		await entered;
		const close = shell.close();
		expect(instrumented.committedTransactions).toHaveLength(0);
		release();
		await expect(execute).resolves.toMatchObject({ kind: "start_assistant_step" });
		await close;
		expect(instrumented.committedTransactions).toHaveLength(1);
		expect(instrumented.committedTransactions[0].writes).toEqual([
			expect.objectContaining({ namespace: "op.state", key: fixture.operationId }),
		]);
	});

	it("lets an admitted assistant preparation commit before close drains", async () => {
		const fixture = await rooted("ready");
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		vi.spyOn(runtimeSession.idGenerator, "next").mockReturnValueOnce(id()).mockReturnValueOnce(id());
		const { models } = availableModels();
		const shell = await createRuntimeShell(runtimeSession, config(), { models });
		const original = instrumented.getRegister.bind(instrumented);
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const insideSession = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let gate = true;
		instrumented.getRegister = async (namespace, key) => {
			if (gate && namespace === "lane.config" && key === "main") {
				gate = false;
				entered();
				await blocked;
			}
			return original(namespace, key);
		};
		const execute = shell.executeAction();
		await insideSession;
		const close = shell.close();
		release();
		await expect(execute).resolves.toMatchObject({ kind: "prepare_assistant_effect" });
		await close;
		expect(instrumented.committedTransactions).toHaveLength(1);
		expect(instrumented.committedTransactions[0].writes).toEqual([
			expect.objectContaining({ namespace: "op.state", key: fixture.operationId }),
		]);
	});

	it("rejects a queued dispatch when close seals behind a blocked admitted preparation", async () => {
		const state = new MemoryStorageState();
		const fixture = await rooted("ready", state.createStorage());
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		vi.spyOn(runtimeSession.idGenerator, "next").mockReturnValueOnce(id()).mockReturnValueOnce(id());
		const { models, lease } = availableModels();
		const shell = await createRuntimeShell(runtimeSession, config(), { models });
		const original = instrumented.getRegister.bind(instrumented);
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const insideSession = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let gate = true;
		instrumented.getRegister = async (namespace, key) => {
			if (gate && namespace === "lane.config" && key === "main") {
				gate = false;
				entered();
				await blocked;
			}
			return original(namespace, key);
		};
		const preparation = shell.executeAction();
		await insideSession;
		const dispatch = shell.executeAction();
		const close = shell.close();
		release();
		await expect(preparation).resolves.toMatchObject({ kind: "prepare_assistant_effect" });
		await expect(dispatch).rejects.toMatchObject({ code: "closed" });
		await close;
		expect(lease.streamSimple).not.toHaveBeenCalled();
		expect(instrumented.committedTransactions).toHaveLength(1);
		expect(instrumented.committedTransactions[0].writes).toEqual([
			expect.objectContaining({ namespace: "op.state", key: fixture.operationId }),
		]);
		await expectUncertainReopen(state);
	});

	it("lets an admitted prompt finish while close drains it", async () => {
		const fixture = await rooted("idle");
		const instrumented = instrumentStorage(fixture.storage);
		const { models } = availableModels();
		const shell = await createRuntimeShell(session(instrumented), config(), { models });
		const original = instrumented.getRegister.bind(instrumented);
		let release!: () => void;
		let markEntered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve;
		});
		let gate = true;
		instrumented.getRegister = async (namespace, key) => {
			if (gate && namespace === "lane.config" && key === "main") {
				gate = false;
				markEntered();
				await blocked;
			}
			return original(namespace, key);
		};
		const prompt = shell.prompt(user("admitted"));
		await entered;
		const close = shell.close();
		release();
		await expect(prompt).resolves.toMatchObject({ runState: { value: { phase: { kind: "checkpoint" } } } });
		await close;
		expect(instrumented.committedTransactions).toHaveLength(2);
	});

	it("reopens an accepted run from bounded exact records without scans", async () => {
		const state = new MemoryStorageState();
		const firstStorage = state.createStorage();
		await firstStorage.commit({
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
		const firstSession = session(firstStorage);
		const operationId = id();
		const promptId = id();
		vi.spyOn(firstSession.idGenerator, "next").mockReturnValueOnce(operationId).mockReturnValueOnce(promptId);
		const { models } = availableModels();
		const firstShell = await createRuntimeShell(firstSession, config(), { models });
		await firstShell.prompt(user("persisted"));
		await firstShell.close();

		const secondStorage = state.createStorage();
		const entryLookups: string[][] = [];
		const usageLookups: string[][] = [];
		const originalEntries = secondStorage.getEntries.bind(secondStorage);
		const originalUsage = secondStorage.getUsageRows.bind(secondStorage);
		secondStorage.getEntries = async (ids) => {
			entryLookups.push([...ids]);
			return originalEntries(ids);
		};
		secondStorage.getUsageRows = async (ids) => {
			usageLookups.push([...ids]);
			return originalUsage(ids);
		};
		secondStorage.listRegisters = async () => {
			throw new Error("register scan forbidden");
		};
		secondStorage.scanEntries = async () => {
			throw new Error("entry scan forbidden");
		};
		secondStorage.scanBranch = async () => {
			throw new Error("branch scan forbidden");
		};
		secondStorage.scanBranchStructure = async () => {
			throw new Error("branch structure scan forbidden");
		};
		secondStorage.getStats = async () => {
			throw new Error("usage scan forbidden");
		};
		const reopened = await createRuntimeShell(session(secondStorage), config(), { models });
		expect(entryLookups).toEqual([[promptId]]);
		expect(usageLookups).toEqual([[]]);
		expect(await reopened.peekAction()).toMatchObject({ kind: "start_assistant_step", operationId });
		await reopened.close();
	});

	it("closes and reopens a durable ready assistant without preparation or provider activity", async () => {
		const state = new MemoryStorageState();
		const fixture = await rooted("ready", state.createStorage());
		const firstStorage = instrumentStorage(fixture.storage);
		const firstModels = createModels();
		const firstLease = vi.spyOn(firstModels, "lease");
		const firstShell = await createRuntimeShell(session(firstStorage), config(), { models: firstModels });
		expect(await firstShell.peekAction()).toMatchObject({
			kind: "prepare_assistant_effect",
			operationId: fixture.operationId,
		});
		expect(firstLease).not.toHaveBeenCalled();
		const writesBeforeClose = firstStorage.committedTransactions.length;
		await firstShell.close();
		expect(firstStorage.committedTransactions).toHaveLength(writesBeforeClose);

		const reopenedStorage = instrumentStorage(state.createStorage());
		const reopenedModels = createModels();
		const reopenedLease = vi.spyOn(reopenedModels, "lease");
		const reopened = await createRuntimeShell(session(reopenedStorage), config(), { models: reopenedModels });
		expect(await reopened.peekAction()).toMatchObject({
			kind: "prepare_assistant_effect",
			operationId: fixture.operationId,
		});
		expect(reopenedLease).not.toHaveBeenCalled();
		expect(reopenedStorage.committedTransactions).toHaveLength(0);
		await reopened.close();
		expect(reopenedStorage.committedTransactions).toHaveLength(0);
	});

	it("closes and reopens matching materialized assistant reservations using bounded exact hydration", async () => {
		const state = new MemoryStorageState();
		const fixture = await rooted("pending", state.createStorage());
		const operationState = (await fixture.storage.getRegister("op.state", fixture.operationId))!;
		const generation = ((operationState.value as Record<string, JsonValue>).phase as Record<string, JsonValue>)
			.generation as Record<string, JsonValue>;
		const responseEntryId = generation.responseEntryId as string;
		const usageId = generation.usageId as string;
		const message = terminal();
		await fixture.storage.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: responseEntryId,
						parentId: fixture.prompt,
						type: "message",
						payload: json(message),
					},
				},
				{
					kind: "usage",
					row: { id: usageId, entryId: responseEntryId, adjustment: false, usage: message.usage },
				},
			],
		});
		const firstStorage = instrumentStorage(fixture.storage);
		const firstModels = createModels();
		const firstLease = vi.spyOn(firstModels, "lease");
		const firstShell = await createRuntimeShell(session(firstStorage), config(), { models: firstModels });
		const expectedAction = {
			kind: "repair_materialized_assistant",
			operationId: fixture.operationId,
			responseEntryId,
			usageId,
		};
		expect(await firstShell.peekAction()).toEqual(expectedAction);
		expect(firstLease).not.toHaveBeenCalled();
		const writesBeforeClose = firstStorage.committedTransactions.length;
		await firstShell.close();
		expect(firstStorage.committedTransactions).toHaveLength(writesBeforeClose);

		const reopenedStorage = state.createStorage();
		const entryLookups: string[][] = [];
		const usageLookups: string[][] = [];
		const getEntries = reopenedStorage.getEntries.bind(reopenedStorage);
		const getUsageRows = reopenedStorage.getUsageRows.bind(reopenedStorage);
		reopenedStorage.getEntries = async (ids) => {
			entryLookups.push([...ids]);
			return getEntries(ids);
		};
		reopenedStorage.getUsageRows = async (ids) => {
			usageLookups.push([...ids]);
			return getUsageRows(ids);
		};
		reopenedStorage.listRegisters = async () => {
			throw new Error("register scan forbidden");
		};
		reopenedStorage.scanEntries = async () => {
			throw new Error("entry scan forbidden");
		};
		reopenedStorage.scanBranch = async () => {
			throw new Error("branch scan forbidden");
		};
		reopenedStorage.scanBranchStructure = async () => {
			throw new Error("branch structure scan forbidden");
		};
		reopenedStorage.getStats = async () => {
			throw new Error("usage scan forbidden");
		};
		const reopenedModels = createModels();
		const reopenedLease = vi.spyOn(reopenedModels, "lease");
		const reopened = await createRuntimeShell(session(reopenedStorage), config(), { models: reopenedModels });
		expect(entryLookups).toHaveLength(1);
		expect(entryLookups[0]).toHaveLength(4);
		expect(entryLookups[0]).toContain(responseEntryId);
		expect(usageLookups).toEqual([[responseEntryId, usageId]]);
		expect(await reopened.peekAction()).toEqual(expectedAction);
		expect(reopenedLease).not.toHaveBeenCalled();
		await reopened.close();
	});

	it("reopens a pending assistant without a live plan or model lookup using exact hydration only", async () => {
		const state = new MemoryStorageState();
		const firstStorage = state.createStorage();
		const fixture = await rooted("ready");
		const seeded = await fixture.storage.getRegister("lane.config", "main");
		const sourceEntry = (await fixture.storage.getEntries([fixture.source])).get(fixture.source)!;
		const promptEntry = (await fixture.storage.getEntries([fixture.prompt])).get(fixture.prompt)!;
		const laneLeaf = await fixture.storage.getRegister("lane.leaf", "main");
		const laneState = await fixture.storage.getRegister("lane.state", "main");
		const operation = await fixture.storage.getRegister("op.meta", fixture.operationId);
		const runState = await fixture.storage.getRegister("op.state", fixture.operationId);
		await firstStorage.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: sourceEntry.id,
						parentId: sourceEntry.parentId,
						type: sourceEntry.type,
						payload: sourceEntry.payload,
					},
				},
				{
					kind: "entry",
					entry: {
						id: promptEntry.id,
						parentId: promptEntry.parentId,
						type: promptEntry.type,
						payload: promptEntry.payload,
					},
				},
				{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: seeded!.value },
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: laneLeaf!.value },
				{ kind: "register", op: "set", namespace: "lane.state", key: "main", value: laneState!.value },
				{ kind: "register", op: "set", namespace: "op.meta", key: fixture.operationId, value: operation!.value },
				{ kind: "register", op: "set", namespace: "op.state", key: fixture.operationId, value: runState!.value },
			],
		});
		const firstSession = session(firstStorage);
		vi.spyOn(firstSession.idGenerator, "next").mockReturnValueOnce(id()).mockReturnValueOnce(id());
		const { models } = availableModels();
		const firstShell = await createRuntimeShell(firstSession, config(), { models });
		await firstShell.executeAction();
		expect(await firstShell.peekAction()).toMatchObject({ kind: "dispatch_assistant_effect" });
		await firstShell.close();

		const reopenedStorage = state.createStorage();
		const entryLookups: string[][] = [];
		const usageLookups: string[][] = [];
		const getEntries = reopenedStorage.getEntries.bind(reopenedStorage);
		const getUsageRows = reopenedStorage.getUsageRows.bind(reopenedStorage);
		reopenedStorage.getEntries = async (ids) => {
			entryLookups.push([...ids]);
			return getEntries(ids);
		};
		reopenedStorage.getUsageRows = async (ids) => {
			usageLookups.push([...ids]);
			return getUsageRows(ids);
		};
		reopenedStorage.listRegisters = async () => {
			throw new Error("register scan forbidden");
		};
		reopenedStorage.scanEntries = async () => {
			throw new Error("entry scan forbidden");
		};
		reopenedStorage.scanBranch = async () => {
			throw new Error("branch scan forbidden");
		};
		reopenedStorage.scanBranchStructure = async () => {
			throw new Error("branch structure scan forbidden");
		};
		reopenedStorage.getStats = async () => {
			throw new Error("usage scan forbidden");
		};
		const reopenedModels = createModels();
		const lease = vi.spyOn(reopenedModels, "lease");
		const reopened = await createRuntimeShell(session(reopenedStorage), config(), { models: reopenedModels });
		expect(entryLookups).toHaveLength(1);
		expect(usageLookups).toHaveLength(1);
		expect(lease).not.toHaveBeenCalled();
		expect(await reopened.peekAction()).toMatchObject({ kind: "recover_assistant_effect" });
		await expect(reopened.executeAction()).resolves.toMatchObject({ kind: "recover_assistant_effect" });
		expect(lease).not.toHaveBeenCalled();
		await reopened.close();
	});

	it("does not scan history while peeking or executing", async () => {
		const fixture = await rooted();
		fixture.storage.scanBranch = async () => {
			throw new Error("unexpected branch scan");
		};
		fixture.storage.scanBranchStructure = async () => {
			throw new Error("unexpected branch structure scan");
		};
		fixture.storage.scanEntries = async () => {
			throw new Error("unexpected entry scan");
		};
		const shell = await createRuntimeShell(session(fixture.storage), config());
		await expect(shell.peekAction()).resolves.toMatchObject({ kind: "start_assistant_step" });
		await expect(shell.executeAction()).resolves.toMatchObject({ kind: "start_assistant_step" });
		await shell.close();
	});

	it("dispatches the retained lease once with retained context/options and a harness signal", async () => {
		let resolve!: (message: AssistantMessage) => void;
		const result = new Promise<AssistantMessage>((done) => {
			resolve = done;
		});
		const prepared = await preparedShell(() => result);
		const projection = prepared.projection;
		const durableOptionsBefore = structuredClone(prepared.durableOptions);
		const beforeDispatch = prepared.instrumented.committedTransactions.length;
		const dispatch = prepared.shell.executeAction();
		await expect(dispatch).resolves.toMatchObject({ kind: "dispatch_assistant_effect" });
		expect(prepared.streamSimple).toHaveBeenCalledTimes(1);
		expect(prepared.leaseSpy).toHaveBeenCalledTimes(1);
		const [context, options] = prepared.streamSimple.mock.calls[0] as [Context, Record<string, unknown>];
		expect(projection).toHaveBeenCalledTimes(1);
		expect(context).toEqual({ messages: [user("source"), user("prompt")] });
		expect(context.messages).not.toBe(await projection.mock.results[0].value);
		expect(options).toEqual({
			headers: { retained: "yes" },
			metadata: { nested: [1] },
			reasoning: "medium",
			signal: expect.any(AbortSignal),
		});
		expect(Reflect.ownKeys(options).sort()).toEqual(["headers", "metadata", "reasoning", "signal"].sort());
		expect(prepared.durableOptions).toEqual(durableOptionsBefore);
		expect(prepared.instrumented.committedTransactions).toHaveLength(beforeDispatch);
		expect(await prepared.shell.peekAction()).toMatchObject({ kind: "await_assistant_effect" });
		resolve(terminal());
		await expect(prepared.shell.executeAction()).resolves.toMatchObject({ kind: "await_assistant_effect" });
		expect(projection).toHaveBeenCalledTimes(1);
		expect(await prepared.shell.peekAction()).toMatchObject({ kind: "settle_assistant_effect" });
		await expect(prepared.shell.executeAction()).resolves.toMatchObject({ kind: "settle_assistant_effect" });
		expect(prepared.instrumented.committedTransactions).toHaveLength(beforeDispatch + 1);
		expect(prepared.leaseSpy).toHaveBeenCalledTimes(1);
		await prepared.shell.close();
	});

	it("installs running before synchronous provider entry and serializes concurrent dispatch", async () => {
		const prepared = await preparedShell(() => new Promise<AssistantMessage>(() => undefined));
		let reentrantPeek!: Promise<unknown>;
		let reentrantExecute!: Promise<unknown>;
		prepared.streamSimple.mockImplementationOnce(() => {
			reentrantPeek = prepared.shell.peekAction();
			reentrantExecute = prepared.shell.executeAction();
			return { result: () => new Promise<AssistantMessage>(() => undefined) } as ReturnType<
				typeof prepared.lease.streamSimple
			>;
		});
		const first = prepared.shell.executeAction();
		const second = prepared.shell.executeAction();
		await expect(first).resolves.toMatchObject({ kind: "dispatch_assistant_effect" });
		expect(prepared.streamSimple).toHaveBeenCalledTimes(1);
		await prepared.shell.close();
		await expect(second).rejects.toMatchObject({ code: "closed" });
		await expect(reentrantPeek).resolves.toMatchObject({ kind: "await_assistant_effect" });
		await expect(reentrantExecute).rejects.toMatchObject({ code: "closed" });
	});

	it.each(["stop", "length", "toolUse", "deferred", "error", "aborted"] as const)(
		"accepts and detaches terminal %s results",
		async (stopReason) => {
			const providerMessage = terminal(stopReason);
			const prepared = await preparedShell(() => providerMessage);
			await prepared.shell.executeAction();
			const awaitResult = prepared.shell.executeAction();
			providerMessage.content[0] = { type: "text", text: "provider mutation" };
			await expect(awaitResult).resolves.toMatchObject({ kind: "await_assistant_effect" });
			expect(await prepared.shell.peekAction()).toMatchObject({ kind: "settle_assistant_effect" });
			expect(providerMessage.responseId).toBe("upstream-response");
			await prepared.shell.close();
		},
	);

	it.each([
		["pending", terminal("pending")],
		["wrong provider", { ...terminal(), provider: "other" }],
		["wrong model", { ...terminal(), model: "other" }],
		["malformed", { ...terminal(), role: "user" }],
	] as const)("faults and seals on %s results", async (_name, message) => {
		const prepared = await preparedShell(() => message as AssistantMessage);
		await prepared.shell.executeAction();
		const fault = await prepared.shell.executeAction().catch((error: unknown) => error);
		expect(fault).toMatchObject({ code: "fault" });
		await expect(prepared.shell.peekAction()).rejects.toBe(fault);
		await expect(prepared.shell.executeAction()).rejects.toBe(fault);
		await expect(prepared.shell.prompt(user("later"))).rejects.toBe(fault);
		await prepared.shell.close();
	});

	it.each(["stream", "result"] as const)(
		"aborts and preserves the original synchronous %s throw, then reopens uncertain",
		async (kind) => {
			const cause = new Error(`${kind} failed`);
			const prepared = await preparedShell(() => {
				throw cause;
			});
			if (kind === "stream")
				prepared.streamSimple.mockImplementationOnce(() => {
					throw cause;
				});
			const fault = await prepared.shell.executeAction().catch((error: unknown) => error);
			expect(fault).toMatchObject({ code: "fault", cause });
			const signal = prepared.streamSimple.mock.calls[0]?.[1]?.signal;
			expect(signal?.aborted).toBe(true);
			await expect(prepared.shell.peekAction()).rejects.toBe(fault);
			await expect(prepared.shell.executeAction()).rejects.toBe(fault);
			const writes = prepared.instrumented.committedTransactions.length;
			await prepared.shell.close();
			expect(prepared.instrumented.committedTransactions).toHaveLength(writes);
			await expectUncertainReopen(prepared.state);
		},
	);

	it.each(["stream", "result"] as const)(
		"prefers reentrant close over a synchronous %s throw and reopens uncertain",
		async (kind) => {
			const cause = new Error(`${kind} failed after close`);
			const prepared = await preparedShell(() => {
				close = prepared.shell.close();
				throw cause;
			});
			let close!: Promise<void>;
			if (kind === "stream")
				prepared.streamSimple.mockImplementationOnce(() => {
					close = prepared.shell.close();
					throw cause;
				});
			const writesAfterIntent = prepared.instrumented.committedTransactions.length;
			expect(writesAfterIntent).toBe(1);
			await expect(prepared.shell.executeAction()).rejects.toMatchObject({ code: "closed" });
			expect(prepared.streamSimple).toHaveBeenCalledTimes(1);
			expect(prepared.leaseSpy).toHaveBeenCalledTimes(1);
			expect(prepared.streamSimple.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
			expect(prepared.instrumented.committedTransactions).toHaveLength(writesAfterIntent);
			await close;
			await expect(prepared.shell.peekAction()).rejects.toMatchObject({ code: "closed" });
			await expect(prepared.shell.executeAction()).rejects.toMatchObject({ code: "closed" });
			await expect(prepared.shell.prompt(user("later"))).rejects.toMatchObject({ code: "closed" });
			expect(prepared.leaseSpy).toHaveBeenCalledTimes(1);
			expect(prepared.instrumented.committedTransactions).toHaveLength(writesAfterIntent);
			await expectUncertainReopen(prepared.state);
		},
	);

	it("observes asynchronous rejection immediately and rejects a pending await with the same fault", async () => {
		let reject!: (cause: unknown) => void;
		const result = new Promise<AssistantMessage>((_resolve, fail) => {
			reject = fail;
		});
		const cause = new Error("async result failed");
		const prepared = await preparedShell(() => result);
		await prepared.shell.executeAction();
		const awaiting = prepared.shell.executeAction();
		reject(cause);
		await Promise.resolve();
		const fault = await awaiting.catch((error: unknown) => error);
		expect(fault).toMatchObject({ code: "fault", cause });
		expect(prepared.streamSimple.mock.calls[0][1]?.signal?.aborted).toBe(true);
		await expect(prepared.shell.peekAction()).rejects.toBe(fault);
		const writes = prepared.instrumented.committedTransactions.length;
		await prepared.shell.close();
		expect(prepared.instrumented.committedTransactions).toHaveLength(writes);
		await expectUncertainReopen(prepared.state);
	});

	it("faults immediately on an observed asynchronous rejection without a manual await", async () => {
		let reject!: (cause: unknown) => void;
		const result = new Promise<AssistantMessage>((_resolve, fail) => {
			reject = fail;
		});
		const cause = new Error("unawaited async result failed");
		const prepared = await preparedShell(() => result);
		await prepared.shell.executeAction();
		reject(cause);
		await Promise.resolve();
		await Promise.resolve();
		await expect(prepared.shell.peekAction()).rejects.toMatchObject({ code: "fault", cause });
		await prepared.shell.close();
	});

	it("keeps late provider rejection after close observed, closed, and durably uncertain", async () => {
		let reject!: (cause: unknown) => void;
		const result = new Promise<AssistantMessage>((_resolve, fail) => {
			reject = fail;
		});
		const prepared = await preparedShell(() => result);
		await prepared.shell.executeAction();
		const signal = prepared.streamSimple.mock.calls[0][1]?.signal;
		const beforeClose = prepared.instrumented.committedTransactions.length;

		await prepared.shell.close();
		expect(signal?.aborted).toBe(true);
		expect(prepared.instrumented.committedTransactions).toHaveLength(beforeClose);

		const unhandled: unknown[] = [];
		const observeUnhandled = (cause: unknown) => unhandled.push(cause);
		process.on("unhandledRejection", observeUnhandled);
		try {
			reject(new Error("late provider rejection"));
			await Promise.resolve();
			await Promise.resolve();
			expect(unhandled).toEqual([]);
			await expect(prepared.shell.peekAction()).rejects.toMatchObject({ code: "closed" });
			await expect(prepared.shell.executeAction()).rejects.toMatchObject({ code: "closed" });
			await expect(prepared.shell.prompt(user("late"))).rejects.toMatchObject({ code: "closed" });
			expect(prepared.instrumented.committedTransactions).toHaveLength(beforeClose);
		} finally {
			process.off("unhandledRejection", observeUnhandled);
		}

		await expectUncertainReopen(prepared.state);
	});

	it("close after local provider settlement writes nothing and reopen treats the parked settlement as uncertain", async () => {
		let resolve!: (message: AssistantMessage) => void;
		const result = new Promise<AssistantMessage>((done) => {
			resolve = done;
		});
		const prepared = await preparedShell(() => result);
		await prepared.shell.executeAction();
		const awaiting = prepared.shell.executeAction();
		resolve(terminal());
		await expect(awaiting).resolves.toMatchObject({ kind: "await_assistant_effect" });
		expect(await prepared.shell.peekAction()).toMatchObject({ kind: "settle_assistant_effect" });
		const beforeClose = prepared.instrumented.committedTransactions.length;
		await prepared.shell.close();
		expect(prepared.instrumented.committedTransactions).toHaveLength(beforeClose);
		await expectUncertainReopen(prepared.state);
	});

	it("atomically settles a successful detached response and plans finish without registry or provider access", async () => {
		const message = terminal();
		const prepared = await preparedShell(() => message);
		const before = prepared.instrumented.committedTransactions.length;
		const stateBefore = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
		const generation = ((stateBefore.value as Record<string, JsonValue>).phase as Record<string, JsonValue>)
			.generation as Record<string, JsonValue>;
		const responseEntryId = generation.responseEntryId as string;
		const usageId = generation.usageId as string;
		const expectedState = {
			...(stateBefore.value as Record<string, JsonValue>),
			latestAssistantEntryId: responseEntryId,
			phase: {
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: responseEntryId,
			},
		};

		await expect(settlePrepared(prepared)).resolves.toMatchObject({ kind: "settle_assistant_effect" });
		expect(prepared.instrumented.committedTransactions).toHaveLength(before + 1);
		const writes = prepared.instrumented.committedTransactions.at(-1)!.writes;
		expect(writes).toEqual([
			{
				kind: "entry",
				entry: {
					id: responseEntryId,
					parentId: prepared.fixture.prompt,
					type: "message",
					payload: message,
				},
			},
			{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: responseEntryId },
			{
				kind: "usage",
				row: { id: usageId, entryId: responseEntryId, usage: message.usage, adjustment: false },
			},
			{
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: prepared.fixture.operationId,
				value: expectedState,
			},
		]);
		expect((await prepared.fixture.storage.getEntries([responseEntryId])).get(responseEntryId)?.payload).toEqual(
			message,
		);
		expect(await prepared.shell.peekAction()).toEqual({
			kind: "finish_run",
			operationId: prepared.fixture.operationId,
			triggerEntryId: responseEntryId,
		});
		expect(prepared.leaseSpy).toHaveBeenCalledTimes(1);
		expect(prepared.streamSimple).toHaveBeenCalledTimes(1);
		expect(prepared.lease.stream).not.toHaveBeenCalled();
		expect(prepared.lease.fetchDeferred).not.toHaveBeenCalled();
		expect(prepared.lease.cancelDeferred).not.toHaveBeenCalled();
		await prepared.shell.close();
	});

	it.each([
		["toolUse", 1],
		["toolUse", 2],
		["length", 1],
	] as const)(
		"atomically settles %s with %i ordered tool calls and parks at the first preparation",
		async (stopReason, callCount) => {
			const content: AssistantMessage["content"] = [
				{ type: "thinking", thinking: "plan", redacted: false },
				{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
				{ type: "text", text: "between" },
				...(callCount === 2
					? [{ type: "toolCall" as const, id: "call-b", name: "write", arguments: { path: "b" } }]
					: []),
			];
			const base = terminal(stopReason);
			const message = {
				...base,
				content,
				usage:
					stopReason === "length"
						? { ...base.usage, output: 4096, totalTokens: base.usage.input + 4096 }
						: base.usage,
			};
			const prepared = await preparedShell(() => message);
			vi.mocked(prepared.runtimeSession.idGenerator.next).mockRestore();
			const stateBefore = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
			const generation = (stateBefore.value as unknown as RunState).phase;
			if (generation.kind !== "assistant" || generation.generation.status !== "effect_pending")
				throw new Error("assistant reservation missing");
			const responseEntryId = generation.generation.responseEntryId;
			const usageId = generation.generation.usageId;
			const before = prepared.instrumented.committedTransactions.length;
			await settlePrepared(prepared);

			const transaction = prepared.instrumented.committedTransactions.at(-1)!;
			expect(prepared.instrumented.committedTransactions).toHaveLength(before + 1);
			expect(transaction.writes.map((write) => write.kind)).toEqual(["entry", "register", "usage", "register"]);
			const responseWrite = transaction.writes[0];
			const stateWrite = transaction.writes[3];
			if (responseWrite.kind !== "entry" || stateWrite.kind !== "register" || stateWrite.op !== "set")
				throw new Error("tool settlement writes malformed");
			const state = stateWrite.value as unknown as RunState;
			if (state.phase.kind !== "tools") throw new Error("tool plan missing");
			const calls = state.phase.batch.calls;
			expect(new Set(calls.map(({ resultEntryId }) => resultEntryId)).size).toBe(callCount);
			for (const call of calls) {
				expect(isUuidV7(call.resultEntryId)).toBe(true);
				expect(uuidV7Timestamp(call.resultEntryId)).toBe(uuidV7Timestamp(responseEntryId));
				expect(Reflect.ownKeys(call)).toEqual(["status", "sourceIndex", "resultEntryId"]);
			}
			const expectedState: RunState = {
				...(stateBefore.value as unknown as RunState),
				latestAssistantEntryId: responseEntryId,
				phase: {
					kind: "tools",
					batch: {
						assistantEntryId: responseEntryId,
						configuration: config(),
						turnId: prepared.fixture.stepId,
						calls: calls.map(({ resultEntryId }, sourceIndex) => ({
							status: "planned",
							sourceIndex,
							resultEntryId,
						})),
					},
				},
			};
			expect(transaction.writes).toEqual([
				{
					kind: "entry",
					entry: { id: responseEntryId, parentId: prepared.fixture.prompt, type: "message", payload: message },
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: responseEntryId },
				{
					kind: "usage",
					row: { id: usageId, entryId: responseEntryId, usage: message.usage, adjustment: false },
				},
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: prepared.fixture.operationId,
					value: expectedState,
				},
			]);
			expect(await prepared.fixture.storage.getRegister("lane.leaf", "main")).toMatchObject({
				value: responseWrite.entry.id,
			});
			expect(await prepared.shell.peekAction()).toEqual({
				kind: "prepare_tool_call",
				operationId: prepared.fixture.operationId,
				assistantEntryId: responseWrite.entry.id,
				sourceIndex: 0,
				resultEntryId: calls[0].resultEntryId,
			});
			expect(await prepared.fixture.storage.getEntries(calls.map(({ resultEntryId }) => resultEntryId))).toEqual(
				new Map(),
			);
			expect(await prepared.fixture.storage.getRegister("lane.state", "main")).toMatchObject({
				value: { currentOperationId: prepared.fixture.operationId },
			});
			expect(prepared.streamSimple).toHaveBeenCalledTimes(1);
			expect(prepared.lease.stream).not.toHaveBeenCalled();
			const writesBeforeClearance = prepared.instrumented.committedTransactions.length;
			for (let sourceIndex = 0; sourceIndex < callCount; sourceIndex++)
				await expect(prepared.shell.executeAction()).resolves.toMatchObject({
					kind: "prepare_tool_call",
					sourceIndex,
				});
			expect(prepared.instrumented.committedTransactions).toHaveLength(writesBeforeClearance + callCount);
			const results = await prepared.fixture.storage.getEntries(calls.map(({ resultEntryId }) => resultEntryId));
			for (const [sourceIndex, call] of calls.entries())
				expect(results.get(call.resultEntryId)?.payload).toMatchObject({
					role: "toolResult",
					toolCallId: sourceIndex === 0 ? "call-a" : "call-b",
					toolName: sourceIndex === 0 ? "read" : "write",
					isError: true,
					content: [{ type: "text", text: `Tool ${sourceIndex === 0 ? "read" : "write"} not found` }],
				});
			await prepared.shell.close();

			const reopenedStorage = instrumentStorage(prepared.state.createStorage());
			reopenedStorage.listRegisters = async () => {
				throw new Error("register scan forbidden");
			};
			reopenedStorage.scanEntries = async () => {
				throw new Error("entry scan forbidden");
			};
			reopenedStorage.scanBranch = async () => {
				throw new Error("branch scan forbidden");
			};
			reopenedStorage.scanBranchStructure = async () => {
				throw new Error("branch structure scan forbidden");
			};
			const models = createModels();
			const lease = vi.spyOn(models, "lease");
			const reopened = await createRuntimeShell(session(reopenedStorage), config(), { models });
			expect(await reopened.peekAction()).toEqual({
				kind: "start_assistant_step",
				operationId: prepared.fixture.operationId,
				triggerEntryId: calls.at(-1)!.resultEntryId,
			});
			expect(lease).not.toHaveBeenCalled();
			expect(reopenedStorage.committedTransactions).toEqual([]);
			await reopened.close();
		},
	);

	describe("D-027 sequential tool clearance", () => {
		it("rejects prompt admission with a missing active tool before IDs, writes, or callbacks", async () => {
			const fixture = await rooted("idle");
			const instrumented = instrumentStorage(fixture.storage);
			const runtimeSession = session(instrumented);
			const next = vi.spyOn(runtimeSession.idGenerator, "next");
			const context = vi.fn(() => ({ batch: "unused" }));
			const beforeToolCall = vi.fn();
			const { models, lease, leaseSpy } = availableModels();
			const shell = await createRuntimeShell(runtimeSession, config(["missing"]), {
				models,
				tools: [runtimeTool()],
				toolContext: context,
				beforeToolCall,
			});
			const before = instrumented.committedTransactions.length;
			await expect(shell.prompt(user("blocked"))).rejects.toMatchObject({ code: "unavailable" });
			expect(leaseSpy).toHaveBeenCalledExactlyOnceWith("test", "current");
			expectLeaseUnused(lease);
			expect(next).not.toHaveBeenCalled();
			expect(context).not.toHaveBeenCalled();
			expect(beforeToolCall).not.toHaveBeenCalled();
			expect(instrumented.committedTransactions).toHaveLength(before);
			await shell.close();
		});

		it("rejects duplicate tool definitions before attachment without reserving the session", async () => {
			const fixture = await rooted("idle");
			const instrumented = instrumentStorage(fixture.storage);
			const runtimeSession = session(instrumented);
			const before = instrumented.committedTransactions.length;
			await expect(
				createRuntimeShell(runtimeSession, config(), { tools: [runtimeTool(), runtimeTool()] }),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(instrumented.committedTransactions).toHaveLength(before);
			const shell = await createRuntimeShell(runtimeSession, config(), { tools: [runtimeTool()] });
			expect(await shell.peekAction()).toBeUndefined();
			await shell.close();
		});

		it("keeps a restored planned batch unavailable when its captured active definition is absent", async () => {
			const prepared = await settledToolBatch(toolMessage([{ id: "call-a" }]), {}, ["echo"]);
			await prepared.shell.close();
			const storage = instrumentStorage(prepared.state.createStorage());
			const context = vi.fn(() => ({ batch: "unused" }));
			const beforeToolCall = vi.fn();
			const reopened = await createRuntimeShell(session(storage), config(), {
				toolContext: context,
				beforeToolCall,
			});
			const before = storage.committedTransactions.length;
			await expect(reopened.executeAction()).rejects.toMatchObject({ code: "unavailable" });
			expect(context).not.toHaveBeenCalled();
			expect(beforeToolCall).not.toHaveBeenCalled();
			expect(storage.committedTransactions).toHaveLength(before);
			await reopened.close();
		});

		it.each(["never", "safe"] as const)(
			"persists detached prepared %s intent in exact order without execution",
			async (replay) => {
				const order: string[] = [];
				const execute = vi.fn();
				const source = runtimeTool({
					replay,
					prepareArguments: () => {
						order.push("prepareArguments");
						return { value: "prepared" };
					},
					execute,
				});
				const context = vi.fn(async () => {
					order.push("context");
					return { batch: "captured" };
				});
				const beforeToolCall = vi.fn(() => {
					order.push("before");
					return { args: { value: "effective" } };
				});
				const prepared = await settledToolBatch(
					toolMessage([{ id: "call-a" }]),
					{ tools: [source], toolContext: context, beforeToolCall },
					["echo"],
				);
				const commit = prepared.instrumented.commit.bind(prepared.instrumented);
				prepared.instrumented.commit = async (transaction) => {
					order.push("transaction");
					return commit(transaction);
				};
				const before = prepared.instrumented.committedTransactions.length;
				await prepared.shell.executeAction();
				expect(order).toEqual(["context", "prepareArguments", "before", "transaction"]);
				expect(context).toHaveBeenCalledTimes(1);
				expect(execute).not.toHaveBeenCalled();
				const transaction = prepared.instrumented.committedTransactions[before];
				const stateBefore = prepared.instrumented.committedTransactions[before - 1].writes.at(-1);
				if (stateBefore?.kind !== "register" || stateBefore.op !== "set")
					throw new Error("tool batch state missing");
				const batch = (stateBefore.value as unknown as RunState).phase;
				if (batch.kind !== "tools") throw new Error("tool batch missing");
				const argsKey = `${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`;
				expect(transaction.writes).toEqual([
					{ kind: "register", op: "set", namespace: "op.tool_args", key: argsKey, value: { value: "effective" } },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: prepared.fixture.operationId,
						value: expect.objectContaining({
							latestAssistantEntryId: batch.batch.assistantEntryId,
							phase: expect.objectContaining({
								kind: "tools",
								batch: expect.objectContaining({
									calls: [expect.objectContaining({ status: "effect_pending", sourceIndex: 0, replay })],
								}),
							}),
						}),
					},
				]);
				expect((await prepared.fixture.storage.getRegister("op.tool_args", argsKey))?.value).toEqual({
					value: "effective",
				});
				expect(await prepared.shell.peekAction()).toMatchObject({ kind: "dispatch_tool_effect" });
				await prepared.shell.close();

				const storage = instrumentStorage(prepared.state.createStorage());
				storage.listRegisters = async () => {
					throw new Error("register scan forbidden");
				};
				storage.scanEntries = async () => {
					throw new Error("entry scan forbidden");
				};
				storage.scanBranch = async () => {
					throw new Error("branch scan forbidden");
				};
				storage.scanBranchStructure = async () => {
					throw new Error("branch structure scan forbidden");
				};
				const reopened = await createRuntimeShell(session(storage), config());
				expect(await reopened.peekAction()).toBeUndefined();
				expect(storage.committedTransactions).toEqual([]);
				await reopened.close();
			},
		);

		it("resolves one async context for a two-call batch and preserves source identities and parents", async () => {
			const context = vi.fn(async () => ({ batch: "shared" }));
			const beforeToolCall = vi.fn(() => ({ block: { reason: "blocked" } }));
			const execute = vi.fn();
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }, { id: "call-b" }]),
				{ tools: [runtimeTool({ execute })], toolContext: context, beforeToolCall },
				["echo"],
			);
			const state = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
			const phase = (state.value as unknown as RunState).phase;
			if (phase.kind !== "tools") throw new Error("tool batch missing");
			const assistantEntryId = phase.batch.assistantEntryId;
			await prepared.shell.executeAction();
			expect(await prepared.shell.peekAction()).toMatchObject({ kind: "prepare_tool_call", sourceIndex: 1 });
			let current = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			if (current.phase.kind !== "tools") throw new Error("tool batch ended early");
			expect(current.latestAssistantEntryId).toBe(assistantEntryId);
			expect(current.phase.batch.calls.map(({ status }) => status)).toEqual(["completed", "planned"]);
			expect((await prepared.fixture.storage.getRegister("lane.leaf", "main"))?.value).toBe(
				phase.batch.calls[0].resultEntryId,
			);
			await prepared.shell.executeAction();
			expect(context).toHaveBeenCalledTimes(1);
			expect(beforeToolCall).toHaveBeenCalledTimes(2);
			expect(execute).not.toHaveBeenCalled();
			const entries = await prepared.fixture.storage.getEntries(phase.batch.calls.map((call) => call.resultEntryId));
			expect(entries.get(phase.batch.calls[0].resultEntryId)).toMatchObject({
				parentId: assistantEntryId,
				payload: { toolCallId: "call-a", toolName: "echo", isError: true },
			});
			expect(entries.get(phase.batch.calls[1].resultEntryId)).toMatchObject({
				parentId: phase.batch.calls[0].resultEntryId,
				payload: { toolCallId: "call-b", toolName: "echo", isError: true },
			});
			current = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(current.latestAssistantEntryId).toBe(assistantEntryId);
			expect(current.phase).toEqual({
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: phase.batch.calls[1].resultEntryId,
			});
			await prepared.shell.close();
		});

		it("reopens provider intent after final nonterminating clearance deletes canonical arguments in sorted order", async () => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }, { id: "call-b" }, { id: "call-c" }]),
				{
					tools: [runtimeTool()],
					toolContext: { batch: "static" },
					beforeToolCall: () => ({ block: { reason: "continue" } }),
				},
				["echo"],
			);
			const planned = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			if (planned.phase.kind !== "tools") throw new Error("tool batch missing");
			const { assistantEntryId, calls } = planned.phase.batch;
			await prepared.shell.executeAction();
			await prepared.shell.executeAction();
			const keys = [0, 1].map(
				(sourceIndex) => `${prepared.fixture.operationId}:${prepared.fixture.stepId}:${sourceIndex}`,
			);
			await prepared.fixture.storage.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "op.tool_args", key: keys[1], value: { value: "b" } },
					{ kind: "register", op: "set", namespace: "op.tool_args", key: keys[0], value: { value: "a" } },
				],
			});
			const before = prepared.instrumented.committedTransactions.length;
			await prepared.shell.executeAction();
			const transaction = prepared.instrumented.committedTransactions[before];
			const result = calls[2].resultEntryId;
			expect(transaction.writes).toEqual([
				expect.objectContaining({
					kind: "entry",
					entry: expect.objectContaining({ id: result, parentId: calls[1].resultEntryId }),
				}),
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: result },
				{ kind: "register", op: "delete", namespace: "op.tool_args", key: keys[0] },
				{ kind: "register", op: "delete", namespace: "op.tool_args", key: keys[1] },
				expect.objectContaining({
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: prepared.fixture.operationId,
				}),
			]);
			const checkpoint = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(checkpoint).toMatchObject({
				latestAssistantEntryId: assistantEntryId,
				phase: {
					kind: "checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: result,
				},
			});
			expect(await prepared.fixture.storage.getUsageRows([result])).toEqual(new Map());
			await prepared.shell.close();

			const reopenedStorage = instrumentStorage(prepared.state.createStorage());
			const scanEntries = reopenedStorage.scanEntries.bind(reopenedStorage);
			const scanBranch = reopenedStorage.scanBranch.bind(reopenedStorage);
			const scanBranchStructure = reopenedStorage.scanBranchStructure.bind(reopenedStorage);
			reopenedStorage.scanEntries = async () => {
				throw new Error("entry scan forbidden");
			};
			reopenedStorage.scanBranch = async () => {
				throw new Error("branch scan forbidden");
			};
			reopenedStorage.scanBranchStructure = async () => {
				throw new Error("branch structure scan forbidden");
			};
			const { models } = availableModels();
			const reopened = await createRuntimeShell(session(reopenedStorage), config(), { models });
			expect(await reopened.peekAction()).toEqual({
				kind: "start_assistant_step",
				operationId: prepared.fixture.operationId,
				triggerEntryId: result,
			});
			await reopened.executeAction();
			let state = (await reopenedStorage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state).toMatchObject({
				latestAssistantEntryId: assistantEntryId,
				phase: { kind: "assistant", generation: { status: "ready", context: { triggerEntryId: result } } },
			});
			reopenedStorage.scanEntries = scanEntries;
			reopenedStorage.scanBranch = scanBranch;
			reopenedStorage.scanBranchStructure = scanBranchStructure;
			await reopened.executeAction();
			state = (await reopenedStorage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state).toMatchObject({
				latestAssistantEntryId: assistantEntryId,
				phase: {
					kind: "assistant",
					generation: { status: "effect_pending", context: { triggerEntryId: result } },
				},
			});
			await reopened.close();
		});

		it.each(["wrong namespace", "noncanonical suffix"] as const)(
			"faults final cleanup scan validation write-free for %s",
			async (kind) => {
				const prepared = await settledToolBatch(
					toolMessage([{ id: "call-a" }, { id: "call-b" }]),
					{
						tools: [runtimeTool()],
						toolContext: { batch: "static" },
						beforeToolCall: () => ({ block: { reason: "continue" } }),
					},
					["echo"],
				);
				const planned = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
					.value as unknown as RunState;
				if (planned.phase.kind !== "tools") throw new Error("tool batch missing");
				const reserved = planned.phase.batch.calls[1].resultEntryId;
				await prepared.shell.executeAction();
				const listRegisters = prepared.instrumented.listRegisters.bind(prepared.instrumented);
				prepared.instrumented.listRegisters = async (namespace): Promise<Register[]> => {
					if (namespace !== "op.tool_args") return listRegisters(namespace);
					return [
						(kind === "wrong namespace"
							? {
									namespace: "op.preparation",
									key: `${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`,
									value: {},
									seq: 1,
								}
							: {
									namespace,
									key: `${prepared.fixture.operationId}:${prepared.fixture.stepId}:02`,
									value: {},
									seq: 1,
								}) as unknown as Register,
					];
				};
				const before = prepared.instrumented.committedTransactions.length;
				await expect(prepared.shell.executeAction()).rejects.toMatchObject({
					code: "fault",
					cause: { code: "corruption" },
				});
				expect(prepared.instrumented.committedTransactions).toHaveLength(before);
				expect((await prepared.fixture.storage.getEntries([reserved])).has(reserved)).toBe(false);
				await prepared.shell.close();
			},
		);

		it("accepts static context through prepared clearance with exact detached arguments", async () => {
			const execute = vi.fn();
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a", arguments: { value: "raw" } }]),
				{
					tools: [runtimeTool({ replay: "safe", prepareArguments: () => ({ value: "prepared" }), execute })],
					toolContext: { batch: "static" },
					beforeToolCall: () => ({ args: { value: "effective" } }),
				},
				["echo"],
			);
			await prepared.shell.executeAction();
			expect(execute).not.toHaveBeenCalled();
			expect(
				(
					await prepared.fixture.storage.getRegister(
						"op.tool_args",
						`${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`,
					)
				)?.value,
			).toEqual({ value: "effective" });
			const state = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state.phase).toMatchObject({
				kind: "tools",
				batch: { calls: [{ status: "effect_pending", sourceIndex: 0, replay: "safe" }] },
			});
			await prepared.shell.close();
		});

		it("retains a deeply captured parameter schema before clearance", async () => {
			const parameters = Type.Object({ value: Type.String() }, { additionalProperties: false });
			const execute = vi.fn();
			const source: RuntimeToolDefinition<{ batch: string }, typeof parameters> = {
				name: "echo",
				label: "Echo",
				description: "echo",
				parameters,
				replay: "safe",
				execute,
			};
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a", arguments: { value: "retained-string" } }]),
				{ tools: [source], toolContext: { batch: "static" } },
				["echo"],
			);
			(parameters as unknown as { properties: { value: { type: string } } }).properties.value.type = "number";
			await prepared.shell.executeAction();
			expect(execute).not.toHaveBeenCalled();
			expect(
				(
					await prepared.fixture.storage.getRegister(
						"op.tool_args",
						`${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`,
					)
				)?.value,
			).toEqual({ value: "retained-string" });
			const state = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state.phase).toMatchObject({
				kind: "tools",
				batch: { calls: [{ status: "effect_pending", replay: "safe" }] },
			});
			await prepared.shell.close();
		});

		it.each(["throw", "reject"] as const)("faults and seals when tool context %s fails", async (kind) => {
			const cause = new Error(`context ${kind}`);
			const beforeToolCall = vi.fn();
			const execute = vi.fn();
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{
					tools: [runtimeTool({ execute })],
					toolContext:
						kind === "throw"
							? () => {
									throw cause;
								}
							: () => Promise.reject(cause),
					beforeToolCall,
				},
				["echo"],
			);
			const before = prepared.instrumented.committedTransactions.length;
			const fault = await prepared.shell.executeAction().catch((error: unknown) => error);
			expect(fault).toMatchObject({ code: "fault", cause });
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
			expect(beforeToolCall).not.toHaveBeenCalled();
			expect(execute).not.toHaveBeenCalled();
			await expect(prepared.shell.peekAction()).rejects.toBe(fault);
			await prepared.shell.close();
		});

		it.each([
			[
				"unknown",
				{ name: "missing", arguments: { value: "x" } },
				runtimeTool(),
				undefined,
				"Tool missing not found",
				false,
			],
			[
				"invalid args",
				{ name: "echo", arguments: {} },
				runtimeTool(),
				undefined,
				'Validation failed for tool "echo"',
				false,
			],
			[
				"prepare throw",
				{ name: "echo", arguments: { value: "x" } },
				runtimeTool({
					prepareArguments: () => {
						throw new Error("prepare failed");
					},
				}),
				undefined,
				"prepare failed",
				false,
			],
			[
				"before invalid",
				{ name: "echo", arguments: { value: "x" } },
				runtimeTool(),
				() => 1 as never,
				"Invalid before tool callback output",
				false,
			],
			[
				"before throw",
				{ name: "echo", arguments: { value: "x" } },
				runtimeTool(),
				() => {
					throw new Error("before failed");
				},
				"before failed",
				false,
			],
			[
				"block",
				{ name: "echo", arguments: { value: "x" } },
				runtimeTool(),
				() => ({ block: { reason: "denied" } }),
				"denied",
				false,
			],
			[
				"terminating block",
				{ name: "echo", arguments: { value: "x" } },
				runtimeTool(),
				() => ({ block: { reason: "done", terminate: true } }),
				"done",
				true,
			],
		] as const)(
			"commits representative immediate outcome: %s",
			async (_label, call, tool, beforeToolCall, text, terminate) => {
				const execute = vi.spyOn(tool, "execute");
				const prepared = await settledToolBatch(
					toolMessage([{ id: "reserved-call", name: call.name, arguments: call.arguments }]),
					{ tools: [tool], toolContext: { batch: "static" }, beforeToolCall },
					["echo"],
				);
				const phase = (
					(await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
						.value as unknown as RunState
				).phase;
				if (phase.kind !== "tools") throw new Error("tool batch missing");
				const reserved = phase.batch.calls[0].resultEntryId;
				await prepared.shell.executeAction();
				expect(execute).not.toHaveBeenCalled();
				const entry = (await prepared.fixture.storage.getEntries([reserved])).get(reserved);
				expect(entry).toMatchObject({
					id: reserved,
					parentId: phase.batch.assistantEntryId,
					payload: { role: "toolResult", toolCallId: "reserved-call", toolName: call.name, isError: true },
				});
				const content = entry?.payload as { content?: Array<{ text?: string }> };
				expect(content.content?.[0]?.text).toContain(text);
				expect(await prepared.fixture.storage.getUsageRows([reserved])).toEqual(new Map());
				expect(
					await prepared.fixture.storage.getRegister(
						"op.tool_args",
						`${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`,
					),
				).toBeUndefined();
				const state = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
					.value as unknown as RunState;
				expect(state.phase).toMatchObject({
					kind: "checkpoint",
					continuation: terminate
						? { kind: "may_finish", includeFinalAssistant: false }
						: { kind: "need_assistant", overflowRecoveryUsed: false },
				});
				await prepared.shell.close();
			},
		);

		it("discards delayed clearance when authoritative operation state advances", async () => {
			let release!: () => void;
			let entered!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const admitted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const beforeToolCall = vi.fn(async () => {
				entered();
				await blocked;
				return undefined;
			});
			const execute = vi.fn();
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool({ execute })], toolContext: { batch: "static" }, beforeToolCall },
				["echo"],
			);
			const clearance = prepared.shell.executeAction();
			await admitted;
			const current = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
			await prepared.fixture.storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: prepared.fixture.operationId,
						value: current.value,
					},
				],
			});
			const before = prepared.instrumented.committedTransactions.length;
			release();
			await expect(clearance).rejects.toMatchObject({ code: "stale" });
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
			expect(beforeToolCall).toHaveBeenCalledTimes(1);
			expect(execute).not.toHaveBeenCalled();
			expect(await prepared.fixture.storage.getEntries([])).toEqual(new Map());
			expect(await prepared.shell.peekAction()).toMatchObject({ kind: "prepare_tool_call", sourceIndex: 0 });
			await prepared.shell.close();
		});

		it("uses the construction snapshot across a delayed before callback", async () => {
			let release!: () => void;
			let entered!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const admitted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const originalExecute = vi.fn();
			const replacementExecute = vi.fn();
			const source = runtimeTool({
				replay: "safe",
				prepareArguments: () => ({ value: "captured" }),
				execute: originalExecute,
			});
			const tools = [source];
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{
					tools,
					toolContext: { batch: "static" },
					beforeToolCall: async () => {
						entered();
						await blocked;
						return undefined;
					},
				},
				["echo"],
			);
			const clearance = prepared.shell.executeAction();
			await admitted;
			source.replay = "never";
			source.prepareArguments = () => ({ value: "mutated" });
			source.execute = replacementExecute;
			tools.length = 0;
			release();
			await clearance;
			const argsKey = `${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`;
			expect((await prepared.fixture.storage.getRegister("op.tool_args", argsKey))?.value).toEqual({
				value: "captured",
			});
			const state = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state.phase).toMatchObject({ kind: "tools", batch: { calls: [{ replay: "safe" }] } });
			expect(originalExecute).not.toHaveBeenCalled();
			expect(replacementExecute).not.toHaveBeenCalled();
			await prepared.shell.close();
		});

		it("close before clearance admission runs no callback or write", async () => {
			const context = vi.fn(() => ({ batch: "unused" }));
			const beforeToolCall = vi.fn();
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool()], toolContext: context, beforeToolCall },
				["echo"],
			);
			const before = prepared.instrumented.committedTransactions.length;
			await prepared.shell.close();
			await expect(prepared.shell.executeAction()).rejects.toMatchObject({ code: "closed" });
			expect(context).not.toHaveBeenCalled();
			expect(beforeToolCall).not.toHaveBeenCalled();
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
		});

		it("parks exact prepared intent when close queues behind a delayed admitted callback", async () => {
			let release!: () => void;
			let entered!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const admitted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const execute = vi.fn();
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{
					tools: [runtimeTool({ execute })],
					toolContext: { batch: "static" },
					beforeToolCall: async () => {
						entered();
						await blocked;
						return undefined;
					},
				},
				["echo"],
			);
			const clearance = prepared.shell.executeAction();
			await admitted;
			const close = prepared.shell.close();
			release();
			await expect(clearance).rejects.toMatchObject({ code: "closed" });
			await close;
			expect(execute).not.toHaveBeenCalled();
			const parkedStorage = prepared.state.createStorage();
			const state = (await parkedStorage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state.phase).toMatchObject({ kind: "tools", batch: { calls: [{ status: "effect_pending" }] } });
			await parkedStorage.close();
			const reopened = await createRuntimeShell(session(prepared.state.createStorage()), config());
			expect(await reopened.peekAction()).toBeUndefined();
			await reopened.close();
		});

		it("finishes an all-terminating two-call batch without a final assistant", async () => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }, { id: "call-b" }]),
				{
					tools: [runtimeTool()],
					toolContext: { batch: "static" },
					beforeToolCall: () => ({ block: { reason: "done", terminate: true } }),
				},
				["echo"],
			);
			const planned = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			if (planned.phase.kind !== "tools") throw new Error("tool batch missing");
			const { assistantEntryId, calls } = planned.phase.batch;
			await prepared.shell.executeAction();
			expect(await prepared.shell.peekAction()).toMatchObject({ kind: "prepare_tool_call", sourceIndex: 1 });
			await prepared.shell.executeAction();
			const checkpoint = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(checkpoint.latestAssistantEntryId).toBe(assistantEntryId);
			expect(checkpoint.phase).toEqual({
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: false },
				triggerEntryId: calls[1].resultEntryId,
			});
			const entries = await prepared.fixture.storage.getEntries(calls.map(({ resultEntryId }) => resultEntryId));
			expect(entries.get(calls[0].resultEntryId)).toMatchObject({
				parentId: assistantEntryId,
				payload: { toolCallId: "call-a", toolName: "echo" },
			});
			expect(entries.get(calls[1].resultEntryId)).toMatchObject({
				parentId: calls[0].resultEntryId,
				payload: { toolCallId: "call-b", toolName: "echo" },
			});
			expect((await prepared.fixture.storage.getRegister("lane.leaf", "main"))?.value).toBe(calls[1].resultEntryId);
			await prepared.shell.close();

			const storage = instrumentStorage(prepared.state.createStorage());
			const reopened = await createRuntimeShell(session(storage), config());
			expect(await reopened.peekAction()).toMatchObject({
				kind: "finish_run",
				triggerEntryId: calls[1].resultEntryId,
			});
			const action = await reopened.executeAction();
			expect(action).toMatchObject({ kind: "finish_run" });
			expect(storage.committedTransactions.at(-1)!.writes).toEqual([
				{ kind: "register", op: "delete", namespace: "op.meta", key: prepared.fixture.operationId },
				{ kind: "register", op: "delete", namespace: "op.state", key: prepared.fixture.operationId },
				{
					kind: "register",
					op: "set",
					namespace: "lane.lastResult",
					key: "main",
					value: {
						operationId: prepared.fixture.operationId,
						kind: "run",
						outcome: "completed",
						leafId: calls[1].resultEntryId,
						runCompletion: "terminated_tools",
					},
				},
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			]);
			expect(await storage.getRegister("op.meta", prepared.fixture.operationId)).toBeUndefined();
			expect(await storage.getRegister("op.state", prepared.fixture.operationId)).toBeUndefined();
			expect(await reopened.peekAction()).toBeUndefined();
			await reopened.close();
			const idle = await createRuntimeShell(session(prepared.state.createStorage()), config());
			expect(await idle.peekAction()).toBeUndefined();
			await idle.close();
		});
	});

	describe("D-028 live sequential tool effects", () => {
		it("runs four stable stages after durable clearance and atomically settles the exact finalized result", async () => {
			const order: string[] = [];
			const usage = { ...ZERO_USAGE, input: 3, output: 2, totalTokens: 5 };
			const context = { batch: "bound" };
			const execute = vi.fn(async (callId, args, signal, onUpdate, receivedContext) => {
				order.push("execute");
				expect(callId).toBe("call-a");
				expect(args).toEqual({ value: "effective" });
				expect(signal).toBeInstanceOf(AbortSignal);
				expect(signal?.aborted).toBe(false);
				expect(receivedContext).toBe(context);
				onUpdate?.({ content: [{ type: "text", text: "ignored update" }], details: { partial: true } });
				return {
					content: [{ type: "text" as const, text: "raw" }],
					details: { raw: true },
					usage,
					addedToolNames: ["added"],
				};
			});
			const afterToolCall = vi.fn((input, signal) => {
				order.push("after");
				expect(signal).toBeInstanceOf(AbortSignal);
				expect(input).toEqual({
					toolCall: { type: "toolCall", id: "call-a", name: "echo", arguments: { value: "raw" } },
					args: { value: "effective" },
					result: {
						content: [{ type: "text", text: "raw" }],
						details: { raw: true },
						usage,
						addedToolNames: ["added"],
					},
					isError: false,
				});
				return { content: [{ type: "text" as const, text: "final" }], details: { final: true } };
			});
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a", arguments: { value: "raw" } }]),
				{
					tools: [runtimeTool({ replay: "safe", execute })],
					toolContext: context,
					beforeToolCall: () => ({ args: { value: "effective" } }),
					afterToolCall,
				},
				["echo"],
			);
			const writesBeforeClearance = prepared.instrumented.committedTransactions.length;
			await prepared.shell.executeAction();
			order.push("clearance committed");
			expect(prepared.instrumented.committedTransactions).toHaveLength(writesBeforeClearance + 1);
			const actions = [
				"dispatch_tool_effect",
				"await_tool_effect",
				"finalize_tool_effect",
				"settle_tool_effect",
			] as const;
			for (const kind of actions) {
				const visible = await prepared.shell.peekAction();
				expect(visible).toMatchObject({ kind });
				expect(await prepared.shell.peekAction()).toEqual(visible);
				await prepared.shell.executeAction();
			}
			expect(order).toEqual(["clearance committed", "execute", "after"]);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(afterToolCall).toHaveBeenCalledTimes(1);

			const clearanceState = prepared.instrumented.committedTransactions[writesBeforeClearance].writes.at(-1);
			if (clearanceState?.kind !== "register" || clearanceState.op !== "set")
				throw new Error("clearance state missing");
			const phase = (clearanceState.value as unknown as RunState).phase;
			if (phase.kind !== "tools") throw new Error("tool phase missing");
			const resultId = phase.batch.calls[0].resultEntryId;
			const settlement = prepared.instrumented.committedTransactions.at(-1)!;
			expect(settlement.writes.map((write) => write.kind)).toEqual([
				"entry",
				"register",
				"usage",
				"register",
				"register",
			]);
			expect(settlement.writes).toEqual([
				expect.objectContaining({
					kind: "entry",
					entry: expect.objectContaining({
						id: resultId,
						parentId: phase.batch.assistantEntryId,
						payload: expect.objectContaining({
							role: "toolResult",
							toolCallId: "call-a",
							toolName: "echo",
							content: [{ type: "text", text: "final" }],
							details: { final: true },
							addedToolNames: ["added"],
							isError: false,
						}),
					}),
				}),
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: resultId },
				expect.objectContaining({
					kind: "usage",
					row: expect.objectContaining({ entryId: resultId, usage, adjustment: false }),
				}),
				{
					kind: "register",
					op: "delete",
					namespace: "op.tool_args",
					key: `${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`,
				},
				expect.objectContaining({ kind: "register", op: "set", namespace: "op.state" }),
			]);
			const usageWrite = settlement.writes[2];
			if (usageWrite.kind !== "usage") throw new Error("usage missing");
			expect(usageWrite.row.id).not.toBe(resultId);
			expect(isUuidV7(usageWrite.row.id)).toBe(true);
			expect((await prepared.fixture.storage.getEntries([resultId])).get(resultId)?.payload).toMatchObject({
				content: [{ type: "text", text: "final" }],
				details: { final: true },
				addedToolNames: ["added"],
				isError: false,
				usage,
			});
			const persisted = (await prepared.fixture.storage.getEntries([resultId])).get(resultId)?.payload as {
				usage: typeof usage;
			};
			expect(persisted.usage).toEqual(usage);
			expect(persisted.usage).not.toBe(usage);
			expect(
				(await prepared.fixture.storage.getUsageRows([usageWrite.row.id])).get(usageWrite.row.id),
			).toMatchObject({
				entryId: resultId,
				usage,
				adjustment: false,
			});
			await prepared.shell.close();
		});

		it("does not allocate usage and preserves the intent until no-usage final settlement", async () => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool()], toolContext: { batch: "static" } },
				["echo"],
			);
			vi.mocked(prepared.runtimeSession.idGenerator.next).mockClear();
			await prepared.shell.executeAction();
			for (const kind of ["dispatch_tool_effect", "await_tool_effect", "finalize_tool_effect"] as const) {
				expect(await prepared.shell.peekAction()).toMatchObject({ kind });
				await prepared.shell.executeAction();
				expect(
					await prepared.fixture.storage.getRegister(
						"op.tool_args",
						`${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`,
					),
				).toBeDefined();
			}
			await prepared.shell.executeAction();
			expect(prepared.runtimeSession.idGenerator.next).not.toHaveBeenCalled();
			const settlement = prepared.instrumented.committedTransactions.at(-1)!;
			expect(settlement.writes.some((write) => write.kind === "usage")).toBe(false);
			const entryWrite = settlement.writes.find((write) => write.kind === "entry");
			if (entryWrite?.kind !== "entry") throw new Error("tool result entry missing");
			expect(Object.hasOwn(entryWrite.entry.payload as object, "usage")).toBe(false);
			await prepared.shell.close();
		});

		it("enters may_finish without another assistant when every real result terminates", async () => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{
					tools: [
						runtimeTool({
							execute: async () => ({
								content: [{ type: "text", text: "done" }],
								details: null,
								terminate: true,
							}),
						}),
					],
					toolContext: { batch: "static" },
				},
				["echo"],
			);
			await prepared.shell.executeAction();
			for (let stage = 0; stage < 4; stage++) await prepared.shell.executeAction();
			const state = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state.phase).toMatchObject({
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: false },
			});
			expect(await prepared.shell.peekAction()).toMatchObject({ kind: "finish_run" });
			await prepared.shell.close();
		});

		it("serializes two real calls through settlement and cleans both argument registers only at the end", async () => {
			const context = vi.fn(() => ({ batch: "shared" }));
			const execute = vi.fn(async (callId: string) => ({
				content: [{ type: "text" as const, text: callId }],
				details: { callId },
			}));
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }, { id: "call-b" }]),
				{ tools: [runtimeTool({ replay: "safe", execute })], toolContext: context },
				["echo"],
			);
			const initial = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			if (initial.phase.kind !== "tools") throw new Error("tool batch missing");
			const { assistantEntryId, calls } = initial.phase.batch;
			const keys = calls.map((_, index) => `${prepared.fixture.operationId}:${prepared.fixture.stepId}:${index}`);

			await prepared.shell.executeAction();
			for (const kind of ["dispatch_tool_effect", "await_tool_effect", "finalize_tool_effect"] as const) {
				expect(await prepared.shell.peekAction()).toMatchObject({
					kind,
					operationId: prepared.fixture.operationId,
				});
				await prepared.shell.executeAction();
				expect(await prepared.shell.peekAction()).not.toMatchObject({
					kind: expect.stringMatching(/prepare_tool_call|dispatch_tool_effect/),
					sourceIndex: 1,
				});
			}
			expect((await prepared.fixture.storage.getRegister("op.tool_args", keys[0]))?.value).toEqual({
				value: "call-a",
			});
			await prepared.shell.executeAction();
			expect(await prepared.shell.peekAction()).toMatchObject({ kind: "prepare_tool_call", sourceIndex: 1 });
			expect(await prepared.fixture.storage.getRegister("op.tool_args", keys[0])).toBeDefined();

			await prepared.shell.executeAction();
			expect(await prepared.fixture.storage.getRegister("op.tool_args", keys[0])).toBeDefined();
			expect(await prepared.fixture.storage.getRegister("op.tool_args", keys[1])).toBeDefined();
			for (const kind of [
				"dispatch_tool_effect",
				"await_tool_effect",
				"finalize_tool_effect",
				"settle_tool_effect",
			] as const) {
				expect(await prepared.shell.peekAction()).toMatchObject({ kind });
				await prepared.shell.executeAction();
			}
			expect(context).toHaveBeenCalledTimes(1);
			expect(execute.mock.calls.map(([callId]) => callId)).toEqual(["call-a", "call-b"]);
			expect(await prepared.fixture.storage.getRegister("op.tool_args", keys[0])).toBeUndefined();
			expect(await prepared.fixture.storage.getRegister("op.tool_args", keys[1])).toBeUndefined();
			const finalCommit = prepared.instrumented.committedTransactions.at(-1)!;
			expect(
				finalCommit.writes
					.filter((write) => write.kind === "register" && write.op === "delete")
					.map((write) => write.key),
			).toEqual(keys);
			const entries = await prepared.fixture.storage.getEntries(calls.map(({ resultEntryId }) => resultEntryId));
			expect(entries.get(calls[0].resultEntryId)?.parentId).toBe(assistantEntryId);
			expect(entries.get(calls[1].resultEntryId)?.parentId).toBe(calls[0].resultEntryId);
			const finalState = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(finalState.phase).toEqual({
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: calls[1].resultEntryId,
			});
			await prepared.shell.close();
		});

		it("reopens a two-call batch after the first real settlement from the completed prefix", async () => {
			const tool = runtimeTool({ replay: "safe" });
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }, { id: "call-b" }]),
				{ tools: [tool], toolContext: { batch: "static" } },
				["echo"],
			);
			const planned = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			if (planned.phase.kind !== "tools") throw new Error("tool batch missing");
			const { assistantEntryId, calls } = planned.phase.batch;
			const firstArgsKey = `${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`;
			const nextArgsKey = `${prepared.fixture.operationId}:${prepared.fixture.stepId}:1`;
			await prepared.shell.executeAction();
			for (let stage = 0; stage < 4; stage++) await prepared.shell.executeAction();
			expect(await prepared.shell.peekAction()).toMatchObject({ kind: "prepare_tool_call", sourceIndex: 1 });
			await prepared.shell.close();

			const storage = instrumentStorage(prepared.state.createStorage());
			storage.listRegisters = async () => {
				throw new Error("register scan forbidden");
			};
			storage.scanEntries = async () => {
				throw new Error("entry scan forbidden");
			};
			storage.scanBranch = async () => {
				throw new Error("branch scan forbidden");
			};
			storage.scanBranchStructure = async () => {
				throw new Error("branch structure scan forbidden");
			};
			const reopened = await createRuntimeShell(session(storage), config(), {
				tools: [tool],
				toolContext: { batch: "static" },
			});
			const restored = (await storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(restored.latestAssistantEntryId).toBe(assistantEntryId);
			expect(restored.phase).toMatchObject({
				kind: "tools",
				batch: {
					assistantEntryId,
					calls: [
						{ status: "completed", sourceIndex: 0, resultEntryId: calls[0].resultEntryId },
						{ status: "planned", sourceIndex: 1, resultEntryId: calls[1].resultEntryId },
					],
				},
			});
			const firstResult = (await storage.getEntries([calls[0].resultEntryId])).get(calls[0].resultEntryId);
			expect(firstResult).toMatchObject({
				parentId: assistantEntryId,
				payload: { toolCallId: "call-a", toolName: "echo" },
			});
			expect((await storage.getRegister("op.tool_args", firstArgsKey))?.value).toEqual({ value: "call-a" });
			expect(await storage.getRegister("op.tool_args", nextArgsKey)).toBeUndefined();
			expect(await reopened.peekAction()).toEqual({
				kind: "prepare_tool_call",
				operationId: prepared.fixture.operationId,
				assistantEntryId,
				sourceIndex: 1,
				resultEntryId: calls[1].resultEntryId,
			});
			expect(storage.committedTransactions).toEqual([]);
			await reopened.close();
		});

		it("settles from a semantically identical newer operation state and advances that latest state", async () => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool({ replay: "safe" })], toolContext: { batch: "static" } },
				["echo"],
			);
			await prepared.shell.executeAction();
			for (let stage = 0; stage < 3; stage++) await prepared.shell.executeAction();
			const current = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
			await prepared.fixture.storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: prepared.fixture.operationId,
						value: current.value,
					},
				],
			});
			const rewritten = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
			expect(rewritten.seq).toBeGreaterThan(current.seq);
			await expect(prepared.shell.executeAction()).resolves.toMatchObject({ kind: "settle_tool_effect" });
			const settled = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
			expect(settled.seq).toBeGreaterThan(rewritten.seq);
			expect((settled.value as unknown as RunState).phase).toMatchObject({ kind: "checkpoint" });
			await prepared.shell.close();
		});

		it("discards an obsolete local tool settlement and follows an authoritative completed prefix", async () => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool({ replay: "safe" })], toolContext: { batch: "static" } },
				["echo"],
			);
			await prepared.shell.executeAction();
			for (let stage = 0; stage < 3; stage++) await prepared.shell.executeAction();
			const current = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
			const state = structuredClone(current.value) as unknown as RunState;
			if (state.phase.kind !== "tools") throw new Error("tool batch missing");
			const resultId = state.phase.batch.calls[0].resultEntryId;
			state.phase = {
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: resultId,
			};
			await prepared.fixture.storage.commit({
				writes: [
					{
						kind: "entry",
						entry: {
							id: resultId,
							parentId: state.latestAssistantEntryId,
							type: "message",
							payload: json({ ...toolResult(), toolCallId: "call-a", toolName: "echo" }),
						},
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: resultId },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: prepared.fixture.operationId,
						value: json(state),
					},
				],
			});
			const before = prepared.instrumented.committedTransactions.length;
			await expect(prepared.shell.executeAction()).rejects.toMatchObject({ code: "stale" });
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
			expect(await prepared.shell.peekAction()).toEqual({
				kind: "start_assistant_step",
				operationId: prepared.fixture.operationId,
				triggerEntryId: resultId,
			});
			await prepared.shell.close();
		});

		it.each(["missing arguments", "mismatched arguments", "materialized result"] as const)(
			"faults write-free when finalized tool settlement has %s",
			async (kind) => {
				const prepared = await settledToolBatch(
					toolMessage([{ id: "call-a" }]),
					{ tools: [runtimeTool({ replay: "safe" })], toolContext: { batch: "static" } },
					["echo"],
				);
				await prepared.shell.executeAction();
				for (let stage = 0; stage < 3; stage++) await prepared.shell.executeAction();
				const state = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
					.value as unknown as RunState;
				if (state.phase.kind !== "tools") throw new Error("tool batch missing");
				const argsKey = `${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`;
				const writes: Write[] =
					kind === "materialized result"
						? [
								{
									kind: "entry",
									entry: {
										id: state.phase.batch.calls[0].resultEntryId,
										parentId: state.phase.batch.assistantEntryId,
										type: "message",
										payload: json({ ...toolResult(), toolCallId: "call-a", toolName: "echo" }),
									},
								},
							]
						: [
								{
									kind: "register",
									op: kind === "missing arguments" ? "delete" : "set",
									namespace: "op.tool_args",
									key: argsKey,
									...(kind === "mismatched arguments" ? { value: { value: "other" } } : {}),
								} as Write,
							];
				await prepared.fixture.storage.commit({ writes });
				const before = prepared.instrumented.committedTransactions.length;
				const fault = await prepared.shell.executeAction().catch((error: unknown) => error);
				expect(fault).toMatchObject({ code: "fault", cause: { code: "corruption" } });
				expect(prepared.instrumented.committedTransactions).toHaveLength(before);
				await expect(prepared.shell.peekAction()).rejects.toBe(fault);
				await prepared.shell.close();
			},
		);

		it.each([
			[
				"tool throw",
				runtimeTool({
					execute: async () => {
						throw new Error("tool failed");
					},
				}),
				undefined,
				"tool failed",
			],
			[
				"invalid raw",
				runtimeTool({ execute: async () => ({ content: "bad", details: null }) as never }),
				undefined,
				"Invalid tool result",
			],
			[
				"after throw",
				runtimeTool(),
				() => {
					throw new Error("after failed");
				},
				"after failed",
			],
			["invalid after", runtimeTool(), () => 1 as never, "Invalid after tool callback output"],
		] as const)(
			"settles expected %s normalization in-band without fault",
			async (_label, tool, afterToolCall, text) => {
				const prepared = await settledToolBatch(
					toolMessage([{ id: "call-a" }]),
					{ tools: [tool], toolContext: { batch: "static" }, afterToolCall },
					["echo"],
				);
				await prepared.shell.executeAction();
				for (let stage = 0; stage < 4; stage++) await prepared.shell.executeAction();
				const state = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
					.value as unknown as RunState;
				if (state.phase.kind !== "checkpoint") throw new Error("checkpoint missing");
				const result = (await prepared.fixture.storage.getEntries([state.phase.triggerEntryId])).get(
					state.phase.triggerEntryId,
				);
				expect(result?.payload).toMatchObject({ isError: true });
				expect((result?.payload as { content: Array<{ text: string }> }).content[0].text).toContain(text);
				expect(await prepared.shell.peekAction()).toMatchObject({ kind: "start_assistant_step" });
				await prepared.shell.close();
			},
		);

		it("close before tool dispatch starts executes nothing and preserves the prepared durable prefix", async () => {
			const execute = vi.fn();
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool({ replay: "safe", execute })], toolContext: { batch: "static" } },
				["echo"],
			);
			await prepared.shell.executeAction();
			expect(await prepared.shell.peekAction()).toMatchObject({ kind: "dispatch_tool_effect" });
			const before = prepared.instrumented.committedTransactions.length;
			await prepared.shell.close();
			await expect(prepared.shell.executeAction()).rejects.toMatchObject({ code: "closed" });
			expect(execute).not.toHaveBeenCalled();
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
			const storage = prepared.state.createStorage();
			const state = (await storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state.phase).toMatchObject({ kind: "tools", batch: { calls: [{ status: "effect_pending" }] } });
			await storage.close();
		});

		it("close after raw observation prevents the after callback and settlement writes", async () => {
			const afterToolCall = vi.fn();
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool({ replay: "safe" })], toolContext: { batch: "static" }, afterToolCall },
				["echo"],
			);
			await prepared.shell.executeAction();
			await prepared.shell.executeAction();
			await prepared.shell.executeAction();
			expect(await prepared.shell.peekAction()).toMatchObject({ kind: "finalize_tool_effect" });
			const before = prepared.instrumented.committedTransactions.length;
			await prepared.shell.close();
			await expect(prepared.shell.executeAction()).rejects.toMatchObject({ code: "closed" });
			expect(afterToolCall).not.toHaveBeenCalled();
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
		});

		it("close after tool finalization prevents settlement", async () => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool({ replay: "safe" })], toolContext: { batch: "static" } },
				["echo"],
			);
			await prepared.shell.executeAction();
			for (let stage = 0; stage < 3; stage++) await prepared.shell.executeAction();
			expect(await prepared.shell.peekAction()).toMatchObject({ kind: "settle_tool_effect" });
			const before = prepared.instrumented.committedTransactions.length;
			await prepared.shell.close();
			await expect(prepared.shell.executeAction()).rejects.toMatchObject({ code: "closed" });
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
		});

		it("allows an admitted tool settlement commit to stand before close", async () => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool({ replay: "safe" })], toolContext: { batch: "static" } },
				["echo"],
			);
			await prepared.shell.executeAction();
			for (let stage = 0; stage < 3; stage++) await prepared.shell.executeAction();
			const commit = prepared.instrumented.commit.bind(prepared.instrumented);
			let release!: () => void;
			let entered!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const admitted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			prepared.instrumented.commit = async (transaction) => {
				if (transaction.writes.some((write) => write.kind === "entry")) {
					entered();
					await blocked;
				}
				return commit(transaction);
			};
			const before = prepared.instrumented.committedTransactions.length;
			const settlement = prepared.shell.executeAction();
			await admitted;
			const close = prepared.shell.close();
			release();
			await expect(settlement).resolves.toMatchObject({ kind: "settle_tool_effect" });
			await close;
			expect(prepared.instrumented.committedTransactions).toHaveLength(before + 1);
		});

		it.each([
			["dispatch/running", 1],
			["raw before finalize", 2],
			["finalized before settlement", 3],
		] as const)("preserves a fault that seals before close at %s", async (_boundary, processActions) => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool({ replay: "safe" })], toolContext: { batch: "static" } },
				["echo"],
			);
			await prepared.shell.executeAction();
			for (let stage = 0; stage < processActions; stage++) await prepared.shell.executeAction();
			const durable = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			if (durable.phase.kind !== "tools") throw new Error("tool batch missing");
			const resultEntryId = durable.phase.batch.calls[0].resultEntryId;
			const settlementFailure = new Error(`settlement failed at ${_boundary}`);
			prepared.instrumented.commit = vi.fn().mockRejectedValueOnce(settlementFailure);
			while ((await prepared.shell.peekAction())?.kind !== "settle_tool_effect")
				await prepared.shell.executeAction();
			const before = prepared.instrumented.committedTransactions.length;
			const fault = await prepared.shell.executeAction().catch((error: unknown) => error);
			expect(fault).toMatchObject({
				code: "fault",
				cause: { code: "storage", cause: settlementFailure },
			});
			await expect(prepared.shell.peekAction()).rejects.toBe(fault);
			await prepared.shell.close();
			await expect(prepared.shell.executeAction()).rejects.toBe(fault);
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
			const storage = prepared.state.createStorage();
			const state = (await storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state.phase).toMatchObject({ kind: "tools", batch: { calls: [{ status: "effect_pending" }] } });
			expect(await storage.getEntries([resultEntryId])).toEqual(new Map());
			await storage.close();
		});

		it("preserves a rejected admitted settlement fault when close follows", async () => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool({ replay: "safe" })], toolContext: { batch: "static" } },
				["echo"],
			);
			await prepared.shell.executeAction();
			for (let stage = 0; stage < 3; stage++) await prepared.shell.executeAction();
			let rejectCommit!: (error: Error) => void;
			let entered!: () => void;
			const admitted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			prepared.instrumented.commit = vi.fn((): Promise<never> => {
				entered();
				return new Promise<never>((_resolve, reject) => {
					rejectCommit = reject;
				});
			});
			const before = prepared.instrumented.committedTransactions.length;
			const settlement = prepared.shell.executeAction();
			await admitted;
			const settlementFailure = new Error("admitted settlement failed");
			rejectCommit(settlementFailure);
			const fault = await settlement.catch((error: unknown) => error);
			expect(fault).toMatchObject({
				code: "fault",
				cause: { code: "storage", cause: settlementFailure },
			});
			const close = prepared.shell.close();
			await expect(prepared.shell.peekAction()).rejects.toBe(fault);
			await close;
			await expect(prepared.shell.executeAction()).rejects.toBe(fault);
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
			const storage = prepared.state.createStorage();
			const state = (await storage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state.phase).toMatchObject({ kind: "tools", batch: { calls: [{ status: "effect_pending" }] } });
			await storage.close();
		});

		it("close after dispatch aborts the registered cooperative tool and leaves durable effect_pending", async () => {
			let signal!: AbortSignal;
			let started!: () => void;
			const didStart = new Promise<void>((resolve) => {
				started = resolve;
			});
			const execute = vi.fn((_callId, _args, suppliedSignal) => {
				signal = suppliedSignal!;
				started();
				return new Promise<never>((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("aborted"))),
				);
			});
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool({ execute })], toolContext: { batch: "static" } },
				["echo"],
			);
			await prepared.shell.executeAction();
			await prepared.shell.executeAction();
			await didStart;
			const before = prepared.instrumented.committedTransactions.length;
			await prepared.shell.close();
			expect(signal.aborted).toBe(true);
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
			const parkedStorage = prepared.state.createStorage();
			const state = (await parkedStorage.getRegister("op.state", prepared.fixture.operationId))!
				.value as unknown as RunState;
			expect(state.phase).toMatchObject({ kind: "tools", batch: { calls: [{ status: "effect_pending" }] } });
			await parkedStorage.close();
			const reopened = await createRuntimeShell(session(prepared.state.createStorage()), config());
			expect(await reopened.peekAction()).toBeUndefined();
			await reopened.close();
		});
	});

	it.each(["duplicate", "directly known", "occupied entry", "occupied usage"] as const)(
		"does not write settlement when generated tool result IDs are %s",
		async (kind) => {
			const message = {
				...terminal("toolUse"),
				content: [
					{ type: "toolCall" as const, id: "call-a", name: "read", arguments: { path: "a" } },
					...(kind === "duplicate"
						? [{ type: "toolCall" as const, id: "call-b", name: "read", arguments: { path: "b" } }]
						: []),
				],
			};
			const prepared = await preparedShell(() => message);
			const stateRegister = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
			const phase = (stateRegister.value as unknown as RunState).phase;
			if (phase.kind !== "assistant" || phase.generation.status !== "effect_pending")
				throw new Error("assistant reservation missing");
			const timestamp = uuidV7Timestamp(phase.generation.responseEntryId);
			const generated = createIdGenerator().next(timestamp);
			const reserved = kind === "directly known" ? phase.generation.responseEntryId : generated;
			vi.mocked(prepared.runtimeSession.idGenerator.next).mockImplementation((suppliedTimestamp) => {
				expect(suppliedTimestamp).toBe(timestamp);
				return reserved;
			});
			if (kind === "occupied entry")
				await prepared.fixture.storage.commit({
					writes: [
						{
							kind: "entry",
							entry: { id: reserved, parentId: null, type: "message", payload: json(user("occupied")) },
						},
					],
				});
			if (kind === "occupied usage")
				await prepared.fixture.storage.commit({
					writes: [
						{
							kind: "usage",
							row: { id: reserved, entryId: prepared.fixture.prompt, adjustment: false, usage: ZERO_USAGE },
						},
					],
				});
			const beforeSettlement = prepared.instrumented.committedTransactions.length;
			const fault = await settlePrepared(prepared).catch((error: unknown) => error);
			expect(fault).toMatchObject({ code: "fault", cause: { code: "storage" } });
			expect(prepared.instrumented.committedTransactions).toHaveLength(beforeSettlement);
			await prepared.shell.close();
		},
	);

	it.each(["leaf mismatch", "latest mismatch", "planned entry occupied", "planned usage occupied"] as const)(
		"rejects restored tool-plan corruption: %s",
		async (kind) => {
			const message = {
				...terminal("toolUse"),
				content: [{ type: "toolCall" as const, id: "call-a", name: "read", arguments: { path: "a" } }],
			};
			const prepared = await preparedShell(() => message);
			vi.mocked(prepared.runtimeSession.idGenerator.next).mockRestore();
			await settlePrepared(prepared);
			const stateRegister = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
			const state = structuredClone(stateRegister.value) as unknown as RunState;
			if (state.phase.kind !== "tools") throw new Error("tool plan missing");
			const resultEntryId = state.phase.batch.calls[0].resultEntryId;
			const writes: Write[] = [];
			if (kind === "leaf mismatch")
				writes.push({
					kind: "register",
					op: "set",
					namespace: "lane.leaf",
					key: "main",
					value: prepared.fixture.prompt,
				});
			if (kind === "latest mismatch") {
				state.latestAssistantEntryId = prepared.fixture.prompt;
				writes.push({
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: prepared.fixture.operationId,
					value: json(state),
				});
			}
			if (kind === "planned entry occupied")
				writes.push({
					kind: "entry",
					entry: {
						id: resultEntryId,
						parentId: state.phase.batch.assistantEntryId,
						type: "message",
						payload: json(toolResult()),
					},
				});
			if (kind === "planned usage occupied")
				writes.push({
					kind: "usage",
					row: {
						id: resultEntryId,
						entryId: state.phase.batch.assistantEntryId,
						adjustment: false,
						usage: ZERO_USAGE,
					},
				});
			await prepared.fixture.storage.commit({ writes });
			await prepared.shell.close();
			const reopenedStorage = instrumentStorage(prepared.state.createStorage());
			const before = reopenedStorage.committedTransactions.length;
			await expect(createRuntimeShell(session(reopenedStorage), config())).rejects.toMatchObject({
				code: "corruption",
			});
			expect(reopenedStorage.committedTransactions).toHaveLength(before);
		},
	);

	it.each(["planned args", "pending missing args", "pending non-object args"] as const)(
		"rejects restored tool argument corruption write-free: %s",
		async (kind) => {
			const prepared = await settledToolBatch(
				toolMessage([{ id: "call-a" }]),
				{ tools: [runtimeTool()], toolContext: { batch: "static" } },
				["echo"],
			);
			const argsKey = `${prepared.fixture.operationId}:${prepared.fixture.stepId}:0`;
			if (kind !== "planned args") await prepared.shell.executeAction();
			if (kind === "planned args" || kind === "pending non-object args")
				await prepared.fixture.storage.commit({
					writes: [
						{
							kind: "register",
							op: "set",
							namespace: "op.tool_args",
							key: argsKey,
							value: kind === "planned args" ? { value: "unexpected" } : "invalid",
						},
					],
				});
			if (kind === "pending missing args")
				await prepared.fixture.storage.commit({
					writes: [{ kind: "register", op: "delete", namespace: "op.tool_args", key: argsKey }],
				});
			await prepared.shell.close();
			const storage = instrumentStorage(prepared.state.createStorage());
			await expect(createRuntimeShell(session(storage), config())).rejects.toMatchObject({ code: "corruption" });
			expect(storage.committedTransactions).toEqual([]);
		},
	);

	it("rejects a restored tool result reservation with a timestamp that does not follow its assistant", async () => {
		const message = {
			...terminal("toolUse"),
			content: [{ type: "toolCall" as const, id: "call-a", name: "read", arguments: { path: "a" } }],
		};
		const prepared = await preparedShell(() => message);
		vi.mocked(prepared.runtimeSession.idGenerator.next).mockRestore();
		await settlePrepared(prepared);
		const stateRegister = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
		const state = structuredClone(stateRegister.value) as unknown as RunState;
		if (state.phase.kind !== "tools") throw new Error("tool plan missing");
		state.phase.batch.calls[0].resultEntryId = createIdGenerator().next(
			uuidV7Timestamp(state.phase.batch.assistantEntryId) + 1,
		);
		await prepared.fixture.storage.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: prepared.fixture.operationId,
					value: json(state),
				},
			],
		});
		await prepared.shell.close();
		const reopenedStorage = instrumentStorage(prepared.state.createStorage());
		const before = reopenedStorage.committedTransactions.length;
		await expect(createRuntimeShell(session(reopenedStorage), config())).rejects.toMatchObject({
			code: "corruption",
		});
		expect(reopenedStorage.committedTransactions).toHaveLength(before);
	});

	it("settles against semantically current authoritative registers after their sequences advance", async () => {
		const message = terminal();
		const prepared = await preparedShell(() => message);
		await prepared.shell.executeAction();
		await prepared.shell.executeAction();
		const operationState = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
		const laneState = (await prepared.fixture.storage.getRegister("lane.state", "main"))!;
		const configuration = (await prepared.fixture.storage.getRegister("lane.config", "main"))!;
		const leaf = (await prepared.fixture.storage.getRegister("lane.leaf", "main"))!;
		const generation = ((operationState.value as Record<string, JsonValue>).phase as Record<string, JsonValue>)
			.generation as Record<string, JsonValue>;
		const responseEntryId = generation.responseEntryId as string;
		const expectedState = {
			...(operationState.value as Record<string, JsonValue>),
			latestAssistantEntryId: responseEntryId,
			phase: {
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: responseEntryId,
			},
		};
		await prepared.fixture.storage.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: prepared.fixture.operationId,
					value: operationState.value,
				},
				{ kind: "register", op: "set", namespace: "lane.state", key: "main", value: laneState.value },
				{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuration.value },
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: leaf.value },
			],
		});
		const before = prepared.instrumented.committedTransactions.length;

		await expect(prepared.shell.executeAction()).resolves.toMatchObject({ kind: "settle_assistant_effect" });
		expect(prepared.instrumented.committedTransactions).toHaveLength(before + 1);
		expect(prepared.instrumented.committedTransactions.at(-1)!.writes[3]).toEqual({
			kind: "register",
			op: "set",
			namespace: "op.state",
			key: prepared.fixture.operationId,
			value: expectedState,
		});
		expect((await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!.value).toEqual(
			expectedState,
		);
		await prepared.shell.close();
	});

	it("accepts matching pre-materialized reservations without writing and prefers repair planning", async () => {
		const message = terminal();
		const prepared = await preparedShell(() => message);
		await prepared.shell.executeAction();
		await prepared.shell.executeAction();
		const operationState = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
		const generation = ((operationState.value as Record<string, JsonValue>).phase as Record<string, JsonValue>)
			.generation as Record<string, JsonValue>;
		const responseEntryId = generation.responseEntryId as string;
		const usageId = generation.usageId as string;
		await prepared.fixture.storage.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						payload: json({ ...message, usage: { ...message.usage } }),
						type: "message",
						parentId: prepared.fixture.prompt,
						id: responseEntryId,
					},
				},
				{
					kind: "usage",
					row: { usage: { ...message.usage }, adjustment: false, entryId: responseEntryId, id: usageId },
				},
			],
		});
		const before = prepared.instrumented.committedTransactions.length;

		await expect(prepared.shell.executeAction()).resolves.toMatchObject({ kind: "settle_assistant_effect" });
		expect(prepared.instrumented.committedTransactions).toHaveLength(before);
		expect(await prepared.shell.peekAction()).toEqual({
			kind: "repair_materialized_assistant",
			operationId: prepared.fixture.operationId,
			responseEntryId,
			usageId,
		});
		await prepared.shell.close();
	});

	it.each(["partial", "mismatched"] as const)(
		"faults and seals on %s reservation materialization without a settlement write",
		async (kind) => {
			const message = terminal();
			const prepared = await preparedShell(() => message);
			await prepared.shell.executeAction();
			await prepared.shell.executeAction();
			const operationState = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
			const generation = ((operationState.value as Record<string, JsonValue>).phase as Record<string, JsonValue>)
				.generation as Record<string, JsonValue>;
			const responseEntryId = generation.responseEntryId as string;
			const usageId = generation.usageId as string;
			const writes: Write[] = [
				{
					kind: "entry",
					entry: {
						id: responseEntryId,
						parentId: prepared.fixture.prompt,
						type: "message",
						payload: json(kind === "mismatched" ? terminal("length") : message),
					},
				},
			];
			if (kind === "mismatched")
				writes.push({
					kind: "usage",
					row: { id: usageId, entryId: responseEntryId, adjustment: false, usage: message.usage },
				});
			await prepared.fixture.storage.commit({
				writes,
			});
			const before = prepared.instrumented.committedTransactions.length;
			const fault = await prepared.shell.executeAction().catch((error: unknown) => error);
			expect(fault).toMatchObject({ code: "fault", cause: { code: "corruption" } });
			expect(prepared.instrumented.committedTransactions).toHaveLength(before);
			await expect(prepared.shell.peekAction()).rejects.toBe(fault);
			await expect(prepared.shell.executeAction()).rejects.toBe(fault);
			await prepared.shell.close();
		},
	);

	it("discards an obsolete local settlement and replans from authoritative durable state", async () => {
		const prepared = await preparedShell(() => terminal());
		await prepared.shell.executeAction();
		await prepared.shell.executeAction();
		const operationState = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
		const authoritativeResponse = id();
		const authoritativeState = {
			...(operationState.value as Record<string, JsonValue>),
			latestAssistantEntryId: authoritativeResponse,
			phase: {
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: authoritativeResponse,
			},
		};
		await prepared.fixture.storage.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: authoritativeResponse,
						parentId: prepared.fixture.prompt,
						type: "message",
						payload: json(terminal()),
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: authoritativeResponse },
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: prepared.fixture.operationId,
					value: authoritativeState,
				},
			],
		});
		const before = prepared.instrumented.committedTransactions.length;

		await expect(prepared.shell.executeAction()).rejects.toMatchObject({ code: "stale" });
		expect(prepared.instrumented.committedTransactions).toHaveLength(before);
		expect(await prepared.shell.peekAction()).toEqual({
			kind: "finish_run",
			operationId: prepared.fixture.operationId,
			triggerEntryId: authoritativeResponse,
		});
		await prepared.shell.close();
	});

	it("lets settlement admitted before close complete its four-write commit", async () => {
		const prepared = await preparedShell(() => terminal());
		await prepared.shell.executeAction();
		await prepared.shell.executeAction();
		const commit = prepared.instrumented.commit.bind(prepared.instrumented);
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const admitted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let gate = true;
		prepared.instrumented.commit = async (transaction) => {
			if (gate && transaction.writes.length === 4) {
				gate = false;
				entered();
				await blocked;
			}
			return commit(transaction);
		};
		const before = prepared.instrumented.committedTransactions.length;
		const settlement = prepared.shell.executeAction();
		await admitted;
		const close = prepared.shell.close();
		expect(prepared.instrumented.committedTransactions).toHaveLength(before);
		release();
		await expect(settlement).resolves.toMatchObject({ kind: "settle_assistant_effect" });
		await close;
		expect(prepared.instrumented.committedTransactions).toHaveLength(before + 1);
		expect(prepared.instrumented.committedTransactions.at(-1)!.writes).toHaveLength(4);
	});

	it.each(["error", "toolUse", "deferred"] as const)(
		"keeps settled proof and remains write-free when %s classification is unsupported",
		async (stopReason) => {
			const message = terminal(stopReason);
			const prepared = await preparedShell(() => message);
			const before = prepared.instrumented.committedTransactions.length;
			await prepared.shell.executeAction();
			await prepared.shell.executeAction();
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(await prepared.shell.peekAction()).toMatchObject({ kind: "settle_assistant_effect" });
				await expect(prepared.shell.executeAction()).rejects.toMatchObject({ code: "unavailable" });
				expect(prepared.instrumented.committedTransactions).toHaveLength(before);
			}
			await prepared.shell.close();
		},
	);

	it("faults aborted-under-running with the session cause, writes nothing, and reopens uncertain", async () => {
		const prepared = await preparedShell(() => terminal("aborted"));
		const before = prepared.instrumented.committedTransactions.length;
		const fault = await settlePrepared(prepared).catch((error: unknown) => error);
		expect(fault).toMatchObject({
			code: "fault",
			cause: { code: "corruption", message: "Assistant aborted while durable control is running" },
		});
		expect(prepared.instrumented.committedTransactions).toHaveLength(before);
		await prepared.shell.close();
		await expectUncertainReopen(prepared.state);
	});

	it("reopens an atomic successful settlement with complete rows and a finish action", async () => {
		const prepared = await preparedShell(() => terminal());
		await settlePrepared(prepared);
		const state = (await prepared.fixture.storage.getRegister("op.state", prepared.fixture.operationId))!;
		const responseEntryId = (state.value as { latestAssistantEntryId: string }).latestAssistantEntryId;
		const settlement = prepared.instrumented.committedTransactions.at(-1)!;
		const usageWrite = settlement.writes.find((write) => write.kind === "usage");
		if (usageWrite?.kind !== "usage") throw new Error("settlement usage write missing");
		await prepared.shell.close();

		const storage = prepared.state.createStorage();
		const models = createModels();
		const leaseSpy = vi.spyOn(models, "lease");
		const reopened = await createRuntimeShell(session(storage), config(), { models });
		const response = (await storage.getEntries([responseEntryId])).get(responseEntryId);
		const usage = (await storage.getUsageRows([usageWrite.row.id])).get(usageWrite.row.id);
		expect(response?.payload).toMatchObject({ responseId: "upstream-response", stopReason: "stop" });
		expect(usage).toMatchObject({ entryId: responseEntryId, adjustment: false, usage: terminal().usage });
		expect(await reopened.peekAction()).toMatchObject({ kind: "finish_run", triggerEntryId: responseEntryId });
		expect(leaseSpy).not.toHaveBeenCalled();
		await reopened.close();
	});

	it("finishes a durable may_finish checkpoint in the exact terminal transaction and reopens idle", async () => {
		const state = new MemoryStorageState();
		const fixture = await rooted("finish", state.createStorage());
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		const action = await shell.peekAction();
		expect(action).toEqual({
			kind: "finish_run",
			operationId: fixture.operationId,
			triggerEntryId: fixture.response,
		});

		expect(await shell.executeAction()).toEqual(action);
		expect(instrumented.committedTransactions).toHaveLength(1);
		expect(instrumented.committedTransactions[0].writes).toEqual([
			{ kind: "register", op: "delete", namespace: "op.meta", key: fixture.operationId },
			{ kind: "register", op: "delete", namespace: "op.state", key: fixture.operationId },
			{
				kind: "register",
				op: "set",
				namespace: "lane.lastResult",
				key: "main",
				value: {
					operationId: fixture.operationId,
					kind: "run",
					outcome: "completed",
					leafId: fixture.response,
					finalAssistantEntryId: fixture.response,
					runCompletion: "assistant",
				},
			},
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: null, pendingNextRun: [] },
			},
		]);
		expect(await fixture.storage.getRegister("op.meta", fixture.operationId)).toBeUndefined();
		expect(await fixture.storage.getRegister("op.state", fixture.operationId)).toBeUndefined();
		expect(await fixture.storage.getRegister("lane.leaf", "main")).toMatchObject({ value: fixture.response });
		expect(await shell.peekAction()).toBeUndefined();
		await shell.close();

		const reopenedStorage = state.createStorage();
		const reads: string[] = [];
		const getRegister = reopenedStorage.getRegister.bind(reopenedStorage);
		reopenedStorage.getRegister = async (namespace, key) => {
			reads.push(`${namespace}/${key}`);
			return getRegister(namespace, key);
		};
		const reopened = await createRuntimeShell(session(reopenedStorage), config());
		expect(await reopened.peekAction()).toBeUndefined();
		expect(reads).not.toContain("lane.lastResult/main");
		await reopened.close();
	});

	it("deletes defensive operation prefixes in deterministic namespace/key order only", async () => {
		const fixture = await rooted("finish");
		const other = id();
		await fixture.storage.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "op.tool_args", key: `${fixture.operationId}:z`, value: {} },
				{ kind: "register", op: "set", namespace: "op.tool_args", key: `${fixture.operationId}:a`, value: {} },
				{ kind: "register", op: "set", namespace: "op.preparation", key: `${fixture.operationId}:b`, value: {} },
				{ kind: "register", op: "set", namespace: "op.preparation", key: `${fixture.operationId}:a`, value: {} },
				{ kind: "register", op: "set", namespace: "op.tool_args", key: `${other}:keep`, value: {} },
				{
					kind: "register",
					op: "set",
					namespace: "op.tool_args.other",
					key: `${fixture.operationId}:keep`,
					value: {},
				},
			],
		});
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		await shell.executeAction();
		expect(instrumented.committedTransactions).toHaveLength(1);
		expect(instrumented.committedTransactions[0].writes.slice(2, 6)).toEqual([
			{ kind: "register", op: "delete", namespace: "op.tool_args", key: `${fixture.operationId}:a` },
			{ kind: "register", op: "delete", namespace: "op.tool_args", key: `${fixture.operationId}:z` },
			{ kind: "register", op: "delete", namespace: "op.preparation", key: `${fixture.operationId}:a` },
			{ kind: "register", op: "delete", namespace: "op.preparation", key: `${fixture.operationId}:b` },
		]);
		expect(await fixture.storage.getRegister("op.tool_args", `${other}:keep`)).toBeDefined();
		expect(await fixture.storage.getRegister("op.tool_args.other", `${fixture.operationId}:keep`)).toBeDefined();
		await shell.close();
	});

	it("returns only a committed detached internal MemorySession finish result with exact final identities", async () => {
		const fixture = await rooted("finish");
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const operationState = (await fixture.storage.getRegister("op.state", fixture.operationId))!;
		const laneState = (await fixture.storage.getRegister("lane.state", "main"))!;
		const persisted = (await fixture.storage.getEntries([fixture.response])).get(fixture.response)!;
		const result = await runtimeSession.finishRun({
			operationId: fixture.operationId,
			expectedOperationStateSeq: operationState.seq,
			expectedLaneStateSeq: laneState.seq,
		});
		expect(result).toEqual({
			status: "committed",
			attachment: expect.objectContaining({
				laneState: expect.objectContaining({ value: { currentOperationId: null, pendingNextRun: [] } }),
			}),
			result: {
				operationId: fixture.operationId,
				kind: "completed",
				leafId: fixture.response,
				finalEntryId: fixture.response,
				finalMessage: persisted.payload,
			},
		});
		expect(result.status).toBe("committed");
		if (result.status === "committed" && result.result.kind === "completed")
			expect("finalMessage" in result.result).toBe("finalEntryId" in result.result);
		if (
			result.status === "committed" &&
			result.result.kind === "completed" &&
			result.result.finalMessage !== undefined
		) {
			expect(result.result.finalMessage).not.toBe(persisted.payload);
			result.result.finalMessage.content[0] = { type: "text", text: "result mutation" };
			expect((await fixture.storage.getEntries([fixture.response])).get(fixture.response)?.payload).toEqual(
				persisted.payload,
			);
		}
		await runtimeSession.close();
	});

	it.each(["lane.state", "op.state"] as const)(
		"reloads a sequence-stale finish without writing (%s)",
		async (namespace) => {
			const fixture = await rooted("finish");
			const instrumented = instrumentStorage(fixture.storage);
			const shell = await createRuntimeShell(session(instrumented), config());
			const key = namespace === "lane.state" ? "main" : fixture.operationId;
			const current = (await fixture.storage.getRegister(namespace, key))!;
			await fixture.storage.commit({
				writes: [{ kind: "register", op: "set", namespace, key, value: current.value }],
			});
			await expect(shell.executeAction()).rejects.toMatchObject({ code: "stale" });
			expect(instrumented.committedTransactions).toHaveLength(0);
			expect(await shell.peekAction()).toMatchObject({ kind: "finish_run" });
			await shell.close();
		},
	);

	it("keeps wrong operation ownership and an invalid finish boundary write-free in direct transitions", async () => {
		const wrongOwner = await rooted("finish");
		const wrongOwnerInstrumented = instrumentStorage(wrongOwner.storage);
		const wrongOwnerSession = session(wrongOwnerInstrumented);
		const operationState = (await wrongOwner.storage.getRegister("op.state", wrongOwner.operationId))!;
		await wrongOwner.storage.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			],
		});
		const laneState = (await wrongOwner.storage.getRegister("lane.state", "main"))!;
		const obsolete = await wrongOwnerSession.finishRun({
			operationId: wrongOwner.operationId,
			expectedOperationStateSeq: operationState.seq,
			expectedLaneStateSeq: laneState.seq,
		});
		expect(obsolete).toMatchObject({ status: "obsolete" });
		expect(obsolete).not.toHaveProperty("result");
		expect(wrongOwnerInstrumented.committedTransactions).toHaveLength(0);
		await wrongOwnerSession.close();

		const invalid = await rooted("finish");
		const currentState = (await invalid.storage.getRegister("op.state", invalid.operationId))!;
		const invalidValue = structuredClone(currentState.value) as Record<string, JsonValue>;
		const phase = invalidValue.phase as Record<string, JsonValue>;
		phase.continuation = { kind: "may_finish", includeFinalAssistant: false };
		await invalid.storage.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "op.state", key: invalid.operationId, value: invalidValue },
			],
		});
		const invalidInstrumented = instrumentStorage(invalid.storage);
		const invalidSession = session(invalidInstrumented);
		const latestState = (await invalid.storage.getRegister("op.state", invalid.operationId))!;
		const invalidLane = (await invalid.storage.getRegister("lane.state", "main"))!;
		await expect(
			invalidSession.finishRun({
				operationId: invalid.operationId,
				expectedOperationStateSeq: latestState.seq,
				expectedLaneStateSeq: invalidLane.seq,
			}),
		).rejects.toMatchObject({ code: "corruption" });
		expect(invalidInstrumented.committedTransactions).toHaveLength(0);
		await invalidSession.close();
	});

	it("rejects a non-assistant final entry without a terminal write", async () => {
		const fixture = await rooted("finish", new MemoryStorage(), {}, json(user("not final assistant")));
		const instrumented = instrumentStorage(fixture.storage);
		const runtimeSession = session(instrumented);
		const operationState = (await fixture.storage.getRegister("op.state", fixture.operationId))!;
		const laneState = (await fixture.storage.getRegister("lane.state", "main"))!;
		await expect(
			runtimeSession.finishRun({
				operationId: fixture.operationId,
				expectedOperationStateSeq: operationState.seq,
				expectedLaneStateSeq: laneState.seq,
			}),
		).rejects.toMatchObject({ code: "corruption" });
		expect(instrumented.committedTransactions).toHaveLength(0);
		await runtimeSession.close();
	});

	it("faults on terminal commit failure without publishing idle and reopens at the pre-finish checkpoint", async () => {
		const state = new MemoryStorageState();
		const fixture = await rooted("finish", state.createStorage());
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		instrumented.commit = vi.fn().mockRejectedValueOnce(new Error("commit failed"));
		const fault = await shell.executeAction().catch((error: unknown) => error);
		expect(fault).toMatchObject({ code: "fault" });
		await expect(shell.peekAction()).rejects.toBe(fault);
		expect((await fixture.storage.getRegister("lane.state", "main"))!.value).toMatchObject({
			currentOperationId: fixture.operationId,
		});
		await shell.close();
		const reopened = await createRuntimeShell(session(state.createStorage()), config());
		expect(await reopened.peekAction()).toMatchObject({ kind: "finish_run" });
		await reopened.close();
	});

	it("close before finish admission is write-free", async () => {
		const fixture = await rooted("finish");
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		await shell.close();
		await expect(shell.executeAction()).rejects.toMatchObject({ code: "closed" });
		expect(instrumented.committedTransactions).toHaveLength(0);
	});

	it("lets an admitted finish commit before queued close drains", async () => {
		const fixture = await rooted("finish");
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		const commit = instrumented.commit.bind(instrumented);
		let release!: () => void;
		let entered!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const admitted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		instrumented.commit = async (transaction) => {
			entered();
			await blocked;
			return commit(transaction);
		};
		const finish = shell.executeAction();
		await admitted;
		const close = shell.close();
		expect(instrumented.committedTransactions).toHaveLength(0);
		release();
		await expect(finish).resolves.toMatchObject({ kind: "finish_run" });
		await close;
		expect(instrumented.committedTransactions).toHaveLength(1);
	});

	it("close is idempotent, write-free, and rejects later admission", async () => {
		const fixture = await rooted("ready");
		const instrumented = instrumentStorage(fixture.storage);
		const shell = await createRuntimeShell(session(instrumented), config());
		const close = shell.close();
		expect(shell.close()).toBe(close);
		await close;
		await expect(shell.executeAction()).rejects.toMatchObject({ code: "closed" });
		await expect(shell.prompt(user("too late"))).rejects.toMatchObject({ code: "closed" });
		expect(instrumented.committedTransactions).toHaveLength(0);
	});
});
