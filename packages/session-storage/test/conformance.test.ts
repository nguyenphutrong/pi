import { describe, expect, expectTypeOf, it } from "vitest";
import {
	assertEntry,
	assertRegister,
	assertUsageRow,
	createIdGenerator,
	MemoryStorage,
	MemoryStorageState,
	StorageError,
	type Transaction,
} from "../src/index.ts";
import {
	assertIdGeneratorConformance,
	createOrdinaryReadConformance,
	createStorageConformance,
	instrumentStorage,
	type StorageConformanceFixture,
} from "../src/testing/index.ts";

const conformance = createStorageConformance(() => {
	const storage = new MemoryStorage();
	return Promise.resolve<StorageConformanceFixture>({ storage, [Symbol.asyncDispose]: () => storage.close() });
});

const ordinaryReads = createOrdinaryReadConformance(() => {
	const storage = new MemoryStorage();
	return Promise.resolve({
		storage,
		seed: async (transaction: Transaction) => {
			await storage.commit(transaction);
		},
		[Symbol.asyncDispose]: () => storage.close(),
	});
});

const ids = {
	entry: "018f0000-0000-7000-8000-000000000001",
	parent: "018f0000-0001-7000-8000-000000000002",
	usage: "018f0000-0002-7000-8000-000000000003",
} as const;

const exactUsage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	cacheWrite1h: 5,
	reasoning: 6,
	totalTokens: 7,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 5 },
};

function expectCorruption(validate: (value: unknown) => void, values: readonly unknown[]): void {
	for (const value of values) {
		expect(() => validate(value)).toThrow(StorageError);
		expect(() => validate(value)).toThrow(expect.objectContaining({ code: "corruption" }));
	}
}

describe("complete read-envelope validators", () => {
	it("accepts valid complete entries and rejects malformed read-only and exact envelope fields", () => {
		const valid = {
			id: ids.entry,
			parentId: ids.parent,
			seq: 1,
			timestamp: 0,
			type: "message",
			payload: { text: "ok" },
		};
		expect(() => assertEntry(valid)).not.toThrow();
		expect(() =>
			assertEntry({ ...valid, type: "custom", customType: "extension", payload: { exact: true } }),
		).not.toThrow();
		expectCorruption(assertEntry, [
			{ ...valid, seq: 0 },
			{ ...valid, seq: 1.5 },
			{ ...valid, timestamp: -1 },
			{ ...valid, timestamp: Number.NaN },
			{ ...valid, extra: true },
			(({ timestamp: _timestamp, ...entry }) => entry)(valid),
			{ ...valid, id: "bad" },
			{ ...valid, parentId: "bad" },
			{ ...valid, type: "unknown" },
			{ ...valid, customType: "wrong" },
			{ ...valid, type: "custom" },
			{ ...valid, type: "custom", customType: "" },
			{ ...valid, type: "custom", customType: "bad\0type" },
			{ ...valid, payload: Number.POSITIVE_INFINITY },
		]);
	});

	it("accepts valid complete usage rows and rejects malformed exact usage envelopes", () => {
		const valid = {
			id: ids.usage,
			entryId: ids.entry,
			seq: 2,
			usage: exactUsage,
			adjustment: false,
			details: { provider: "test" },
		};
		expect(() => assertUsageRow(valid)).not.toThrow();
		expectCorruption(assertUsageRow, [
			{ ...valid, entryId: undefined },
			{ ...valid, seq: 0 },
			{ ...valid, seq: Number.MAX_SAFE_INTEGER + 1 },
			{ ...valid, extra: true },
			(({ seq: _seq, ...row }) => row)(valid),
			{ ...valid, id: "bad" },
			{ ...valid, entryId: "bad" },
			{ ...valid, adjustment: 0 },
			{ ...valid, usage: (({ totalTokens: _totalTokens, ...usage }) => usage)(exactUsage) },
			{ ...valid, usage: { ...exactUsage, input: "1" } },
			{ ...valid, usage: { ...exactUsage, unknown: 1 } },
			{ ...valid, usage: { ...exactUsage, cost: { ...exactUsage.cost, total: Number.NaN } } },
			{ ...valid, usage: { ...exactUsage, cost: { ...exactUsage.cost, unknown: 1 } } },
			{ ...valid, details: { invalid: undefined } },
		]);
	});

	it("accepts valid complete registers including an empty key and rejects malformed exact envelopes", () => {
		const valid = { namespace: "fact.name", key: "", value: { name: "session" }, seq: 3 };
		expect(() => assertRegister(valid)).not.toThrow();
		expectCorruption(assertRegister, [
			{ ...valid, seq: 0 },
			{ ...valid, seq: 1.5 },
			{ ...valid, extra: true },
			(({ value: _value, ...register }) => register)(valid),
			{ ...valid, namespace: 1 },
			{ ...valid, namespace: "" },
			{ ...valid, namespace: "fact\0name" },
			{ ...valid, key: 1 },
			{ ...valid, key: "bad\0key" },
			{ ...valid, value: { invalid: undefined } },
		]);
	});
});

describe("MemoryStorage conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group))
				it(testCase.name, () => testCase.run());
		});
	}

	it("generates UUIDv7 ids and followers with inherited timestamps", () => assertIdGeneratorConformance());

	it("instruments immediate detached attempts and durable commits without changing delegate behavior", async () => {
		const delegate = new MemoryStorage();
		const storage = instrumentStorage(delegate);
		const transaction = {
			writes: [{ kind: "register" as const, op: "set" as const, namespace: "n", key: "k", value: { x: 1 } }],
		};
		const result = storage.commit(transaction);
		(transaction.writes[0].value as { x: number }).x = 2;
		expect(storage.attempts).toEqual([
			{
				transaction: { writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: { x: 1 } }] },
				status: "pending",
			},
		]);
		expect(storage.committedTransactions).toEqual([]);
		const continuation = result.then(() => storage.attempts[0]?.status);
		expect(await result).toEqual(await Promise.resolve({ firstSeq: 1, seqs: [1], timestamp: expect.any(Number) }));
		expect(await continuation).toBe("committed");
		expect(storage.committedTransactions).toEqual([
			{ writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: { x: 1 } }] },
		]);
		(transaction.writes[0].value as { x: number }).x = 3;
		expect(storage.attempts[0]?.transaction).toEqual(storage.committedTransactions[0]);
		expect((await delegate.getRegister("n", "k"))?.value).toEqual({ x: 1 });
	});

	it("never records malformed, rejected, or closed commits as durable", async () => {
		const delegate = new MemoryStorage();
		const storage = instrumentStorage(delegate);
		const malformed = { writes: [{ kind: "unknown" }] } as unknown as Transaction;
		const malformedResult = storage.commit(malformed);
		expect(storage.attempts[0]).toEqual({ transaction: malformed, status: "pending" });
		await expect(malformedResult).rejects.toMatchObject({ code: "invalid_transaction" });
		expect(storage.attempts[0]?.status).toBe("rejected");

		const duplicate = {
			writes: [
				{
					kind: "entry" as const,
					entry: {
						id: "018f0000-0000-7000-8000-000000000001",
						parentId: null,
						type: "message" as const,
						payload: {},
					},
				},
			],
		};
		await storage.commit(duplicate);
		await expect(storage.commit(duplicate)).rejects.toMatchObject({ code: "corruption" });
		expect(storage.attempts.at(-1)?.status).toBe("rejected");
		expect(storage.committedTransactions).toEqual([duplicate]);

		await storage.close();
		await expect(storage.commit(duplicate)).rejects.toEqual(expect.any(StorageError));
		expect(storage.attempts.at(-1)?.status).toBe("rejected");
		expect(storage.committedTransactions).toEqual([duplicate]);
	});
});

describe("MemoryStorage ordinary-read conformance", () => {
	for (const testCase of ordinaryReads) it(`${testCase.group}: ${testCase.name}`, () => testCase.run());
});

describe("MemoryStorage shared state", () => {
	it("exposes only the storage factory", () => {
		expectTypeOf<keyof MemoryStorageState>().toEqualTypeOf<"createStorage">();
	});

	it("keeps shared core and lifecycle state private on fresh and closed storage handles", async () => {
		const storage = new MemoryStorageState().createStorage();
		for (const state of ["fresh", "closed"] as const) {
			for (const field of ["core", "sealed", "closePromise"] as const) {
				expect(Object.hasOwn(storage, field), `${state} handle must not own ${field}`).toBe(false);
				expect(field in storage, `${state} handle must not expose ${field}`).toBe(false);
			}
			expect(storage.commit).toEqual(expect.any(Function));
			expect(storage.close).toEqual(expect.any(Function));
			if (state === "fresh") await storage.close();
		}
	});

	it("reopens committed entries, registers, usage stats, and sequence allocation", async () => {
		const state = new MemoryStorageState();
		const storageA = state.createStorage();
		const ids = createIdGenerator();
		const entryId = ids.next();
		const usageId = ids.next();
		const usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			cacheWrite1h: 5,
			reasoning: 6,
			totalTokens: 7,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 5 },
		};

		const first = await storageA.commit({
			writes: [
				{ kind: "entry", entry: { id: entryId, parentId: null, type: "message", payload: { text: "persisted" } } },
				{ kind: "register", op: "set", namespace: "facts", key: "name", value: "session" },
				{ kind: "usage", row: { id: usageId, entryId, adjustment: false, usage } },
			],
		});
		const entries = await storageA.scanEntries();
		const registers = await storageA.listRegisters("facts");
		const stats = await storageA.getStats();
		await storageA.close();

		const storageB = state.createStorage();
		expect(await storageB.scanEntries()).toEqual(entries);
		expect(await storageB.listRegisters("facts")).toEqual(registers);
		expect((await storageB.getUsageRows([usageId])).get(usageId)).toMatchObject({ id: usageId, entryId, seq: 3 });
		expect(await storageB.getStats()).toEqual(stats);
		expect(first.seqs).toEqual([1, 2, 3]);

		await expect(
			storageB.commit({
				writes: [
					{ kind: "entry", entry: { id: ids.next(), parentId: entryId, type: "message", payload: {} } },
					{ kind: "entry", entry: { id: "bad", parentId: entryId, type: "message", payload: {} } },
				],
			}),
		).rejects.toMatchObject({ code: "invalid_id" });
		await storageB.close();

		const storageC = state.createStorage();
		const next = await storageC.commit({
			writes: [{ kind: "register", op: "set", namespace: "facts", key: "reopened", value: true }],
		});
		expect(next.firstSeq).toBe(4);
		await storageC.close();
	});

	it("keeps a closed handle sealed while a new handle remains usable", async () => {
		const state = new MemoryStorageState();
		const storageA = state.createStorage();
		await storageA.close();
		const storageB = state.createStorage();
		const id = createIdGenerator().next();
		const closedOperations = [
			storageA.commit({ writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: 1 }] }),
			storageA.getEntries([id]),
			storageA.getUsageRows([id]),
			storageA.getRegister("n", "k"),
			storageA.listRegisters("n"),
			storageA.scanBranch({ start: id }),
			storageA.scanBranchStructure({ start: id }),
			storageA.scanEntries(),
			storageA.getStats(),
		];
		for (const operation of closedOperations) await expect(operation).rejects.toMatchObject({ code: "closed" });

		await storageB.commit({ writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: 1 }] });
		expect((await storageB.getRegister("n", "k"))?.value).toBe(1);
		await storageB.close();
	});

	it("close drains commits admitted by the closing handle before reopen", async () => {
		const state = new MemoryStorageState();
		const storageA = state.createStorage();
		const id = createIdGenerator().next();
		const admitted = storageA.commit({
			writes: [{ kind: "entry", entry: { id, parentId: null, type: "message", payload: { pending: true } } }],
		});

		await storageA.close();
		await expect(admitted).resolves.toMatchObject({ firstSeq: 1 });
		const storageB = state.createStorage();
		expect((await storageB.getEntries([id])).get(id)).toMatchObject({ id, seq: 1, payload: { pending: true } });
		await storageB.close();
	});
});
