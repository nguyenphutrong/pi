import {
	type JsonValue,
	MemoryStorage,
	MemoryStorageState,
	type Storage,
	type Write,
} from "@nguyenphutrong/pi-session-storage";
import { instrumentStorage } from "@nguyenphutrong/pi-session-storage/testing";
import { describe, expect, it, vi } from "vitest";
import { type LaneConfiguration, type RunState, selectQueueDrain } from "../src/durable.ts";
import { planAction } from "../src/planner.ts";
import { attachRuntime } from "../src/runtime-port.ts";
import { StoredSession } from "../src/session.ts";
import { CURRENT_STORAGE_VERSION } from "../src/types.ts";
import { id, user } from "./fixtures.ts";

const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

function session(storage: Storage): StoredSession {
	return new StoredSession(
		{ id: id(), createdAt: 1, storageVersion: CURRENT_STORAGE_VERSION },
		storage,
		() => undefined,
	);
}

async function active(storage: Storage = new MemoryStorage()) {
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
	const runtimeSession = session(storage);
	const initial = await attachRuntime(runtimeSession, configuration);
	const accepted = await runtimeSession.acceptPrompt({
		messages: [user("prompt")],
		steeringMode: "all",
		followUpMode: "all",
		expectedConfigurationSeq: initial.laneConfiguration.seq,
		expectedLaneStateSeq: initial.laneState.seq,
		expectedPendingNextRun: [],
		expectedLeafSeq: initial.mainLeaf.seq,
		expectedProvider: "test",
		expectedModelId: "model",
		identityAvailable: true,
	});
	if (accepted.status !== "committed") throw new Error("prompt acceptance failed");
	return { runtimeSession, attachment: accepted.attachment, storage };
}

async function cappedFailure(storage: Storage) {
	const prepared = await active(storage);
	const checkpoint = prepared.attachment.runState!;
	const operationId = prepared.attachment.runOperation!.value.operationId;
	const triggerEntryId = checkpoint.value.phase.kind === "checkpoint" ? checkpoint.value.phase.triggerEntryId : "";
	const ready = await prepared.runtimeSession.startAssistantStep({
		operationId,
		triggerEntryId,
		expectedOperationStateSeq: checkpoint.seq,
		expectedLaneStateSeq: prepared.attachment.laneState.seq,
		expectedConfigurationSeq: prepared.attachment.laneConfiguration.seq,
		streamOptions: {},
		retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
	});
	const phase = ready.attachment.runState!.value.phase;
	if (phase.kind !== "assistant" || phase.generation.status !== "ready") throw new Error("assistant ready expected");
	const pending = await prepared.runtimeSession.prepareAssistantEffect({
		operationId,
		stepId: phase.generation.context.stepId,
		attempt: 1,
		expectedOperationStateSeq: ready.attachment.runState!.seq,
		expectedLaneStateSeq: ready.attachment.laneState.seq,
		expectedConfigurationSeq: ready.attachment.laneConfiguration.seq,
		expectedLeafSeq: ready.attachment.mainLeaf.seq,
		expectedLeafId: ready.attachment.mainLeaf.value,
		expectedProvider: "test",
		expectedModelId: "model",
		intendedOutputLimit: 1,
		contextWindow: 2,
	});
	if (!pending.committed) throw new Error("assistant effect preparation expected");
	const failed = await prepared.runtimeSession.recoverAssistantEffect({
		operationId,
		stepId: phase.generation.context.stepId,
		attempt: 1,
		responseEntryId: pending.responseEntryId,
		usageId: pending.usageId,
		expectedOperationStateSeq: pending.attachment.runState!.seq,
		expectedLaneStateSeq: pending.attachment.laneState.seq,
	});
	if (failed.status !== "committed" || failed.attachment.runState!.value.phase.kind !== "failure_drain")
		throw new Error("failure drain expected");
	return { ...prepared, attachment: failed.attachment, operationId, responseEntryId: pending.responseEntryId };
}

function planner(attachment: Awaited<ReturnType<typeof attachRuntime>>) {
	return planAction(attachment, { settingsRevision: 0, assistantEffectStatus: () => undefined })?.info;
}

describe("operation-owned queues", () => {
	it("selectQueueDrain covers checkpoint, finish, failure rescue, skip, cancellation, modes, and immutable copies", () => {
		const base: RunState = {
			kind: "run",
			control: { status: "running" },
			settings: {
				compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
				steeringMode: "all",
				followUpMode: "all",
				toolExecution: "sequential",
			},
			phase: {
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: id(),
			},
			inbox: { steer: [id(), id()], followUp: [id(), id()], writes: [] },
			latestAssistantEntryId: null,
		};
		for (const mode of ["all", "one-at-a-time"] as const) {
			const state = structuredClone(base);
			state.settings.steeringMode = mode;
			state.settings.followUpMode = mode;
			const steer = selectQueueDrain(state)!;
			expect(steer).toEqual({
				kind: "steer",
				entryIds: mode === "all" ? state.inbox.steer : state.inbox.steer.slice(0, 1),
			});
			expect(Object.isFrozen(steer)).toBe(true);
			expect(Object.isFrozen(steer.entryIds)).toBe(true);
			expect(steer.entryIds).not.toBe(state.inbox.steer);
			if (state.phase.kind !== "checkpoint") throw new Error("checkpoint expected");
			state.phase.continuation = { kind: "may_finish", includeFinalAssistant: true };
			state.inbox.steer = [];
			expect(selectQueueDrain(state)).toEqual({
				kind: "followUp",
				entryIds: mode === "all" ? state.inbox.followUp : state.inbox.followUp.slice(0, 1),
			});
			state.phase = {
				kind: "failure_drain",
				error: { code: "provider_interrupted", message: "failed" },
				provenance: { kind: "response", entryId: id() },
			};
			state.inbox.steer = [...base.inbox.steer];
			expect(selectQueueDrain(state)?.kind).toBe("steer");
			state.inbox.steer = [];
			expect(selectQueueDrain(state)?.kind).toBe("followUp");
		}
		const skipped = structuredClone(base);
		if (skipped.phase.kind !== "checkpoint") throw new Error("checkpoint expected");
		skipped.phase.skipInboxOnce = true;
		expect(selectQueueDrain(skipped)).toBeUndefined();
		skipped.phase.continuation = { kind: "may_finish", includeFinalAssistant: true };
		skipped.inbox.steer = [];
		expect(selectQueueDrain(skipped)).toBeUndefined();
		skipped.control = { status: "cancel_requested", requestedAt: 1, drainedSteer: [], drainedFollowUp: [] };
		expect(selectQueueDrain(skipped)).toBeUndefined();
	});

	it.each(["all", "one-at-a-time"] as const)(
		"rescues a canonical failure_drain with %s steer precedence and deterministic fresh reopens",
		async (mode) => {
			const durable = new MemoryStorageState();
			const failed = await cappedFailure(durable.createStorage());
			const steer = await failed.runtimeSession.queueOperationInput("steer", user("rescue"));
			const follow = await failed.runtimeSession.queueOperationInput("followUp", user("later"));
			const state = structuredClone((await failed.runtimeSession.refreshRuntimeAttachment()).runState!.value);
			state.settings.steeringMode = mode;
			await failed.storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: failed.operationId,
						value: state as unknown as JsonValue,
					},
				],
			});
			await failed.runtimeSession.close();
			const reopened = session(durable.createStorage());
			const before = await attachRuntime(reopened, configuration);
			expect(planner(before)).toMatchObject({ kind: "consume_queue", queue: "steer", entryIds: [steer.entryId] });
			const consumed = await reopened.consumeOperationQueue({
				operationId: failed.operationId,
				kind: "steer",
				entryIds: [steer.entryId!],
				expectedOperationStateSeq: before.runState!.seq,
			});
			expect(consumed.attachment.entries.get(steer.entryId!)?.parentId).toBe(failed.responseEntryId);
			expect(consumed.attachment.runState!.value.phase).toMatchObject({ kind: "checkpoint", skipInboxOnce: true });
			expect(consumed.attachment.runState!.value.inbox.followUp).toEqual([follow.entryId]);
			await reopened.close();
			const after = session(durable.createStorage());
			expect(planner(await attachRuntime(after, configuration))?.kind).toBe("start_assistant_step");
			await after.close();
		},
	);

	it("rescues a canonical failure_drain with follow-up when steer is absent", async () => {
		const failed = await cappedFailure(new MemoryStorage());
		const follow = await failed.runtimeSession.queueOperationInput("followUp", user("rescue"));
		const before = await failed.runtimeSession.refreshRuntimeAttachment();
		expect(planner(before)).toMatchObject({ kind: "consume_queue", queue: "followUp", entryIds: [follow.entryId] });
		const consumed = await failed.runtimeSession.consumeOperationQueue({
			operationId: failed.operationId,
			kind: "followUp",
			entryIds: [follow.entryId!],
			expectedOperationStateSeq: before.runState!.seq,
		});
		expect(consumed.attachment.runState!.value.phase).toMatchObject({ kind: "checkpoint", skipInboxOnce: true });
		await failed.runtimeSession.close();
	});

	it("one-at-a-time consume reopens through assistant-ready before the second steer is eligible", async () => {
		const durable = new MemoryStorageState();
		const prepared = await active(durable.createStorage());
		const ids = [
			(await prepared.runtimeSession.queueOperationInput("steer", user("first"))).entryId!,
			(await prepared.runtimeSession.queueOperationInput("steer", user("second"))).entryId!,
		];
		const current = await prepared.runtimeSession.refreshRuntimeAttachment();
		const value = structuredClone(current.runState!.value);
		value.settings.steeringMode = "one-at-a-time";
		await prepared.storage.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: current.runOperation!.value.operationId,
					value: value as unknown as JsonValue,
				},
			],
		});
		const before = await prepared.runtimeSession.refreshRuntimeAttachment();
		await prepared.runtimeSession.consumeOperationQueue({
			operationId: current.runOperation!.value.operationId,
			kind: "steer",
			entryIds: [ids[0]],
			expectedOperationStateSeq: before.runState!.seq,
		});
		await prepared.runtimeSession.close();
		const reopened = session(durable.createStorage());
		const attached = await attachRuntime(reopened, configuration);
		expect(planner(attached)?.kind).toBe("start_assistant_step");
		const checkpoint = attached.runState!.value.phase;
		if (checkpoint.kind !== "checkpoint") throw new Error("checkpoint expected");
		const ready = await reopened.startAssistantStep({
			operationId: current.runOperation!.value.operationId,
			triggerEntryId: checkpoint.triggerEntryId,
			expectedOperationStateSeq: attached.runState!.seq,
			expectedLaneStateSeq: attached.laneState.seq,
			expectedConfigurationSeq: attached.laneConfiguration.seq,
			streamOptions: {},
			retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
		});
		expect(ready.attachment.runState!.value.phase).not.toHaveProperty("skipInboxOnce");
		expect(ready.attachment.runState!.value.inbox.steer).toEqual([ids[1]]);
		await reopened.close();
		const twice = session(durable.createStorage());
		expect(planner(await attachRuntime(twice, configuration))?.kind).toBe("prepare_assistant_effect");
		await twice.close();
	});

	it("orders cancelQueued and consume_queue on the mutation line in both histories", async () => {
		for (const first of ["cancel", "consume"] as const) {
			const storage = instrumentStorage(new MemoryStorage());
			const prepared = await active(storage);
			const queued = await prepared.runtimeSession.queueOperationInput("steer", user("queued"));
			const before = await prepared.runtimeSession.refreshRuntimeAttachment();
			const transition = {
				operationId: before.runOperation!.value.operationId,
				kind: "steer" as const,
				entryIds: [queued.entryId!],
				expectedOperationStateSeq: before.runState!.seq,
			};
			storage.committedTransactions.length = 0;
			if (first === "cancel") {
				expect((await prepared.runtimeSession.cancelQueued(queued.entryId!)).outcome).toBe("cancelled");
				expect((await prepared.runtimeSession.consumeOperationQueue(transition)).committed).toBe(false);
				expect(storage.committedTransactions).toHaveLength(1);
			} else {
				expect((await prepared.runtimeSession.consumeOperationQueue(transition)).committed).toBe(true);
				expect((await prepared.runtimeSession.cancelQueued(queued.entryId!)).outcome).toBe("already_consumed");
				expect(storage.committedTransactions).toHaveLength(1);
			}
			await prepared.runtimeSession.close();
		}
	});

	it("orders operation queue admission and abort with no pending orphan", async () => {
		for (const first of ["admission", "abort"] as const) {
			const prepared = await active();
			if (first === "admission") {
				const queued = await prepared.runtimeSession.queueOperationInput("steer", user("queued"));
				const aborted = await prepared.runtimeSession.requestAbort(() => undefined);
				expect(aborted).toMatchObject({ status: "committed", drainedSteer: [user("queued")] });
				expect(aborted.attachment.runState!.value.control).toMatchObject({ drainedSteer: [queued.entryId] });
			} else {
				await prepared.runtimeSession.requestAbort(() => undefined);
				await expect(prepared.runtimeSession.queueOperationInput("steer", user("late"))).rejects.toMatchObject({
					code: "invalid_query",
				});
				expect((await prepared.runtimeSession.refreshRuntimeAttachment()).pendingEntries.size).toBe(0);
			}
			await prepared.runtimeSession.close();
		}
	});

	it("orders nextRun and finish while preserving the accepted idle queue", async () => {
		for (const first of ["enqueue", "finish"] as const) {
			const prepared = await cappedFailure(new MemoryStorage());
			const before = await prepared.runtimeSession.refreshRuntimeAttachment();
			const queued = first === "enqueue" ? await prepared.runtimeSession.nextRun(user("next")) : undefined;
			const finish = await prepared.runtimeSession.finishRun({
				operationId: prepared.operationId,
				expectedOperationStateSeq: before.runState!.seq,
			});
			expect(finish.status).toBe("committed");
			const accepted = queued ?? (await prepared.runtimeSession.nextRun(user("next")));
			const current = await prepared.runtimeSession.refreshRuntimeAttachment();
			expect(current.laneState.value).toEqual({ currentOperationId: null, pendingNextRun: [accepted.entryId] });
			expect(current.pendingEntries.get(accepted.entryId!)?.payload).toEqual(user("next"));
			await prepared.runtimeSession.close();
		}
	});

	it("orders abort and finish at a valid terminal boundary", async () => {
		for (const first of ["abort", "finish"] as const) {
			const prepared = await cappedFailure(new MemoryStorage());
			const before = await prepared.runtimeSession.refreshRuntimeAttachment();
			if (first === "abort") {
				expect((await prepared.runtimeSession.requestAbort(() => undefined)).status).toBe("committed");
				const state = await prepared.runtimeSession.refreshRuntimeAttachment();
				const finished = await prepared.runtimeSession.finishRun({
					operationId: prepared.operationId,
					expectedOperationStateSeq: state.runState!.seq,
				});
				expect(finished).toMatchObject({ status: "committed", result: { kind: "aborted" } });
			} else {
				expect(
					(
						await prepared.runtimeSession.finishRun({
							operationId: prepared.operationId,
							expectedOperationStateSeq: before.runState!.seq,
						})
					).status,
				).toBe("committed");
				expect((await prepared.runtimeSession.requestAbort(() => undefined)).status).toBe("no_active");
			}
			const current = await prepared.runtimeSession.refreshRuntimeAttachment();
			expect(current.runState).toBeUndefined();
			expect(current.pendingEntries.size).toBe(0);
			await prepared.runtimeSession.close();
		}
	});
	it("admits steer and follow-up with exact transactions and cancels only the selected queue item", async () => {
		const delegate = new MemoryStorage();
		const prepared = await active(delegate);
		const storage = instrumentStorage(delegate);
		const runtimeSession = session(storage);
		await attachRuntime(runtimeSession, configuration);
		const steer = await runtimeSession.queueOperationInput("steer", user("steer"));
		const followUp = await runtimeSession.queueOperationInput("followUp", user("follow"));
		expect(storage.committedTransactions[0].writes).toEqual([
			{
				kind: "register",
				op: "set",
				namespace: "pending.entry",
				key: steer.entryId,
				value: { type: "message", payload: user("steer") },
			},
			expect.objectContaining({
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: prepared.attachment.runOperation!.value.operationId,
			}),
		]);
		expect(storage.committedTransactions[1].writes).toEqual([
			{
				kind: "register",
				op: "set",
				namespace: "pending.entry",
				key: followUp.entryId,
				value: { type: "message", payload: user("follow") },
			},
			expect.objectContaining({
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: prepared.attachment.runOperation!.value.operationId,
			}),
		]);
		expect((await runtimeSession.cancelQueued(steer.entryId!)).outcome).toBe("cancelled");
		expect(storage.committedTransactions[2].writes).toEqual([
			expect.objectContaining({ kind: "register", op: "set", namespace: "op.state" }),
			{ kind: "register", op: "delete", namespace: "pending.entry", key: steer.entryId },
		]);
		const restored = await runtimeSession.refreshRuntimeAttachment();
		expect(restored.runState!.value.inbox).toEqual({ steer: [], followUp: [followUp.entryId], writes: [] });
		expect(restored.pendingEntries.has(steer.entryId!)).toBe(false);
		expect(restored.pendingEntries.get(followUp.entryId!)?.payload).toEqual(user("follow"));
		await runtimeSession.close();
		await prepared.runtimeSession.close();
	});

	it.each(["all", "one-at-a-time"] as const)(
		"places %s steering in FIFO parent order and leaves the exact remainder",
		async (mode) => {
			const prepared = await active();
			const ids = [];
			for (const text of ["a", "b", "c"])
				ids.push((await prepared.runtimeSession.queueOperationInput("steer", user(text))).entryId!);
			const current = await prepared.runtimeSession.refreshRuntimeAttachment();
			const operationId = current.runOperation!.value.operationId;
			const state = structuredClone(current.runState!.value);
			state.settings.steeringMode = mode;
			await prepared.storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: state as unknown as JsonValue,
					},
				],
			});
			const before = await prepared.runtimeSession.refreshRuntimeAttachment();
			const consume = mode === "all" ? ids : [ids[0]];
			const result = await prepared.runtimeSession.consumeOperationQueue({
				operationId,
				kind: "steer",
				entryIds: consume,
				expectedOperationStateSeq: before.runState!.seq,
			});
			expect(result.committed).toBe(true);
			for (const [index, entryId] of consume.entries())
				expect(result.attachment.entries.get(entryId)?.parentId).toBe(
					index === 0 ? current.mainLeaf.value : consume[index - 1],
				);
			expect(result.attachment.runState!.value.inbox.steer).toEqual(mode === "all" ? [] : ids.slice(1));
			expect(result.attachment.runState!.value.phase).toEqual({
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: consume.at(-1),
				skipInboxOnce: true,
			});
			for (const entryId of consume)
				expect(await prepared.storage.getRegister("pending.entry", entryId)).toBeUndefined();
			for (const entryId of ids.slice(consume.length))
				expect(await prepared.storage.getRegister("pending.entry", entryId)).toBeDefined();
			await prepared.runtimeSession.close();
		},
	);

	it.each(["all", "one-at-a-time"] as const)(
		"commits the exact %s consume transaction and returned sequence mapping",
		async (mode) => {
			const delegate = new MemoryStorage();
			const prepared = await active(delegate);
			const storage = instrumentStorage(delegate);
			const runtimeSession = session(storage);
			await attachRuntime(runtimeSession, configuration);
			const ids = [
				(await runtimeSession.queueOperationInput("steer", user("first"))).entryId!,
				(await runtimeSession.queueOperationInput("steer", user("second"))).entryId!,
			];
			const before = await runtimeSession.refreshRuntimeAttachment();
			const operationId = before.runOperation!.value.operationId;
			const state = structuredClone(before.runState!.value);
			state.settings.steeringMode = mode;
			await delegate.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: state as unknown as JsonValue,
					},
				],
			});
			const current = await runtimeSession.refreshRuntimeAttachment();
			storage.committedTransactions.length = 0;
			const consumed = mode === "all" ? ids : ids.slice(0, 1);
			const result = await runtimeSession.consumeOperationQueue({
				operationId,
				kind: "steer",
				entryIds: consumed,
				expectedOperationStateSeq: current.runState!.seq,
			});
			const transaction = storage.committedTransactions[0];
			let parentId = current.mainLeaf.value;
			const expectedEntries = consumed.map((entryId, index) => {
				const write = {
					kind: "entry" as const,
					entry: {
						id: entryId,
						parentId,
						type: "message" as const,
						payload: user(index === 0 ? "first" : "second"),
					},
				};
				parentId = entryId;
				return write;
			});
			expect(transaction.writes).toEqual([
				...expectedEntries,
				...consumed.map((key) => ({ kind: "register", op: "delete", namespace: "pending.entry", key })),
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: consumed.at(-1) },
				expect.objectContaining({ kind: "register", op: "set", namespace: "op.state", key: operationId }),
			]);
			const firstSeq = result.attachment.entries.get(consumed[0])!.seq;
			for (const [index, entryId] of consumed.entries())
				expect(result.attachment.entries.get(entryId)?.seq).toBe(firstSeq + index);
			expect(result.attachment.mainLeaf).toEqual({
				seq: firstSeq + consumed.length * 2,
				value: consumed.at(-1),
			});
			expect(result.attachment.runState!.seq).toBe(firstSeq + consumed.length * 2 + 1);
			expect(result.attachment.runState!.value.inbox.steer).toEqual(mode === "all" ? [] : [ids[1]]);
			await runtimeSession.close();
			await prepared.runtimeSession.close();
		},
	);

	it("planner prioritizes steer, skips it once for generation, and admits follow-up only at may_finish", async () => {
		const prepared = await active();
		const steer = await prepared.runtimeSession.queueOperationInput("steer", user("s"));
		const follow = await prepared.runtimeSession.queueOperationInput("followUp", user("f"));
		const current = await prepared.runtimeSession.refreshRuntimeAttachment();
		expect(planner(current)).toEqual({
			kind: "consume_queue",
			operationId: current.runOperation!.value.operationId,
			queue: "steer",
			entryIds: [steer.entryId],
		});
		const state = structuredClone(current.runState!.value);
		if (state.phase.kind !== "checkpoint") throw new Error("checkpoint expected");
		state.phase.skipInboxOnce = true;
		const modified = { ...current, runState: { ...current.runState!, value: state } };
		expect(planner(modified)?.kind).toBe("start_assistant_step");
		state.phase = {
			kind: "checkpoint",
			continuation: { kind: "may_finish", includeFinalAssistant: true },
			triggerEntryId: state.phase.triggerEntryId,
		};
		state.inbox.steer = [];
		expect(planner(modified)).toEqual({
			kind: "consume_queue",
			operationId: current.runOperation!.value.operationId,
			queue: "followUp",
			entryIds: [follow.entryId],
		});
		state.control = { status: "cancel_requested", requestedAt: 1, drainedSteer: [], drainedFollowUp: [] };
		expect(planner(modified)?.kind).toBe("finish_aborted_run");
		await prepared.runtimeSession.close();
	});

	it.each([
		["follow-up before may_finish", "followUp", "follow-checkpoint", "all", [0]],
		["wrong queue kind", "followUp", "need", "all", [0]],
		["steer while skipInboxOnce", "steer", "skip", "all", [0, 1]],
		["more than one item in one-at-a-time mode", "steer", "need", "one-at-a-time", [0, 1]],
		["non-FIFO order", "steer", "need", "all", [1, 0]],
		["cancelled run", "steer", "cancelled", "all", [0, 1]],
	] as const)("makes a direct invalid queue transition write-free: %s", async (_name, kind, phase, mode, indices) => {
		const delegate = new MemoryStorage();
		const prepared = await active(delegate);
		const steerIds = [
			(await prepared.runtimeSession.queueOperationInput("steer", user("first"))).entryId!,
			(await prepared.runtimeSession.queueOperationInput("steer", user("second"))).entryId!,
		];
		const followId = (await prepared.runtimeSession.queueOperationInput("followUp", user("follow"))).entryId!;
		const before = await prepared.runtimeSession.refreshRuntimeAttachment();
		const operationId = before.runOperation!.value.operationId;
		const state = structuredClone(before.runState!.value);
		state.settings.steeringMode = mode;
		if (phase === "follow-checkpoint") state.inbox.steer = [];
		if (phase === "skip" && state.phase.kind === "checkpoint") state.phase.skipInboxOnce = true;
		if (phase === "cancelled")
			state.control = { status: "cancel_requested", requestedAt: 1, drainedSteer: [], drainedFollowUp: [] };
		await delegate.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: operationId,
					value: state as unknown as JsonValue,
				},
				...(phase === "follow-checkpoint"
					? steerIds.map((key) => ({
							kind: "register" as const,
							op: "delete" as const,
							namespace: "pending.entry",
							key,
						}))
					: []),
			],
		});
		const storage = instrumentStorage(delegate);
		const runtimeSession = session(storage);
		const current = await attachRuntime(runtimeSession, configuration);
		const available = kind === "steer" ? steerIds : [followId];
		const result = await runtimeSession.consumeOperationQueue({
			operationId,
			kind,
			entryIds: indices.map((index) => available[index]!),
			expectedOperationStateSeq: current.runState!.seq,
		});
		expect(result).toMatchObject({ committed: false, attachment: { runState: { seq: current.runState!.seq } } });
		expect(storage.committedTransactions).toHaveLength(0);
		expect((await delegate.getRegister("op.state", operationId))?.seq).toBe(current.runState!.seq);
		await runtimeSession.close();
		await prepared.runtimeSession.close();
	});

	it("commits the exact selector-backed plan", async () => {
		const prepared = await active();
		await prepared.runtimeSession.queueOperationInput("steer", user("first"));
		await prepared.runtimeSession.queueOperationInput("steer", user("second"));
		const current = await prepared.runtimeSession.refreshRuntimeAttachment();
		const action = planner(current);
		if (action?.kind !== "consume_queue") throw new Error("consume plan expected");
		const result = await prepared.runtimeSession.consumeOperationQueue({
			operationId: action.operationId,
			kind: action.queue,
			entryIds: action.entryIds,
			expectedOperationStateSeq: current.runState!.seq,
		});
		expect(result.committed).toBe(true);
		expect(result.attachment.runState!.value.inbox.steer).toEqual([]);
		await prepared.runtimeSession.close();
	});

	it("first abort drains exact payloads in one state write, repeat is write-free, and drained cancellation is not_found", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1234);
		const delegate = new MemoryStorage();
		const prepared = await active(delegate);
		const storage = instrumentStorage(delegate);
		const runtimeSession = session(storage);
		await attachRuntime(runtimeSession, configuration);
		const steer = await runtimeSession.queueOperationInput("steer", user("s"));
		const follow = await runtimeSession.queueOperationInput("followUp", user("f"));
		storage.committedTransactions.length = 0;
		const first = await runtimeSession.requestAbort(() => undefined);
		expect(first).toMatchObject({ status: "committed", drainedSteer: [user("s")], drainedFollowUp: [user("f")] });
		expect(storage.committedTransactions).toHaveLength(1);
		expect(storage.committedTransactions[0].writes).toEqual([
			expect.objectContaining({
				kind: "register",
				op: "set",
				namespace: "op.state",
				value: expect.objectContaining({
					control: {
						status: "cancel_requested",
						requestedAt: 1234,
						drainedSteer: [steer.entryId],
						drainedFollowUp: [follow.entryId],
					},
					inbox: { steer: [], followUp: [], writes: [] },
				}),
			}),
		]);
		const repeated = await runtimeSession.requestAbort(() => undefined);
		expect(repeated).toMatchObject({
			status: "already_requested",
			drainedSteer: [user("s")],
			drainedFollowUp: [user("f")],
		});
		expect(storage.committedTransactions).toHaveLength(1);
		expect((await runtimeSession.cancelQueued(steer.entryId!)).outcome).toBe("not_found");
		expect(await delegate.getRegister("pending.entry", steer.entryId!)).toBeDefined();
		await runtimeSession.close();
		await prepared.runtimeSession.close();
		vi.restoreAllMocks();
	});

	it("reopens active and drained queues and terminal cleanup deletes only operation ownership", async () => {
		const state = new MemoryStorageState();
		const first = await active(state.createStorage());
		const steer = await first.runtimeSession.queueOperationInput("steer", user("s"));
		const follow = await first.runtimeSession.queueOperationInput("followUp", user("f"));
		const next = await first.runtimeSession.nextRun(user("next"));
		await first.runtimeSession.requestAbort(() => undefined);
		const operationId = first.attachment.runOperation!.value.operationId;
		await first.runtimeSession.close();
		const reopened = session(state.createStorage());
		const attachment = await attachRuntime(reopened, configuration);
		expect(attachment.runState!.value.control).toMatchObject({
			drainedSteer: [steer.entryId],
			drainedFollowUp: [follow.entryId],
		});
		expect([...attachment.pendingEntries.keys()]).toEqual([next.entryId, steer.entryId, follow.entryId]);
		const result = await reopened.finishRun({ operationId, expectedOperationStateSeq: attachment.runState!.seq });
		expect(result.status).toBe("committed");
		const persisted = state.createStorage();
		for (const entryId of [steer.entryId!, follow.entryId!])
			expect(await persisted.getRegister("pending.entry", entryId)).toBeUndefined();
		expect(await persisted.getRegister("pending.entry", next.entryId!)).toBeDefined();
		expect((await persisted.getRegister("lane.state", "main"))?.value).toEqual({
			currentOperationId: null,
			pendingNextRun: [next.entryId],
		});
		await persisted.close();
		await reopened.close();
	});

	it.each(["active", "drained"] as const)(
		"rejects a generated next-run id colliding with an %s operation queue without writing",
		async (kind) => {
			const delegate = new MemoryStorage();
			const prepared = await active(delegate);
			const queued = await prepared.runtimeSession.queueOperationInput("steer", user("reserved"));
			if (kind === "drained") await prepared.runtimeSession.requestAbort(() => undefined);
			const storage = instrumentStorage(delegate);
			const runtimeSession = session(storage);
			await attachRuntime(runtimeSession, configuration);
			vi.spyOn(runtimeSession.idGenerator, "next").mockReturnValueOnce(queued.entryId!);
			await expect(runtimeSession.nextRun(user("collision"))).rejects.toMatchObject({ code: "storage" });
			expect(storage.committedTransactions).toEqual([]);
			await runtimeSession.close();
			await prepared.runtimeSession.close();
		},
	);

	it("rejects cross-list, cross-lane, missing, malformed, materialized, and deferred-write references on reopen", async () => {
		const cases = ["cross-list", "cross-lane", "missing", "malformed", "materialized", "write"] as const;
		for (const kind of cases) {
			const durable = new MemoryStorageState();
			const prepared = await active(durable.createStorage());
			const queued = await prepared.runtimeSession.queueOperationInput("steer", user("q"));
			const attachment = await prepared.runtimeSession.refreshRuntimeAttachment();
			const operationId = attachment.runOperation!.value.operationId;
			const value = structuredClone(attachment.runState!.value) as RunState;
			const writes: Write[] = [];
			if (kind === "cross-list") value.inbox.followUp = [queued.entryId!];
			if (kind === "cross-lane") {
				const lane = structuredClone(attachment.laneState.value);
				lane.pendingNextRun = [queued.entryId!];
				writes.push({
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: lane as unknown as JsonValue,
				});
			}
			if (kind === "missing")
				writes.push({ kind: "register", op: "delete", namespace: "pending.entry", key: queued.entryId! });
			if (kind === "malformed")
				writes.push({
					kind: "register",
					op: "set",
					namespace: "pending.entry",
					key: queued.entryId!,
					value: { type: "message" },
				});
			if (kind === "materialized")
				writes.push({
					kind: "entry",
					entry: {
						id: queued.entryId!,
						parentId: null,
						type: "message",
						payload: user("q") as unknown as JsonValue,
					},
				});
			if (kind === "write")
				value.inbox = { ...value.inbox, steer: [], writes: [queued.entryId!] } as unknown as RunState["inbox"];
			writes.unshift({
				kind: "register",
				op: "set",
				namespace: "op.state",
				key: operationId,
				value: value as unknown as JsonValue,
			});
			await prepared.storage.commit({ writes });
			await prepared.runtimeSession.close();
			const reopened = session(durable.createStorage());
			await expect(attachRuntime(reopened, configuration)).rejects.toMatchObject({ code: "corruption" });
			await reopened.close();
		}
	});

	it.each(["active-steer", "active-followUp", "drained-steer", "drained-followUp", "bad-id"] as const)(
		"rejects duplicate or malformed operation queue ownership: %s",
		async (kind) => {
			const durable = new MemoryStorageState();
			const prepared = await active(durable.createStorage());
			const queued = await prepared.runtimeSession.queueOperationInput(
				kind.includes("followUp") ? "followUp" : "steer",
				user("q"),
			);
			if (kind.startsWith("drained")) await prepared.runtimeSession.requestAbort(() => undefined);
			const attachment = await prepared.runtimeSession.refreshRuntimeAttachment();
			const value = structuredClone(attachment.runState!.value);
			if (kind === "active-steer") value.inbox.steer.push(queued.entryId!);
			if (kind === "active-followUp") value.inbox.followUp.push(queued.entryId!);
			if (kind === "drained-steer" && value.control.status === "cancel_requested")
				value.control.drainedSteer.push(queued.entryId!);
			if (kind === "drained-followUp" && value.control.status === "cancel_requested")
				value.control.drainedFollowUp.push(queued.entryId!);
			if (kind === "bad-id") value.inbox.steer = ["not-a-uuid"];
			await prepared.storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: attachment.runOperation!.value.operationId,
						value: value as unknown as JsonValue,
					},
				],
			});
			await prepared.runtimeSession.close();
			const reopened = session(durable.createStorage());
			await expect(attachRuntime(reopened, configuration)).rejects.toMatchObject({ code: "corruption" });
			await reopened.close();
		},
	);
});
