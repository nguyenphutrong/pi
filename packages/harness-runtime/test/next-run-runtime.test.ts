import { type AssistantMessage, createModels, type ModelRequestLease } from "@earendil-works/pi-ai";
import { MemoryStorage, MemoryStorageState, type Storage } from "@nguyenphutrong/pi-session-storage";
import { instrumentStorage } from "@nguyenphutrong/pi-session-storage/testing";
import { describe, expect, it, vi } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import { createRuntimeShell, type RuntimeShellOptions } from "../src/runtime-shell.ts";
import { StoredSession } from "../src/session.ts";
import { id, user } from "./fixtures.ts";

const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

async function runtime(storage: Storage = new MemoryStorage(), options: RuntimeShellOptions = {}) {
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
	const observed = instrumentStorage(storage);
	const session = new StoredSession({ id: id(), createdAt: 1, storageVersion: 1 }, observed, () => undefined);
	const models = createModels();
	const lease = vi.spyOn(models, "lease").mockReturnValue({} as never);
	const shell = await createRuntimeShell(session, configuration, { ...options, models });
	observed.committedTransactions.length = 0;
	return { storage, observed, session, models, lease, shell };
}

function completedAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "test",
		provider: "test",
		model: "model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

async function runtimeWithAssistant(state = new MemoryStorageState(), options: RuntimeShellOptions = {}) {
	const storage = state.createStorage();
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
	const models = createModels();
	const lease = {
		model: { provider: "test", id: "model", maxTokens: 128, contextWindow: 1024 },
		stream: vi.fn(),
		streamSimple: vi.fn(
			() => ({ result: async () => completedAssistant() }) as ReturnType<ModelRequestLease["streamSimple"]>,
		),
		fetchDeferred: vi.fn(),
		cancelDeferred: vi.fn(),
	} as unknown as ModelRequestLease;
	vi.spyOn(models, "lease").mockReturnValue(lease);
	const runtimeSession = new StoredSession({ id: id(), createdAt: 1, storageVersion: 1 }, storage, () => undefined);
	const shell = await createRuntimeShell(runtimeSession, configuration, { ...options, models });
	return { state, storage, runtimeSession, shell };
}

describe("RuntimeShell next-run queue", () => {
	it("exposes steer and follow-up end to end and consumes the planned steer through executeAction", async () => {
		const fixture = await runtime();
		const accepted = await fixture.shell.prompt(user("prompt"));
		const steerPayload = user("steer");
		const followPayload = user("follow");
		const steer = await fixture.shell.steer(steerPayload);
		const follow = await fixture.shell.followUp(followPayload);
		const persisted = await fixture.session.refreshRuntimeAttachment();
		expect(persisted.runState?.value.inbox).toEqual({
			steer: [steer.entryId],
			followUp: [follow.entryId],
			writes: [],
		});
		expect(persisted.pendingEntries.get(steer.entryId)?.payload).toEqual(steerPayload);
		expect(persisted.pendingEntries.get(follow.entryId)?.payload).toEqual(followPayload);
		expect(await fixture.shell.executeAction()).toEqual({
			kind: "consume_queue",
			operationId: accepted.runOperation!.value.operationId,
			queue: "steer",
			entryIds: [steer.entryId],
		});
		const consumed = await fixture.session.refreshRuntimeAttachment();
		expect(consumed.mainLeaf.value).toBe(steer.entryId);
		expect(consumed.entries.get(steer.entryId)?.message).toEqual(steerPayload);
		expect(consumed.runState?.value.inbox).toEqual({ steer: [], followUp: [follow.entryId], writes: [] });
		await fixture.shell.close();
	});

	it("keeps idle and cancelling operation-queue unavailability non-fatal", async () => {
		const fixture = await runtime();
		await expect(fixture.shell.steer(user("idle steer"))).rejects.toMatchObject({ code: "unavailable" });
		await expect(fixture.shell.followUp(user("idle follow"))).rejects.toMatchObject({ code: "unavailable" });
		await fixture.shell.prompt(user("prompt"));
		await fixture.shell.abort();
		await expect(fixture.shell.steer(user("cancel steer"))).rejects.toMatchObject({ code: "unavailable" });
		await expect(fixture.shell.followUp(user("cancel follow"))).rejects.toMatchObject({ code: "unavailable" });
		expect(await fixture.shell.nextRun(user("still usable"))).toHaveProperty("entryId");
		await fixture.shell.close();
	});

	it("returns deeply detached immutable abort payloads and repeats without a second commit", async () => {
		const fixture = await runtime();
		await fixture.shell.prompt(user("prompt"));
		const steerPayload = user("steer");
		const followPayload = user("follow");
		await fixture.shell.steer(steerPayload);
		await fixture.shell.followUp(followPayload);
		const before = fixture.observed.committedTransactions.length;
		const first = await fixture.shell.abort();
		steerPayload.content = "caller mutation";
		followPayload.content = "caller mutation";
		expect(first.drainedSteer).toEqual([user("steer")]);
		expect(first.drainedFollowUp).toEqual([user("follow")]);
		expect(Object.isFrozen(first.drainedSteer)).toBe(true);
		expect(Object.isFrozen(first.drainedSteer[0])).toBe(true);
		expect(await fixture.shell.abort()).toEqual(first);
		expect(fixture.observed.committedTransactions).toHaveLength(before + 1);
		await fixture.shell.close();
	});

	it.each(["read", "commit"] as const)(
		"faults and seals identically on admitted steer %s failure",
		async (failure) => {
			const fixture = await runtime();
			await fixture.shell.prompt(user("prompt"));
			if (failure === "read") fixture.observed.getRegister = vi.fn().mockRejectedValueOnce(new Error("read failed"));
			else fixture.observed.commit = vi.fn().mockRejectedValueOnce(new Error("commit failed"));
			const fault = await fixture.shell.steer(user("failure")).catch((error: unknown) => error);
			expect(fault).toMatchObject({ code: "fault" });
			await expect(fixture.shell.peekAction()).rejects.toBe(fault);
			await expect(fixture.shell.steer(user("later"))).rejects.toBe(fault);
			await fixture.shell.close();
		},
	);

	it("close rejects every operation-queue method without writes", async () => {
		const fixture = await runtime();
		await fixture.shell.close();
		await expect(fixture.shell.steer(user("late"))).rejects.toMatchObject({ code: "closed" });
		await expect(fixture.shell.followUp(user("late"))).rejects.toMatchObject({ code: "closed" });
		await expect(fixture.shell.cancelQueued(id())).rejects.toMatchObject({ code: "closed" });
		expect(fixture.observed.committedTransactions).toEqual([]);
	});

	it("durably consumes follow-up after a real settled assistant and reopens at assistant work", async () => {
		const fixture = await runtimeWithAssistant(undefined, { followUpMode: "one-at-a-time" });
		await fixture.shell.prompt(user("prompt"));
		for (let index = 0; index < 5; index++) await fixture.shell.executeAction();
		expect(await fixture.shell.peekAction()).toMatchObject({ kind: "finish_run" });
		const first = await fixture.shell.followUp(user("first"));
		const second = await fixture.shell.followUp(user("second"));
		expect(await fixture.shell.executeAction()).toMatchObject({
			kind: "consume_queue",
			queue: "followUp",
			entryIds: [first.entryId],
		});
		const after = await fixture.runtimeSession.refreshRuntimeAttachment();
		expect(after.runState?.value).toMatchObject({
			phase: {
				kind: "checkpoint",
				continuation: { kind: "need_assistant" },
				skipInboxOnce: true,
				triggerEntryId: first.entryId,
			},
			inbox: { followUp: [second.entryId] },
		});
		await fixture.shell.close();
		const reopenedStorage = fixture.state.createStorage();
		const reopenedSession = new StoredSession(
			{ id: id(), createdAt: 1, storageVersion: 1 },
			reopenedStorage,
			() => undefined,
		);
		const reopened = await createRuntimeShell(reopenedSession, configuration);
		expect(await reopened.peekAction()).toMatchObject({
			kind: "start_assistant_step",
			triggerEntryId: first.entryId,
		});
		await reopened.executeAction();
		expect(await reopened.peekAction()).toMatchObject({ kind: "prepare_assistant_effect" });
		expect(await reopenedStorage.getRegister("pending.entry", second.entryId)).toBeDefined();
		await reopened.close();
	});
	it("captures one-at-a-time queue modes atomically with public prompt acceptance", async () => {
		const fixture = await runtime(new MemoryStorage(), {
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
		});
		const accepted = await fixture.shell.prompt(user("prompt"));
		expect(accepted.runState?.value.settings).toMatchObject({
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
		});
		const persisted = await fixture.storage.getRegister("op.state", accepted.runOperation!.value.operationId);
		expect(persisted?.value).toMatchObject({
			settings: { steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" },
		});
		await fixture.shell.close();
	});

	it.each(["steeringMode", "followUpMode"] as const)("rejects invalid runtime %s before attachment", async (field) => {
		const storage = new MemoryStorage();
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
		const runtimeSession = new StoredSession({ id: id(), createdAt: 1, storageVersion: 1 }, storage, () => undefined);
		const options = { [field]: "invalid" } as unknown as RuntimeShellOptions;
		await expect(createRuntimeShell(runtimeSession, configuration, options)).rejects.toMatchObject({
			code: "invalid_query",
		});
		expect(await storage.getRegister("lane.config", "main")).toBeUndefined();
		await runtimeSession.close();
	});

	it("keeps idle, active, and cancelling lane authority unchanged without starting effects", async () => {
		const fixture = await runtime();
		const idle = await fixture.shell.nextRun(user("idle"));
		expect(await fixture.shell.peekAction()).toBeUndefined();
		expect(fixture.lease).not.toHaveBeenCalled();
		const active = await fixture.shell.prompt(user("prompt"));
		const before = {
			operation: active.runOperation,
			control: active.runState?.value.control,
			phase: active.runState?.value.phase,
		};
		const activeQueued = await fixture.shell.nextRun(user("active"));
		const afterActive = await fixture.session.refreshRuntimeAttachment();
		expect({
			operation: afterActive.runOperation,
			control: afterActive.runState?.value.control,
			phase: afterActive.runState?.value.phase,
		}).toEqual(before);
		await fixture.shell.abort();
		const cancelling = await fixture.session.refreshRuntimeAttachment();
		const cancellingQueued = await fixture.shell.nextRun(user("cancelling"));
		const afterCancel = await fixture.session.refreshRuntimeAttachment();
		expect(afterCancel.runOperation).toEqual(cancelling.runOperation);
		expect(afterCancel.runState?.value).toEqual(cancelling.runState?.value);
		expect(afterCancel.entries.has(idle.entryId)).toBe(false);
		expect(afterCancel.pendingEntries.has(activeQueued.entryId)).toBe(true);
		expect(afterCancel.pendingEntries.has(cancellingQueued.entryId)).toBe(true);
		expect(fixture.lease).toHaveBeenCalledTimes(1);
		await fixture.shell.close();
	});

	it("returns exact cancellation outcomes and expected-input errors do not fault the shell", async () => {
		const fixture = await runtime();
		await expect(
			fixture.shell.nextRun({ role: "user", content: "bad", timestamp: Number.NaN }),
		).rejects.toBeDefined();
		await expect(fixture.shell.cancelQueued("bad")).rejects.toMatchObject({ code: "unavailable" });
		const queued = await fixture.shell.nextRun(user("valid"));
		expect(await fixture.shell.cancelQueued(queued.entryId)).toEqual({ kind: "cancelled" });
		expect(await fixture.shell.cancelQueued(queued.entryId)).toEqual({ kind: "not_found" });
		const captured = await fixture.shell.nextRun(user("captured"));
		await fixture.shell.prompt(user("prompt"));
		expect(await fixture.shell.cancelQueued(captured.entryId)).toEqual({ kind: "already_consumed" });
		await fixture.shell.close();
	});

	it("faults identically when an admitted next-run commit fails without publishing durable state", async () => {
		const fixture = await runtime();
		fixture.observed.commit = vi.fn().mockRejectedValueOnce(new Error("commit failed"));
		const fault = await fixture.shell.nextRun(user("failure")).catch((error: unknown) => error);
		expect(fault).toMatchObject({ code: "fault" });
		await expect(fixture.shell.peekAction()).rejects.toBe(fault);
		expect((await fixture.storage.getRegister("lane.state", "main"))?.value).toEqual({
			currentOperationId: null,
			pendingNextRun: [],
		});
		expect(await fixture.storage.listRegisters("pending.entry")).toEqual([]);
		await fixture.shell.close();
	});

	it.each(["read", "commit"] as const)("faults identically when admitted cancellation %s fails", async (failure) => {
		const fixture = await runtime();
		const queued = await fixture.shell.nextRun(user("queued"));
		if (failure === "read") fixture.observed.getRegister = vi.fn().mockRejectedValueOnce(new Error("read failed"));
		else fixture.observed.commit = vi.fn().mockRejectedValueOnce(new Error("commit failed"));
		const fault = await fixture.shell.cancelQueued(queued.entryId).catch((error: unknown) => error);
		expect(fault).toMatchObject({ code: "fault" });
		await expect(fixture.shell.peekAction()).rejects.toBe(fault);
		expect((await fixture.storage.getRegister("lane.state", "main"))?.value).toMatchObject({
			pendingNextRun: [queued.entryId],
		});
		await fixture.shell.close();
	});

	it("close before queue admission is write-free", async () => {
		const fixture = await runtime();
		await fixture.shell.close();
		await expect(fixture.shell.nextRun(user("late"))).rejects.toMatchObject({ code: "closed" });
		await expect(fixture.shell.cancelQueued(id())).rejects.toMatchObject({ code: "closed" });
		expect(fixture.observed.committedTransactions).toEqual([]);
	});

	it.each(["next-run", "cancel"] as const)("close waits for admitted blocked %s commit", async (operation) => {
		const fixture = await runtime();
		const queued = operation === "cancel" ? await fixture.shell.nextRun(user("queued")) : undefined;
		fixture.observed.committedTransactions.length = 0;
		const commit = fixture.observed.commit.bind(fixture.observed);
		let entered!: () => void;
		let release!: () => void;
		const admitted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		fixture.observed.commit = async (transaction) => {
			entered();
			await blocked;
			return commit(transaction);
		};
		const mutation =
			operation === "next-run" ? fixture.shell.nextRun(user("queued")) : fixture.shell.cancelQueued(queued!.entryId);
		await admitted;
		const close = fixture.shell.close();
		expect(fixture.observed.committedTransactions).toEqual([]);
		release();
		await mutation;
		await close;
		expect(fixture.observed.committedTransactions).toHaveLength(1);
	});
});
