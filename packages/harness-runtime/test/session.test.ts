import type { Message } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@nguyenphutrong/pi-session-storage";
import { instrumentStorage } from "@nguyenphutrong/pi-session-storage/testing";
import { describe, expect, it } from "vitest";
import { type BranchBounds, CURRENT_STORAGE_VERSION, type EntryQuery, MemorySessionRepo } from "../src/index.ts";
import { StoredSession } from "../src/session.ts";
import { asMessage, assistant, id, toolResult, user, ZERO_USAGE } from "./fixtures.ts";

function metadata() {
	return Object.freeze({ id: id(), createdAt: 1, storageVersion: CURRENT_STORAGE_VERSION });
}

function asQuery(value: unknown): EntryQuery {
	return value as EntryQuery;
}

function asBranchQuery(value: unknown): EntryQuery & BranchBounds {
	return value as EntryQuery & BranchBounds;
}

function asEntryId(value: unknown): Parameters<StoredSession["getEntry"]>[0] {
	return value as Parameters<StoredSession["getEntry"]>[0];
}

function asEntryIds(value: unknown): Parameters<StoredSession["getEntries"]>[0] {
	return value as Parameters<StoredSession["getEntries"]>[0];
}

async function initializedStorage(): Promise<MemoryStorage> {
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
	return storage;
}

describe("StoredSession", () => {
	it("serializes concurrent appends as one transaction and one parent chain", async () => {
		const instrumented = instrumentStorage(await initializedStorage());
		const session = new StoredSession(metadata(), instrumented, () => undefined);
		const ids = await Promise.all([
			session.appendMessage(user("a")),
			session.appendMessage(user("b")),
			session.appendMessage(user("c")),
		]);
		const entries = await session.findEntries({ order: "oldestFirst" });
		expect(entries.map(({ id: entryId, parentId }) => [entryId, parentId])).toEqual([
			[ids[0], null],
			[ids[1], ids[0]],
			[ids[2], ids[1]],
		]);
		expect(instrumented.committedTransactions).toHaveLength(3);
		for (const transaction of instrumented.committedTransactions) {
			expect(transaction.writes.map((write) => write.kind)).toEqual(["entry", "register"]);
		}
		expect(Reflect.ownKeys(session).some((key) => (session as object)[key as keyof object] === instrumented)).toBe(
			false,
		);
		await session.close();
	});

	it("close drains an append admitted before sealing", async () => {
		const storage = await initializedStorage();
		const session = new StoredSession(metadata(), storage, () => undefined);
		const append = session.appendMessage(user("admitted"));
		const close = session.close();
		const entryId = await append;
		await close;
		await expect(storage.getEntries([entryId])).rejects.toMatchObject({ code: "closed" });
	});

	it("accepts supported messages and detaches input and returned values", async () => {
		const session = await new MemorySessionRepo().create();
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "image", data: "AA==", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			{
				...assistant("deferred"),
				content: [
					{ type: "thinking", thinking: "plan", redacted: false },
					{ type: "toolCall", id: "call", name: "read", arguments: { path: "x" } },
				],
				deferred: {
					provider: "openai",
					modelId: "model",
					api: "openai-responses",
					id: "job",
					data: { key: "value" },
				},
				diagnostics: [
					{ type: "retry", timestamp: 2, error: { message: "retry", code: 429 }, details: { attempt: 1 } },
				],
			},
			toolResult(),
		];
		const firstId = await session.appendMessage(messages[0]);
		await session.appendMessage(messages[1]);
		await session.appendMessage(messages[2]);
		(messages[0].content as { type: "text"; text: string }[])[0].text = "mutated";
		const returned = await session.getEntry(firstId);
		if (returned?.message.role === "user" && typeof returned.message.content !== "string")
			returned.message.content[0] = { type: "text", text: "returned mutation" };
		expect((await session.getEntry(firstId))?.message).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "AA==", mimeType: "image/png" },
			],
			timestamp: 1,
		});
		expect(await session.getStats()).toEqual({ messageCount: 3, usage: ZERO_USAGE });
		await session.close();
	});

	it.each([
		["pending assistant", { ...assistant(), stopReason: "pending" }],
		["unknown role", { role: "system", content: "x", timestamp: 1 }],
		["malformed", { role: "user", content: [{ type: "video", data: "x" }], timestamp: 1 }],
		["non-JSON", { role: "user", content: "x", timestamp: Number.NaN }],
	])("rejects %s before persistence", async (_label, candidate) => {
		const session = await new MemorySessionRepo().create();
		await expect(session.appendMessage(asMessage(candidate))).rejects.toMatchObject({ code: "invalid_message" });
		const validId = await session.appendMessage(user("valid"));
		expect((await session.getEntry(validId))?.seq).toBe(3);
		await session.close();
	});

	it("maps invalid exact-id queries to invalid_query", async () => {
		const session = await new MemorySessionRepo().create();
		const entryId = await session.appendMessage(user("query target"));
		await expect(session.getEntry("invalid-id")).rejects.toMatchObject({ code: "invalid_query" });
		const sparse = new Array(1);
		const accessorIndex = Object.defineProperty([entryId], "0", { enumerable: true, get: () => entryId });
		const symbolProperty = Object.assign([entryId], { [Symbol("extra")]: true });
		const hiddenExtra = Object.defineProperty([entryId], "extra", { enumerable: false, value: true });
		const cases = [
			["null", null],
			["non-array", entryId],
			["wrong primitive element", [1]],
			["sparse array", sparse],
			["accessor index", accessorIndex],
			["symbol element", [Symbol("id")]],
			["symbol property", symbolProperty],
			["hidden extra property", hiddenExtra],
			["duplicate valid id", [entryId, entryId]],
		] satisfies [string, unknown][];
		for (const [label, candidate] of cases)
			await expect(session.getEntries(asEntryIds(candidate)), label).rejects.toMatchObject({
				code: "invalid_query",
			});
		await expect(session.getEntry(asEntryId(null)), "malformed getEntry input").rejects.toMatchObject({
			code: "invalid_query",
		});
		await session.close();
	});

	it("rejects malformed global and branch queries before query shortcuts", async () => {
		const session = await new MemorySessionRepo().create();
		const accessor = Object.defineProperty({}, "limit", { enumerable: true, get: () => 1 });
		const hidden = Object.defineProperty({}, "extra", { enumerable: false, value: true });
		const symbolic = { [Symbol("extra")]: true };
		const sharedCases: [string, unknown][] = [
			["null", null],
			["array", []],
			["custom prototype", Object.create({})],
			["accessor", accessor],
			["symbol field", symbolic],
			["hidden field", hidden],
			["unknown field after newest cursor zero", { cursor: { seq: 0 }, extra: true }],
			["invalid type", { type: "tool" }],
			["invalid order", { order: "sideways" }],
			["invalid limit", { limit: -1 }],
			["malformed cursor", { cursor: { seq: -1 } }],
			["extra cursor field", { cursor: { seq: 0, extra: true } }],
		];
		const globalApis = [session.findEntries.bind(session), session.findEntry.bind(session)];
		const branchApis = [session.findEntriesOnBranch.bind(session), session.findEntryOnBranch.bind(session)];
		for (const [label, candidate] of sharedCases) {
			for (const api of globalApis)
				await expect(api(asQuery(candidate)), `global: ${label}`).rejects.toMatchObject({ code: "invalid_query" });
			for (const api of branchApis)
				await expect(api(asBranchQuery(candidate)), `branch: ${label}`).rejects.toMatchObject({
					code: "invalid_query",
				});
		}
		for (const [label, candidate] of [
			["invalid start", { start: "bad" }],
			["invalid stopAtId", { stopAtId: "bad" }],
			["invalid stopAtType", { stopAtType: "tool" }],
		] satisfies [string, unknown][]) {
			for (const api of branchApis)
				await expect(api(asBranchQuery(candidate)), label).rejects.toMatchObject({ code: "invalid_query" });
		}
		await session.close();
	});

	it("implements query order, defaults, limits, cursors, inclusive branch stops, and context projection", async () => {
		const session = await new MemorySessionRepo().create();
		const messages = [
			user("oldest"),
			assistant("error"),
			assistant("aborted"),
			assistant("deferred"),
			assistant("stop"),
			assistant("length"),
			assistant("toolUse"),
			toolResult(),
		];
		const ids: string[] = [];
		for (const message of messages) ids.push(await session.appendMessage(message));
		const oldest = await session.findEntries({ order: "oldestFirst" });
		expect((await session.findEntries()).map((entry) => entry.id)).toEqual([...ids].reverse());
		expect((await session.findEntries({ order: "oldestFirst", limit: 2 })).map((entry) => entry.id)).toEqual(
			ids.slice(0, 2),
		);
		expect(
			(await session.findEntries({ order: "oldestFirst", cursor: { seq: oldest[1].seq } })).map((entry) => entry.id),
		).toEqual(ids.slice(2));
		expect((await session.findEntries({ cursor: { seq: oldest[5].seq } })).map((entry) => entry.id)).toEqual(
			ids.slice(0, 5).reverse(),
		);
		expect(await session.findEntries({ order: "oldestFirst", cursor: { seq: Number.MAX_SAFE_INTEGER } })).toEqual([]);
		expect((await session.findEntriesOnBranch({ stopAtId: ids[3] })).map((entry) => entry.id)).toEqual(
			ids.slice(3).reverse(),
		);
		expect(
			(await session.findEntriesOnBranch({ order: "oldestFirst", stopAtId: ids[3] })).map((entry) => entry.id),
		).toEqual(ids.slice(0, 4));
		expect((await session.findEntriesOnBranch({ stopAtType: "message" })).map((entry) => entry.id)).toEqual([
			ids.at(-1),
		]);
		expect(
			(await session.findEntriesOnBranch({ order: "oldestFirst", stopAtType: "message" })).map((entry) => entry.id),
		).toEqual([ids[0]]);
		expect(
			(await session.projectBuiltinContext()).map((message) =>
				message.role === "assistant" ? message.stopReason : message.role,
			),
		).toEqual(["user", "stop", "length", "toolUse", "toolResult"]);
		await session.close();
	});
});
