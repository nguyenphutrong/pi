import { createModels } from "@earendil-works/pi-ai";
import { MemoryStorage, type Storage } from "@nguyenphutrong/pi-session-storage";
import { instrumentStorage } from "@nguyenphutrong/pi-session-storage/testing";
import { describe, expect, it, vi } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import { createRuntimeShell } from "../src/runtime-shell.ts";
import { StoredSession } from "../src/session.ts";
import { id, user } from "./fixtures.ts";

const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

async function runtime(storage: Storage = new MemoryStorage()) {
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
	const shell = await createRuntimeShell(session, configuration, { models });
	observed.committedTransactions.length = 0;
	return { storage, observed, session, models, lease, shell };
}

describe("RuntimeShell next-run queue", () => {
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
