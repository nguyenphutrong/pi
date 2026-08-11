import { type JsonValue, MemoryStorage, type Storage, type Write } from "@earendil-works/pi-session-storage";
import { instrumentStorage } from "@earendil-works/pi-session-storage/testing";
import { describe, expect, it, vi } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import { createRuntimeShell } from "../src/runtime-shell.ts";
import { MemorySession } from "../src/session.ts";
import { CURRENT_STORAGE_VERSION } from "../src/types.ts";
import { id, user } from "./fixtures.ts";

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

describe("Phase 1 runtime shell", () => {
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
		expect(instrumented.committedTransactions).toHaveLength(0);
	});
});
