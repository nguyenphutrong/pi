import { type Entry, type JsonValue, MemoryStorage } from "@nguyenphutrong/pi-session-storage";
import { instrumentStorage } from "@nguyenphutrong/pi-session-storage/testing";
import { describe, expect, it, vi } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import { MemorySessionRepo } from "../src/repo.ts";
import { attachRuntime, closeAttachedRuntime } from "../src/runtime-port.ts";
import { StoredSession } from "../src/session.ts";
import { id, user } from "./fixtures.ts";

const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

async function opened() {
	const repo = new MemorySessionRepo();
	const session = await repo.create({});
	if (!(session instanceof StoredSession)) throw new Error("Expected StoredSession");
	const attachment = await attachRuntime(session, configuration);
	return { repo, session, attachment };
}

function promptTransition(attachment: Awaited<ReturnType<typeof attachRuntime>>, messages = [user("caller")]) {
	return {
		messages,
		steeringMode: "all" as const,
		followUpMode: "all" as const,
		expectedConfigurationSeq: attachment.laneConfiguration.seq,
		expectedLaneStateSeq: attachment.laneState.seq,
		expectedPendingNextRun: attachment.laneState.value.pendingNextRun,
		expectedLeafSeq: attachment.mainLeaf.seq,
		expectedProvider: "test",
		expectedModelId: "model",
		identityAvailable: true,
	};
}

describe("lane-owned next-run queue", () => {
	it("writes the exact next-run and cancellation transactions and publishes commit sequences", async () => {
		const delegate = new MemoryStorage();
		await delegate.commit({
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
		const storage = instrumentStorage(delegate);
		const reopened = new StoredSession({ id: id(), createdAt: 1, storageVersion: 1 }, storage, () => undefined);
		await attachRuntime(reopened, configuration);
		storage.committedTransactions.length = 0;
		const queued = await reopened.nextRun(user("exact"));
		expect(storage.committedTransactions[0].writes).toEqual([
			{
				kind: "register",
				op: "set",
				namespace: "pending.entry",
				key: queued.entryId,
				value: { type: "message", payload: user("exact") },
			},
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: null, pendingNextRun: [queued.entryId] },
			},
		]);
		const pending = await reopened.refreshRuntimeAttachment();
		expect(pending.laneState.value.pendingNextRun).toEqual([queued.entryId]);
		expect(pending.pendingEntries.get(queued.entryId!)?.payload).toEqual(user("exact"));
		expect(pending.laneState.seq).toBe(queued.attachment.laneState.seq);
		const cancelled = await reopened.cancelQueued(queued.entryId!);
		expect(storage.committedTransactions[1].writes).toEqual([
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: null, pendingNextRun: [] },
			},
			{ kind: "register", op: "delete", namespace: "pending.entry", key: queued.entryId },
		]);
		expect(cancelled.attachment.laneState.value.pendingNextRun).toEqual([]);
		expect(cancelled.outcome).toBe("cancelled");
		await closeAttachedRuntime(reopened);
	});

	it("writes exact FIFO capture order, caller-only intent, sequence offsets, and optional skip", async () => {
		for (const pendingCount of [0, 1, 2]) {
			const { session, attachment } = await opened();
			const queued = [];
			for (let index = 0; index < pendingCount; index++) queued.push(await session.nextRun(user(`queued-${index}`)));
			const accepted = await session.acceptPrompt(
				promptTransition(attachment, [user("caller-a"), user("caller-b")]),
			);
			expect(accepted.status).toBe("committed");
			if (accepted.status !== "committed") throw new Error("Prompt was not committed");
			const callerIds = accepted.attachment.runOperation!.value.intent.promptEntryIds;
			expect(callerIds).toHaveLength(2);
			const chain = [...queued.map((item) => item.entryId!), ...callerIds];
			for (let index = 0; index < chain.length; index++) {
				const entry = accepted.attachment.entries.get(chain[index]);
				expect(entry?.parentId).toBe(index === 0 ? null : chain[index - 1]);
				if (index > 0) expect(entry!.seq).toBe(accepted.attachment.entries.get(chain[index - 1])!.seq + 1);
			}
			expect(accepted.attachment.pendingEntries.size).toBe(0);
			expect(accepted.attachment.laneState.value.pendingNextRun).toEqual([]);
			expect(accepted.attachment.runState!.value.phase).toEqual({
				kind: "checkpoint",
				continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
				triggerEntryId: callerIds[1],
				...(pendingCount === 0 ? {} : { skipInboxOnce: true }),
			});
			await closeAttachedRuntime(session);
		}
	});

	it("reopens captured checkpoint and atomically clears skip in one assistant-ready state write", async () => {
		const { repo, session, attachment } = await opened();
		await session.nextRun(user("captured"));
		const accepted = await session.acceptPrompt(promptTransition(attachment));
		if (accepted.status !== "committed") throw new Error("Prompt was not committed");
		await closeAttachedRuntime(session);
		const reopened = await repo.open(session.metadata);
		if (!(reopened instanceof StoredSession)) throw new Error("Expected StoredSession");
		const restored = await attachRuntime(reopened, configuration);
		expect(restored.runState!.value.phase).toMatchObject({ skipInboxOnce: true });
		const operationId = restored.runOperation!.value.operationId;
		const triggerEntryId =
			restored.runState!.value.phase.kind === "checkpoint" ? restored.runState!.value.phase.triggerEntryId : "";
		const ready = await reopened.startAssistantStep({
			operationId,
			triggerEntryId,
			expectedOperationStateSeq: restored.runState!.seq,
			expectedLaneStateSeq: restored.laneState.seq,
			expectedConfigurationSeq: restored.laneConfiguration.seq,
			streamOptions: {},
			retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
		});
		expect(ready.attachment.runState!.value.phase).not.toHaveProperty("skipInboxOnce");
		await closeAttachedRuntime(reopened);
	});

	it.each([
		["duplicate pending id", (pending: string) => [pending, pending], undefined],
		["non UUID pending id", () => ["bad"], undefined],
		["missing register", (pending: string) => [pending], "missing"],
		["extra envelope field", (pending: string) => [pending], { type: "message", payload: user("x"), extra: true }],
		["wrong envelope type", (pending: string) => [pending], { type: "other", payload: user("x") }],
		[
			"invalid message",
			(pending: string) => [pending],
			{ type: "message", payload: { role: "user", timestamp: "bad", content: "x" } },
		],
	] as const)("rejects corrupt %s without writing", async (_label, ids, envelope) => {
		const storage = new MemoryStorage();
		const pending = id();
		const writes = [
			{ kind: "register" as const, op: "set" as const, namespace: "lane.leaf", key: "main", value: null },
			{
				kind: "register" as const,
				op: "set" as const,
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: null, pendingNextRun: ids(pending) } as JsonValue,
			},
			{
				kind: "register" as const,
				op: "set" as const,
				namespace: "lane.config",
				key: "main",
				value: configuration as unknown as JsonValue,
			},
		];
		if (envelope !== "missing" && ids(pending)[0] === pending)
			writes.push({
				kind: "register",
				op: "set",
				namespace: "pending.entry",
				key: pending,
				value: (envelope ?? { type: "message", payload: user("x") }) as JsonValue,
			});
		await storage.commit({ writes });
		const observed = instrumentStorage(storage);
		const runtimeSession = new StoredSession(
			{ id: id(), createdAt: 1, storageVersion: 1 },
			observed,
			() => undefined,
		);
		await expect(attachRuntime(runtimeSession, configuration)).rejects.toMatchObject({ code: "corruption" });
		expect(observed.committedTransactions).toEqual([]);
	});
	it("persists detached pending content across a fresh reopen and cancels atomically", async () => {
		const { repo, session } = await opened();
		const caller = { role: "user" as const, content: [{ type: "text" as const, text: "queued" }], timestamp: 1 };
		const queued = await session.nextRun(caller);
		caller.content[0] = { type: "text", text: "changed" };
		expect(queued.attachment.pendingEntries.get(queued.entryId!)?.payload).toEqual(user("queued"));
		await closeAttachedRuntime(session);

		const reopened = await repo.open(session.metadata);
		if (!(reopened instanceof StoredSession)) throw new Error("Expected StoredSession");
		const restored = await attachRuntime(reopened, configuration);
		expect(restored.laneState.value.pendingNextRun).toEqual([queued.entryId]);
		expect(restored.entries.has(queued.entryId!)).toBe(false);
		expect((await reopened.cancelQueued(queued.entryId!)).outcome).toBe("cancelled");
		expect((await reopened.cancelQueued(queued.entryId!)).outcome).toBe("not_found");
		await closeAttachedRuntime(reopened);
	});

	it("publishes pending entries through an immutable runtime map with detached nested messages", async () => {
		const { session } = await opened();
		const queued = await session.nextRun(user("immutable"));
		const pending = queued.attachment.pendingEntries;
		const mutable = pending as unknown as Map<string, unknown>;
		expect(pending.size).toBe(1);
		expect(pending.has(queued.entryId!)).toBe(true);
		expect([...pending.keys()]).toEqual([queued.entryId]);
		expect(() => mutable.set(queued.entryId!, {})).toThrow();
		expect(() => mutable.delete(queued.entryId!)).toThrow();
		expect(() => mutable.clear()).toThrow();
		expect(() => Map.prototype.set.call(pending, queued.entryId, {})).toThrow();
		expect(() => Map.prototype.delete.call(pending, queued.entryId)).toThrow();
		expect(() => Map.prototype.clear.call(pending)).toThrow();
		expect(pending.get(queued.entryId!)?.payload).toEqual(user("immutable"));

		const queuedEntry = pending.get(queued.entryId!);
		if (queuedEntry?.type !== "message") throw new Error("Expected pending message");
		const returned = queuedEntry.payload;
		if (returned.role !== "user" || typeof returned.content === "string") throw new Error("Expected user content");
		returned.content[0] = { type: "text", text: "mutated" };
		const refreshed = await session.refreshRuntimeAttachment();
		expect(refreshed.pendingEntries.get(queued.entryId!)?.payload).toEqual(user("immutable"));
		await closeAttachedRuntime(session);
	});

	it.each(["operation", "caller"] as const)(
		"rejects a generated %s id colliding with a captured pending id before any commit",
		async (kind) => {
			const { session, attachment } = await opened();
			const queued = await session.nextRun(user("captured"));
			const fresh = id();
			vi.spyOn(session.idGenerator, "next")
				.mockReturnValueOnce(kind === "operation" ? queued.entryId! : fresh)
				.mockReturnValueOnce(kind === "caller" ? queued.entryId! : fresh);
			await expect(
				session.acceptPrompt({
					messages: [user("caller")],
					steeringMode: "all",
					followUpMode: "all",
					expectedConfigurationSeq: attachment.laneConfiguration.seq,
					expectedLaneStateSeq: attachment.laneState.seq,
					expectedPendingNextRun: [],
					expectedLeafSeq: attachment.mainLeaf.seq,
					expectedProvider: "test",
					expectedModelId: "model",
					identityAvailable: true,
				}),
			).rejects.toMatchObject({ code: "storage" });
			const current = await session.refreshRuntimeAttachment();
			expect(current.laneState.value).toEqual({ currentOperationId: null, pendingNextRun: [queued.entryId] });
			expect(current.mainLeaf).toEqual(attachment.mainLeaf);
			expect(current.entries.has(fresh)).toBe(false);
			expect(current.pendingEntries.get(queued.entryId!)?.payload).toEqual(user("captured"));
			await closeAttachedRuntime(session);
		},
	);

	it("captures pending messages before caller prompts and clears skipInboxOnce in assistant-ready", async () => {
		const { session, attachment } = await opened();
		const first = await session.nextRun(user("first"));
		const second = await session.nextRun(user("second"));
		const accepted = await session.acceptPrompt({
			messages: [user("caller")],
			steeringMode: "all",
			followUpMode: "all",
			expectedConfigurationSeq: attachment.laneConfiguration.seq,
			expectedLaneStateSeq: attachment.laneState.seq,
			expectedPendingNextRun: [],
			expectedLeafSeq: attachment.mainLeaf.seq,
			expectedProvider: "test",
			expectedModelId: "model",
			identityAvailable: true,
		});
		expect(accepted.status).toBe("committed");
		if (accepted.status !== "committed") throw new Error("Prompt was not committed");
		const operation = accepted.attachment.runOperation!;
		const state = accepted.attachment.runState!;
		expect(operation.value.intent.promptEntryIds).toHaveLength(1);
		const callerId = operation.value.intent.promptEntryIds[0];
		expect(accepted.attachment.entries.get(first.entryId!)?.parentId).toBeNull();
		expect(accepted.attachment.entries.get(second.entryId!)?.parentId).toBe(first.entryId);
		expect(accepted.attachment.entries.get(callerId)?.parentId).toBe(second.entryId);
		expect(state.value.phase).toMatchObject({ skipInboxOnce: true, triggerEntryId: callerId });

		const ready = await session.startAssistantStep({
			operationId: operation.value.operationId,
			triggerEntryId: callerId,
			expectedOperationStateSeq: state.seq,
			expectedLaneStateSeq: accepted.attachment.laneState.seq,
			expectedConfigurationSeq: accepted.attachment.laneConfiguration.seq,
			streamOptions: {},
			retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
		});
		expect(ready.committed).toBe(true);
		expect(ready.attachment.runState?.value.phase).toMatchObject({
			kind: "assistant",
			generation: { status: "ready" },
		});
		await closeAttachedRuntime(session);
	});

	it("accepts a prompt after next-run then cancellation restore the pending authority", async () => {
		const { session, attachment } = await opened();
		const queued = await session.nextRun(user("transient"));
		expect((await session.cancelQueued(queued.entryId!)).outcome).toBe("cancelled");
		const accepted = await session.acceptPrompt(promptTransition(attachment));
		expect(accepted.status).toBe("committed");
		if (accepted.status !== "committed") throw new Error("Prompt was not committed");
		expect(accepted.attachment.laneState.value.pendingNextRun).toEqual([]);
		expect(accepted.attachment.entries.has(queued.entryId!)).toBe(false);
		await closeAttachedRuntime(session);
	});

	it("serializes next-run and prompt in both exact commit orders", async () => {
		for (const first of ["next-run", "prompt"] as const) {
			const { session, attachment } = await opened();
			const queued = first === "next-run" ? await session.nextRun(user("queued")) : undefined;
			const accepted = await session.acceptPrompt(promptTransition(attachment));
			if (accepted.status !== "committed") throw new Error("Prompt was not committed");
			const late = first === "prompt" ? await session.nextRun(user("queued")) : queued!;
			const current = await session.refreshRuntimeAttachment();
			if (first === "next-run") {
				const captured = accepted.attachment.entries.get(late.entryId!);
				expect(captured?.type === "message" ? captured.message : undefined).toEqual(user("queued"));
				expect(current.laneState.value.pendingNextRun).toEqual([]);
				expect(current.pendingEntries.size).toBe(0);
			} else {
				expect(current.entries.has(late.entryId!)).toBe(false);
				expect(current.laneState.value.pendingNextRun).toEqual([late.entryId]);
				expect(current.pendingEntries.get(late.entryId!)?.payload).toEqual(user("queued"));
			}
			await closeAttachedRuntime(session);
		}
	});

	it("serializes cancellation and prompt capture in both exact commit orders", async () => {
		for (const first of ["cancel", "prompt"] as const) {
			const { session, attachment } = await opened();
			const queued = await session.nextRun(user("queued"));
			if (first === "cancel") expect((await session.cancelQueued(queued.entryId!)).outcome).toBe("cancelled");
			const accepted = await session.acceptPrompt(promptTransition(attachment));
			if (accepted.status !== "committed") throw new Error("Prompt was not committed");
			if (first === "prompt") expect((await session.cancelQueued(queued.entryId!)).outcome).toBe("already_consumed");
			const current = await session.refreshRuntimeAttachment();
			expect(current.laneState.value.pendingNextRun).toEqual([]);
			expect(current.pendingEntries.size).toBe(0);
			expect(accepted.attachment.entries.has(queued.entryId!)).toBe(first === "prompt");
			await closeAttachedRuntime(session);
		}
	});

	it.each([
		"wrong pending register identity",
		"pending id materialized as entry",
		"extra entry map identity",
	] as const)("rejects corrupt %s without writing", async (kind) => {
		const delegate = new MemoryStorage();
		const pending = id();
		await delegate.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [pending] },
				},
				{
					kind: "register",
					op: "set",
					namespace: "lane.config",
					key: "main",
					value: configuration as unknown as JsonValue,
				},
				{
					kind: "register",
					op: "set",
					namespace: "pending.entry",
					key: pending,
					value: { type: "message", payload: user("queued") } as unknown as JsonValue,
				},
			],
		});
		const storage = instrumentStorage(delegate);
		if (kind === "wrong pending register identity") {
			const getRegister = storage.getRegister.bind(storage);
			storage.getRegister = async (namespace, key) => {
				const register = await getRegister(namespace, key);
				return namespace === "pending.entry" && register ? { ...register, key: id() } : register;
			};
		} else {
			const getEntries = storage.getEntries.bind(storage);
			storage.getEntries = async (ids) => {
				const entries = new Map(await getEntries(ids));
				const wrong = kind === "pending id materialized as entry" ? pending : id();
				entries.set(wrong, {
					id: wrong,
					parentId: null,
					seq: 100,
					timestamp: 1,
					type: "message",
					payload: user("wrong") as unknown as JsonValue,
				} satisfies Entry);
				return entries;
			};
		}
		const runtimeSession = new StoredSession({ id: id(), createdAt: 1, storageVersion: 1 }, storage, () => undefined);
		await expect(attachRuntime(runtimeSession, configuration)).rejects.toMatchObject({ code: "corruption" });
		expect(storage.committedTransactions).toEqual([]);
	});
});
