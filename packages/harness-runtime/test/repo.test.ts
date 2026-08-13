import { describe, expect, it } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import {
	CURRENT_STORAGE_VERSION,
	MemorySessionRepo,
	type Session,
	SessionError,
	type SessionMetadata,
} from "../src/index.ts";
import { attachRuntime } from "../src/runtime-port.ts";
import { id, user, ZERO_USAGE } from "./fixtures.ts";

const configuration = (): LaneConfiguration => ({
	model: { provider: "test", modelId: "current" },
	thinkingLevel: "medium",
	activeToolNames: [],
});

async function errorCode(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
		return undefined;
	} catch (error) {
		return error instanceof SessionError ? error.code : undefined;
	}
}

function asCreateOptions(value: unknown): Parameters<MemorySessionRepo["create"]>[0] {
	return value as Parameters<MemorySessionRepo["create"]>[0];
}

function asMetadata(value: unknown): SessionMetadata {
	return value as SessionMetadata;
}

describe("MemorySessionRepo", () => {
	it("commits the complete idle main lane at creation and preserves it across a fresh handle", async () => {
		const repo = new MemorySessionRepo();
		const parentSessionId = id();
		const session = await repo.create({ parentSessionId });
		const listed = await repo.list();

		expect(Object.isFrozen(session.metadata)).toBe(true);
		expect(session.metadata).toEqual({
			id: session.metadata.id,
			createdAt: expect.any(Number),
			storageVersion: CURRENT_STORAGE_VERSION,
			parentSessionId,
		});
		expect(listed).toEqual([session.metadata]);
		expect(listed[0]).not.toBe(session.metadata);
		expect(Object.isFrozen(listed[0])).toBe(true);
		expect(await session.getLeafId()).toBeNull();
		expect(await session.findEntries()).toEqual([]);
		expect(await session.getStats()).toEqual({ messageCount: 0, usage: ZERO_USAGE });
		await session.close();

		const reopened = await repo.open(session.metadata);
		const firstAttachment = await attachRuntime(reopened, configuration());
		expect(firstAttachment.mainLeaf.value).toBeNull();
		expect(firstAttachment.laneState.value).toEqual({ currentOperationId: null, pendingNextRun: [] });
		expect(firstAttachment.laneState.seq).toBe(firstAttachment.mainLeaf.seq + 1);
		expect(firstAttachment.laneConfiguration.value).toEqual(configuration());
		expect(firstAttachment.laneConfiguration.seq).toBe(firstAttachment.laneState.seq + 1);
		expect(firstAttachment.runOperation).toBeUndefined();
		expect(firstAttachment.runState).toBeUndefined();
		await reopened.close();

		const reopenedAgain = await repo.open(session.metadata);
		const secondAttachment = await attachRuntime(reopenedAgain, {
			...configuration(),
			model: { provider: "other", modelId: "ignored-seed" },
		});
		expect(secondAttachment.mainLeaf).toEqual(firstAttachment.mainLeaf);
		expect(secondAttachment.laneState).toEqual(firstAttachment.laneState);
		expect(secondAttachment.laneConfiguration).toEqual(firstAttachment.laneConfiguration);
		expect(secondAttachment.runOperation).toBeUndefined();
		expect(secondAttachment.runState).toBeUndefined();
		await reopenedAgain.close();

		const mutable = await repo.open(session.metadata);
		await mutable.appendMessage(user("first"));
		const entry = await mutable.findEntry();
		expect(entry?.seq).toBe(firstAttachment.laneConfiguration.seq + 1);
		await mutable.close();
	});

	it("enforces exclusive ownership and returns a fresh handle after close", async () => {
		const repo = new MemorySessionRepo();
		const session = await repo.create();
		expect(await errorCode(repo.open(session.metadata))).toBe("active");
		expect(await errorCode(repo.delete(session.metadata))).toBe("active");
		await session.close();
		const reopened = await repo.open(session.metadata);
		expect(reopened).not.toBe(session);
		await session.close();
		expect(await errorCode(repo.open(session.metadata))).toBe("active");
		await reopened.close();
	});

	it("allows exactly one concurrent create for the same id", async () => {
		const repo = new MemorySessionRepo();
		const sessionId = id();
		const results = await Promise.allSettled([repo.create({ id: sessionId }), repo.create({ id: sessionId })]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(await repo.list()).toHaveLength(1);
		const session = results.find(
			(result): result is PromiseFulfilledResult<Session> => result.status === "fulfilled",
		);
		await session?.value.close();
	});

	it("preserves entries, chain, stats, and sequence across reopen", async () => {
		const repo = new MemorySessionRepo();
		const session = await repo.create();
		const first = await session.appendMessage(user("one"));
		const second = await session.appendMessage(user("two"));
		await session.close();
		const reopened = await repo.open(session.metadata);
		const entries = await reopened.findEntries({ order: "oldestFirst" });
		expect(entries.map(({ id: entryId, parentId, seq }) => ({ entryId, parentId, seq }))).toEqual([
			{ entryId: first, parentId: null, seq: 3 },
			{ entryId: second, parentId: first, seq: 5 },
		]);
		expect(await reopened.getStats()).toEqual({ messageCount: 2, usage: ZERO_USAGE });
		const third = await reopened.appendMessage(user("three"));
		expect((await reopened.getEntry(third))?.seq).toBe(7);
		await reopened.close();
	});

	it("rejects every Session operation after close", async () => {
		const session = await new MemorySessionRepo().create();
		await session.close();
		const calls = [
			session.getLeafId(),
			session.getEntry(id()),
			session.getEntries([]),
			session.getStats(),
			session.findEntries(),
			session.findEntry(),
			session.findEntriesOnBranch(),
			session.findEntryOnBranch(),
			session.appendMessage(user("x")),
			session.projectBuiltinContext(),
		];
		expect(await Promise.all(calls.map(errorCode))).toEqual(Array(calls.length).fill("closed"));
		await expect(session.close()).resolves.toBeUndefined();
	});

	it("validates metadata, versions, not-found, mismatch, and delete", async () => {
		const repo = new MemorySessionRepo();
		expect(await errorCode(repo.create({ id: "bad" }))).toBe("invalid_metadata");
		expect(await errorCode(repo.create({ parentSessionId: "bad" }))).toBe("invalid_metadata");
		const session = await repo.create();
		await session.close();
		expect(await errorCode(repo.open({ ...session.metadata, storageVersion: CURRENT_STORAGE_VERSION + 1 }))).toBe(
			"storage_version_newer",
		);
		expect(await errorCode(repo.open({ ...session.metadata, storageVersion: CURRENT_STORAGE_VERSION - 1 }))).toBe(
			"storage_version_older",
		);
		expect(await errorCode(repo.open({ ...session.metadata, createdAt: session.metadata.createdAt + 1 }))).toBe(
			"metadata_mismatch",
		);
		expect(await errorCode(repo.open({ ...session.metadata, id: id() }))).toBe("not_found");
		expect(await errorCode(repo.delete({ ...session.metadata, parentSessionId: id() }))).toBe("metadata_mismatch");
		await repo.delete(session.metadata);
		expect(await repo.list()).toEqual([]);
		expect(await errorCode(repo.delete(session.metadata))).toBe("not_found");
	});

	it("rejects malformed create options and metadata before repository classification", async () => {
		const repo = new MemorySessionRepo();
		const accessor = Object.defineProperty({}, "id", { enumerable: true, get: id });
		const hidden = Object.defineProperty({}, "extra", { enumerable: false, value: true });
		const createCases: [string, unknown][] = [
			["null", null],
			["array", []],
			["custom prototype", Object.create({})],
			["accessor", accessor],
			["symbol field", { [Symbol("extra")]: true }],
			["hidden field", hidden],
			["unknown field", { extra: true }],
			["invalid id", { id: "bad" }],
			["invalid parent id", { parentSessionId: "bad" }],
		];
		for (const [label, candidate] of createCases)
			await expect(repo.create(asCreateOptions(candidate)), label).rejects.toMatchObject({
				code: "invalid_metadata",
			});

		const session = await repo.create();
		await session.close();
		const valid = session.metadata;
		const metadataCases: [string, unknown][] = [
			["null", null],
			["array", []],
			["custom prototype", Object.assign(Object.create({}), valid)],
			[
				"accessor",
				Object.defineProperty({ ...valid }, "createdAt", { enumerable: true, get: () => valid.createdAt }),
			],
			["symbol field", { ...valid, [Symbol("extra")]: true }],
			["hidden field", Object.defineProperty({ ...valid }, "extra", { enumerable: false, value: true })],
			["unknown field with newer version", { ...valid, storageVersion: CURRENT_STORAGE_VERSION + 1, extra: true }],
			["missing id", { createdAt: valid.createdAt, storageVersion: CURRENT_STORAGE_VERSION }],
			["missing createdAt", { id: valid.id, storageVersion: CURRENT_STORAGE_VERSION }],
			["missing storageVersion", { id: valid.id, createdAt: valid.createdAt }],
			["invalid id", { ...valid, id: "bad" }],
			["invalid parent id", { ...valid, parentSessionId: "bad" }],
			["negative timestamp", { ...valid, createdAt: -1 }],
			["unsafe timestamp", { ...valid, createdAt: Number.MAX_SAFE_INTEGER + 1 }],
			["negative version", { ...valid, storageVersion: -1 }],
			["unsafe version", { ...valid, storageVersion: Number.MAX_SAFE_INTEGER + 1 }],
		];
		for (const [label, candidate] of metadataCases) {
			await expect(repo.open(asMetadata(candidate)), `open: ${label}`).rejects.toMatchObject({
				code: "invalid_metadata",
			});
			await expect(repo.delete(asMetadata(candidate)), `delete: ${label}`).rejects.toMatchObject({
				code: "invalid_metadata",
			});
		}
	});
});
