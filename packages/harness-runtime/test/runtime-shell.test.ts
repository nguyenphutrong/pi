import { type AssistantMessage, type Context, createModels, type ModelRequestLease } from "@earendil-works/pi-ai";
import {
	type JsonValue,
	MemoryStorage,
	MemoryStorageState,
	type Storage,
	type Write,
} from "@earendil-works/pi-session-storage";
import { instrumentStorage } from "@earendil-works/pi-session-storage/testing";
import { describe, expect, it, vi } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import { createRuntimeShell } from "../src/runtime-shell.ts";
import { MemorySession } from "../src/session.ts";
import { CURRENT_STORAGE_VERSION } from "../src/types.ts";
import { asMessage, assistant, id, toolResult, user, ZERO_USAGE } from "./fixtures.ts";

const config = (): LaneConfiguration => ({
	model: { provider: "test", modelId: "current" },
	thinkingLevel: "medium",
	activeToolNames: [],
});
const json = (value: unknown): JsonValue => value as JsonValue;

async function rooted(
	position: "idle" | "need" | "ready" | "pending" | "finish" = "need",
	storage: Storage = new MemoryStorage(),
	streamOptions: JsonValue = {},
	finalPayload?: JsonValue,
) {
	const operationId = id();
	const source = id();
	const prompt = id();
	const response = id();
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
			configuration: config(),
			streamOptions,
			retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
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
								attempt: 1,
								responseEntryId: id(),
								usageId: id(),
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
				value: config() as unknown as JsonValue,
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
	return { storage, operationId, prompt, response, source, stepId };
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

async function settlePrepared(prepared: Awaited<ReturnType<typeof preparedShell>>) {
	await prepared.shell.executeAction();
	await prepared.shell.executeAction();
	expect(await prepared.shell.peekAction()).toMatchObject({ kind: "settle_assistant_effect" });
	return prepared.shell.executeAction();
}

async function preparedShell(result: () => Promise<AssistantMessage> | AssistantMessage) {
	const state = new MemoryStorageState();
	const durableOptions = { headers: { retained: "yes" }, metadata: { nested: [1] } };
	const fixture = await rooted("ready", state.createStorage(), durableOptions);
	const instrumented = instrumentStorage(fixture.storage);
	const runtimeSession = session(instrumented);
	const projection = vi.spyOn(runtimeSession, "projectBuiltinContext");
	vi.spyOn(runtimeSession.idGenerator, "next").mockReturnValueOnce(id()).mockReturnValueOnce(id());
	const { models, lease, leaseSpy } = availableModels();
	const streamSimple = vi.mocked(lease.streamSimple);
	streamSimple.mockReturnValue({ result } as ReturnType<ModelRequestLease["streamSimple"]>);
	const shell = await createRuntimeShell(runtimeSession, config(), {
		models,
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
	await expect(shell.executeAction()).rejects.toMatchObject({ code: "unavailable" });
	expect(lease).not.toHaveBeenCalled();
	expect(instrumented.committedTransactions).toHaveLength(0);
	await shell.close();
	expect(instrumented.committedTransactions).toHaveLength(0);
}

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

	it.each(["ready", "pending"] as const)("keeps parked %s actions visible and write-free", async (position) => {
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
		await expect(reopened.executeAction()).rejects.toMatchObject({ code: "unavailable" });
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
		if (result.status === "committed") {
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
