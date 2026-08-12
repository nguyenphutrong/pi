import { MemoryStorage, type Register, type Storage, type Write } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import { validateMainLane } from "../src/session.ts";
import { id } from "./fixtures.ts";

async function rejectsCorruption(storage: Storage): Promise<void> {
	await expect(validateMainLane(storage)).rejects.toMatchObject({ code: "corruption" });
}

async function storageWith(writes: Parameters<MemoryStorage["commit"]>[0]["writes"]): Promise<MemoryStorage> {
	const storage = new MemoryStorage();
	if (writes.length > 0) await storage.commit({ writes });
	return storage;
}

describe("validateMainLane", () => {
	const invalidStates: [string, Write[]][] = [
		["missing", []],
		[
			"extra lane",
			[
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "other", value: null },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			],
		],
		[
			"orphan leaf",
			[
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: id() },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			],
		],
		[
			"non-idle state",
			[
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: id(), pendingNextRun: [] },
				},
			],
		],
	];

	it.each(invalidStates)("rejects %s state", async (_label, writes) => {
		await rejectsCorruption(await storageWith([...writes]));
	});

	it("rejects malformed state values", async () => {
		await rejectsCorruption(
			await storageWith([
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [], extra: true },
				},
			]),
		);
	});

	it("rejects structurally malformed register envelopes", async () => {
		const delegate = await storageWith([
			{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: null, pendingNextRun: [] },
			},
		]);
		const malformed = Object.create(delegate) as Storage;
		malformed.listRegisters = async (namespace: string): Promise<Register[]> =>
			namespace === "lane.leaf"
				? [{ namespace: "lane.leaf", key: "main", value: null, seq: -1 }]
				: delegate.listRegisters(namespace);
		await rejectsCorruption(malformed);
	});

	it("accepts a valid leaf referencing a decodable message", async () => {
		const entryId = id();
		const storage = await storageWith([
			{
				kind: "entry",
				entry: {
					id: entryId,
					parentId: null,
					type: "message",
					payload: { role: "user", content: "ok", timestamp: 1 },
				},
			},
			{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: entryId },
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: null, pendingNextRun: [] },
			},
		]);
		await expect(validateMainLane(storage)).resolves.toBeUndefined();
	});

	it.each([
		["malformed", { role: "assistant", content: "not assistant content", timestamp: 1 }],
		[
			"pending assistant",
			{
				role: "assistant",
				content: [{ type: "text", text: "pending" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "pending",
				timestamp: 1,
			},
		],
	])("rejects a leaf message with %s persisted payload", async (_label, payload) => {
		const entryId = id();
		await rejectsCorruption(
			await storageWith([
				{ kind: "entry", entry: { id: entryId, parentId: null, type: "message", payload } },
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: entryId },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			]),
		);
	});
});
