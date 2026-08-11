import { createModels, type ModelRequestLease } from "@earendil-works/pi-ai";
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

async function rooted(position: "idle" | "need" | "ready" | "pending" | "finish" = "need") {
	const storage = new MemoryStorage();
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
			streamOptions: {},
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
								payload: json({
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
	return { storage, operationId, prompt, source };
}

function session(storage: Storage) {
	return new MemorySession(
		{ id: id(), createdAt: 1, storageVersion: CURRENT_STORAGE_VERSION },
		storage,
		() => undefined,
	);
}

function availableModels() {
	const models = createModels();
	const lease = {
		stream: vi.fn(),
		streamSimple: vi.fn(),
		fetchDeferred: vi.fn(),
		cancelDeferred: vi.fn(),
	} as unknown as ModelRequestLease;
	const leaseSpy = vi.spyOn(models, "lease").mockReturnValue(lease);
	return { models, lease, leaseSpy };
}

describe("Phase 1 runtime shell", () => {
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

	it.each(["ready", "pending", "finish"] as const)(
		"keeps parked %s actions visible and write-free",
		async (position) => {
			const fixture = await rooted(position);
			const instrumented = instrumentStorage(fixture.storage);
			const shell = await createRuntimeShell(session(instrumented), config());
			const action = await shell.peekAction();
			expect(action).toBeDefined();
			await expect(shell.executeAction()).rejects.toMatchObject({ code: "unavailable" });
			expect(await shell.peekAction()).toEqual(action);
			expect(instrumented.committedTransactions).toHaveLength(0);
			await shell.close();
		},
	);

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
