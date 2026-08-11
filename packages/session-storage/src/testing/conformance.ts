import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import type { Usage } from "@earendil-works/pi-ai";
import { createFollowerId, createIdGenerator, isUuidV7, uuidV7Timestamp } from "../id.ts";
import { StorageError, type Transaction } from "../types.ts";
import type { StorageConformanceCase, StorageConformanceFixture, StorageConformanceFixtureFactory } from "./types.ts";

const ids = [
	"018f0000-0000-7000-8000-000000000001",
	"018f0000-0001-7000-8000-000000000002",
	"018f0000-0002-7000-8000-000000000003",
	"018f0000-0003-7000-8000-000000000004",
	"018f0000-0004-7000-8000-000000000005",
] as const;

const usage = (seed = 1): Usage => ({
	input: seed,
	output: seed + 1,
	cacheRead: seed + 2,
	cacheWrite: seed + 3,
	cacheWrite1h: seed + 4,
	reasoning: seed + 5,
	totalTokens: seed + 6,
	cost: { input: seed, output: seed + 1, cacheRead: seed + 2, cacheWrite: seed + 3, total: seed + 4 },
});

function entry(id: string, parentId: string | null = null, type: "message" | "compaction" = "message") {
	return { kind: "entry" as const, entry: { id, parentId, type, payload: { id } } };
}

function assertCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof StorageError && error.code === code;
}

function transaction(value: unknown): Transaction {
	return value as Transaction;
}

function testCase(
	factory: StorageConformanceFixtureFactory,
	group: string,
	name: string,
	run: (fixture: StorageConformanceFixture) => Promise<void>,
): StorageConformanceCase {
	return {
		group,
		name,
		async run() {
			await using fixture = await factory();
			await run(fixture);
		},
	};
}

/** Runner-independent acceptance cases shared by memory and durable backends. */
export function createStorageConformance(factory: StorageConformanceFixtureFactory): readonly StorageConformanceCase[] {
	return [
		testCase(
			factory,
			"transactions",
			"commits atomically with one timestamp and consecutive sequence numbers",
			async ({ storage }) => {
				const result = await storage.commit({
					writes: [
						entry(ids[0]),
						entry(ids[1], ids[0]),
						{ kind: "register", op: "set", namespace: "n", key: "k", value: 1 },
					],
				});
				deepStrictEqual(result.seqs, [result.firstSeq, result.firstSeq + 1, result.firstSeq + 2]);
				const rows = await storage.scanEntries();
				deepStrictEqual(
					rows.map((row) => row.seq),
					result.seqs.slice(0, 2),
				);
				ok(rows.every((row) => row.timestamp === result.timestamp));
			},
		),
		testCase(
			factory,
			"transactions",
			"rolls back every write and does not consume sequence numbers",
			async ({ storage }) => {
				await rejects(storage.commit({ writes: [entry(ids[0]), entry("bad", ids[0])] }), assertCode("invalid_id"));
				deepStrictEqual(await storage.scanEntries(), []);
				const result = await storage.commit({ writes: [entry(ids[1])] });
				strictEqual(result.firstSeq, 1);
			},
		),
		testCase(
			factory,
			"identity",
			"enforces one append-only id namespace across entries and usage",
			async ({ storage }) => {
				await storage.commit({
					writes: [
						entry(ids[0]),
						{ kind: "usage", row: { id: ids[1], entryId: ids[0], adjustment: false, usage: usage() } },
					],
				});
				await rejects(storage.commit({ writes: [entry(ids[0])] }), assertCode("corruption"));
				await rejects(
					storage.commit({ writes: [{ kind: "usage", row: { id: ids[1], adjustment: true, usage: usage() } }] }),
					assertCode("corruption"),
				);
				await rejects(storage.commit({ writes: [entry(ids[1])] }), assertCode("corruption"));
				await rejects(
					storage.commit({ writes: [{ kind: "usage", row: { id: ids[0], adjustment: true, usage: usage() } }] }),
					assertCode("corruption"),
				);
			},
		),
		testCase(
			factory,
			"queries",
			"looks up exact usage rows by id and detaches returned values",
			async ({ storage }) => {
				await storage.commit({
					writes: [
						entry(ids[0]),
						{
							kind: "usage",
							row: {
								id: ids[1],
								entryId: ids[0],
								adjustment: false,
								usage: usage(),
								details: { provider: "test" },
							},
						},
					],
				});
				const requestedIds = [ids[1], ids[2]];
				const rows = await storage.getUsageRows(requestedIds);
				deepStrictEqual(requestedIds, [ids[1], ids[2]]);
				deepStrictEqual([...rows.keys()], [ids[1]]);
				const row = rows.get(ids[1]);
				ok(row);
				row.usage.cost.total = 999;
				if (row.details && typeof row.details === "object" && !Array.isArray(row.details))
					row.details.provider = "mutated";
				deepStrictEqual((await storage.getUsageRows([ids[1]])).get(ids[1]), {
					id: ids[1],
					entryId: ids[0],
					seq: 2,
					adjustment: false,
					usage: usage(),
					details: { provider: "test" },
				});
			},
		),
		testCase(factory, "references", "allows only earlier entry parents and usage references", async ({ storage }) => {
			await storage.commit({
				writes: [
					entry(ids[0]),
					entry(ids[1], ids[0]),
					{ kind: "usage", row: { id: ids[2], entryId: ids[1], adjustment: false, usage: usage() } },
				],
			});
			await rejects(
				storage.commit({ writes: [entry(ids[3], ids[4]), entry(ids[4])] }),
				assertCode("invalid_transaction"),
			);
			await rejects(
				storage.commit({
					writes: [
						{ kind: "usage", row: { id: ids[3], entryId: ids[4], adjustment: false, usage: usage() } },
						entry(ids[4]),
					],
				}),
				assertCode("invalid_transaction"),
			);
		}),
		testCase(
			factory,
			"registers",
			"sets, overwrites, deletes, deletes absent keys, recreates, and distinguishes null",
			async ({ storage }) => {
				await storage.commit({
					writes: [{ kind: "register", op: "set", namespace: "facts", key: "x", value: null }],
				});
				strictEqual((await storage.getRegister("facts", "x"))?.value, null);
				await storage.commit({
					writes: [
						{ kind: "register", op: "set", namespace: "facts", key: "x", value: 2 },
						{ kind: "register", op: "delete", namespace: "facts", key: "absent" },
					],
				});
				strictEqual((await storage.getRegister("facts", "x"))?.value, 2);
				await storage.commit({ writes: [{ kind: "register", op: "delete", namespace: "facts", key: "x" }] });
				strictEqual(await storage.getRegister("facts", "x"), undefined);
				await storage.commit({ writes: [{ kind: "register", op: "set", namespace: "facts", key: "x", value: 3 }] });
				deepStrictEqual(
					(await storage.listRegisters("facts")).map(({ key, value }) => ({ key, value })),
					[{ key: "x", value: 3 }],
				);
			},
		),
		testCase(
			factory,
			"registers",
			"allows the empty fact.name key while rejecting empty namespaces and NUL",
			async ({ storage }) => {
				await storage.commit({
					writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "session" }],
				});
				strictEqual((await storage.getRegister("fact.name", ""))?.value, "session");
				await rejects(
					storage.commit({ writes: [{ kind: "register", op: "set", namespace: "", key: "key", value: 1 }] }),
					assertCode("invalid_transaction"),
				);
				await rejects(
					storage.commit({
						writes: [{ kind: "register", op: "set", namespace: "fact\0name", key: "key", value: 1 }],
					}),
					assertCode("invalid_transaction"),
				);
				await rejects(
					storage.commit({
						writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "\0", value: 1 }],
					}),
					assertCode("invalid_transaction"),
				);
			},
		),
		testCase(factory, "immutability", "detaches admitted inputs and every returned value", async ({ storage }) => {
			const tx: Transaction = {
				writes: [entry(ids[0]), { kind: "register", op: "set", namespace: "n", key: "k", value: { nested: [1] } }],
			};
			const pending = storage.commit(tx);
			const firstWrite = tx.writes[0];
			if (firstWrite?.kind !== "entry") throw new Error("Expected entry write");
			(firstWrite.entry.payload as { id: string }).id = "mutated";
			await pending;
			const first = (await storage.getEntries([ids[0]])).get(ids[0]);
			ok(first);
			(first.payload as { id: string }).id = "read mutation";
			const register = await storage.getRegister("n", "k");
			ok(register);
			(register.value as { nested: number[] }).nested.push(2);
			strictEqual(((await storage.getEntries([ids[0]])).get(ids[0])?.payload as { id: string }).id, ids[0]);
			deepStrictEqual((await storage.listRegisters("n"))[0]?.value, { nested: [1] });
			const stats = await storage.getStats();
			stats.usage.cost.total = 999;
			strictEqual((await storage.getStats()).usage.cost.total, 0);
		}),
		testCase(
			factory,
			"stats",
			"maintains exact message count and complete usage sums after each commit",
			async ({ storage }) => {
				await storage.commit({ writes: [entry(ids[0]), entry(ids[1], ids[0], "compaction")] });
				strictEqual((await storage.getStats()).messageCount, 1);
				await storage.commit({
					writes: [
						{ kind: "usage", row: { id: ids[2], entryId: ids[0], adjustment: false, usage: usage(1) } },
						{ kind: "usage", row: { id: ids[3], adjustment: true, usage: usage(10) } },
					],
				});
				const stats = await storage.getStats();
				deepStrictEqual(stats.usage, {
					input: 11,
					output: 13,
					cacheRead: 15,
					cacheWrite: 17,
					cacheWrite1h: 19,
					reasoning: 21,
					totalTokens: 23,
					cost: { input: 11, output: 13, cacheRead: 15, cacheWrite: 17, total: 19 },
				});
				await rejects(
					storage.commit({
						writes: [{ kind: "usage", row: { id: ids[4], adjustment: true, usage: usage() } }, entry("bad")],
					}),
					assertCode("invalid_id"),
				);
				deepStrictEqual(await storage.getStats(), stats);
			},
		),
		testCase(
			factory,
			"queries",
			"applies branch ordering before inclusive stops, filtering, exclusive cursors, and limits",
			async ({ storage }) => {
				await storage.commit({
					writes: [
						entry(ids[0]),
						entry(ids[1], ids[0], "compaction"),
						entry(ids[2], ids[1]),
						entry(ids[3], ids[2], "compaction"),
						entry(ids[4], ids[3]),
					],
				});
				deepStrictEqual(
					(await storage.scanBranch({ start: ids[4], stopAtId: ids[2] })).map((x) => x.id),
					[ids[4], ids[3], ids[2]],
				);
				deepStrictEqual(
					(await storage.scanBranch({ start: ids[4], order: "oldestFirst", stopAtId: ids[2] })).map((x) => x.id),
					[ids[0], ids[1], ids[2]],
				);
				deepStrictEqual(
					(await storage.scanBranch({ start: ids[4], stopAtType: "compaction" })).map((x) => x.id),
					[ids[4], ids[3]],
				);
				deepStrictEqual(
					(await storage.scanBranch({ start: ids[4], order: "oldestFirst", stopAtType: "compaction" })).map(
						(x) => x.id,
					),
					[ids[0], ids[1]],
				);
				deepStrictEqual(
					(await storage.scanBranch({ start: ids[4], stopAtType: "compaction", type: "message" })).map(
						(x) => x.id,
					),
					[ids[4]],
				);
				deepStrictEqual(
					(
						await storage.scanBranch({
							start: ids[4],
							order: "oldestFirst",
							stopAtType: "compaction",
							type: "message",
						})
					).map((x) => x.id),
					[ids[0]],
				);
				deepStrictEqual(
					(
						await storage.scanBranch({
							start: ids[4],
							stopAtId: ids[0],
							type: "compaction",
							cursor: { seq: 5 },
							limit: 1,
						})
					).map((x) => x.id),
					[ids[3]],
				);
				deepStrictEqual(
					(
						await storage.scanBranch({
							start: ids[4],
							order: "oldestFirst",
							stopAtId: ids[4],
							type: "message",
							cursor: { seq: 1 },
							limit: 1,
						})
					).map((x) => x.id),
					[ids[2]],
				);
				const structure = await storage.scanBranchStructure({ start: ids[4] });
				ok(structure.every((row) => !("payload" in row)));
			},
		),
		testCase(
			factory,
			"validation",
			"rejects malformed JSON, envelopes, ids, transactions, and queries",
			async ({ storage }) => {
				await rejects(storage.commit({ writes: [] }), assertCode("invalid_transaction"));
				await rejects(
					storage.commit({
						writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: Number.NaN }],
					}),
					assertCode("invalid_payload"),
				);
				await rejects(
					storage.commit({ writes: [{ kind: "entry", entry: { id: ids[0], parentId: null, type: "message" } }] }),
					assertCode("invalid_transaction"),
				);
				await rejects(
					storage.commit({ writes: [{ kind: "entry", entry: { id: ids[0], parentId: null, type: "custom" } }] }),
					assertCode("invalid_transaction"),
				);
				await rejects(storage.getEntries(["bad"]), assertCode("invalid_query"));
				await rejects(storage.scanEntries({ limit: 0 }), assertCode("invalid_query"));
				await rejects(storage.scanEntries({ fromSeq: -1 }), assertCode("invalid_query"));
				await rejects(storage.scanEntries({ customType: "x" }), assertCode("invalid_query"));
				await rejects(storage.scanBranch({ start: "bad" }), assertCode("invalid_query"));
			},
		),
		testCase(
			factory,
			"validation",
			"rejects unknown write discriminants, fields, and wrong primitives with StorageError",
			async ({ storage }) => {
				const malformed: unknown[] = [
					{ writes: [{ kind: 1 }] },
					{ writes: [{ kind: "mystery" }] },
					{ writes: [{ kind: "register", op: "merge", namespace: "n", key: "k" }] },
					{ writes: [{ kind: "entry", entry: { id: ids[0], parentId: null, type: "unknown", payload: {} } }] },
					{
						writes: [
							{
								kind: "entry",
								extra: true,
								entry: { id: ids[0], parentId: null, type: "message", payload: {} },
							},
						],
					},
					{
						writes: [
							{
								kind: "entry",
								entry: { id: ids[0], parentId: null, type: "message", customType: "x", payload: {} },
							},
						],
					},
					{ writes: [{ kind: "register", op: "delete", namespace: "n", key: "k", value: null }] },
					{ writes: [{ kind: "register", op: "set", namespace: 1, key: "k", value: null }] },
					{ writes: [{ kind: "entry", entry: { id: 1, parentId: null, type: "message", payload: {} } }] },
					{ writes: [{ kind: "usage", row: { id: ids[0], adjustment: false, usage: null } }] },
				];
				for (const value of malformed)
					await rejects(storage.commit(transaction(value)), assertCode("invalid_transaction"));
			},
		),
		testCase(factory, "validation", "rejects malformed transaction and write arrays", async ({ storage }) => {
			const sparse = Array(1);
			const symbolArray = [entry(ids[0])];
			Object.defineProperty(symbolArray, Symbol("extra"), { value: true });
			const accessorArray = [entry(ids[0])];
			Object.defineProperty(accessorArray, "0", { get: () => entry(ids[0]), enumerable: true });
			const hiddenExtraArray = [entry(ids[0])];
			Object.defineProperty(hiddenExtraArray, "extra", { value: true });
			for (const writes of [sparse, symbolArray, accessorArray, hiddenExtraArray])
				await rejects(storage.commit(transaction({ writes })), assertCode("invalid_transaction"));
			for (const value of [null, [], { writes: "no" }, { writes: [entry(ids[0])], extra: true }])
				await rejects(storage.commit(transaction(value)), assertCode("invalid_transaction"));
		}),
		testCase(factory, "validation", "rejects malformed JSON arrays and objects", async ({ storage }) => {
			const sparse = Array(1);
			const symbolArray = [1];
			Object.defineProperty(symbolArray, Symbol("extra"), { value: true });
			const accessorArray = [1];
			Object.defineProperty(accessorArray, "0", { get: () => 1, enumerable: true });
			const hiddenArray = [1];
			Object.defineProperty(hiddenArray, "extra", { value: true });
			const accessorObject = {};
			Object.defineProperty(accessorObject, "x", { get: () => 1, enumerable: true });
			const hiddenObject = {};
			Object.defineProperty(hiddenObject, "x", { value: 1 });
			const symbolObject = { x: 1 };
			Object.defineProperty(symbolObject, Symbol("extra"), { value: true });
			for (const value of [
				sparse,
				symbolArray,
				accessorArray,
				hiddenArray,
				accessorObject,
				hiddenObject,
				symbolObject,
			]) {
				await rejects(
					storage.commit(
						transaction({ writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value }] }),
					),
					assertCode("invalid_payload"),
				);
			}
		}),
		testCase(factory, "validation", "validates every Usage and cost field exactly", async ({ storage }) => {
			const base = usage();
			const invalidUsage: unknown[] = [];
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const) {
				const candidate = { ...base } as Record<string, unknown>;
				delete candidate[key];
				invalidUsage.push(candidate);
			}
			for (const key of [
				"input",
				"output",
				"cacheRead",
				"cacheWrite",
				"cacheWrite1h",
				"reasoning",
				"totalTokens",
			] as const)
				for (const value of ["1", Number.NaN, Number.POSITIVE_INFINITY])
					invalidUsage.push({ ...base, [key]: value });
			for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
				const missing = { ...base.cost } as Record<string, unknown>;
				delete missing[key];
				invalidUsage.push({ ...base, cost: missing });
				for (const value of ["1", Number.NaN, Number.NEGATIVE_INFINITY])
					invalidUsage.push({ ...base, cost: { ...base.cost, [key]: value } });
			}
			invalidUsage.push({ ...base, unknown: 1 }, { ...base, cost: { ...base.cost, unknown: 1 } });
			for (const candidate of invalidUsage)
				await rejects(
					storage.commit(
						transaction({
							writes: [{ kind: "usage", row: { id: ids[0], adjustment: false, usage: candidate } }],
						}),
					),
					assertCode("invalid_transaction"),
				);
			await rejects(
				storage.commit(
					transaction({ writes: [{ kind: "usage", row: { id: ids[0], adjustment: 0, usage: base } }] }),
				),
				assertCode("invalid_transaction"),
			);
		}),
		testCase(
			factory,
			"validation",
			"preserves state, stats, and sequence after every rejected transaction",
			async ({ storage }) => {
				await storage.commit({ writes: [entry(ids[0])] });
				const beforeStats = await storage.getStats();
				await rejects(
					storage.commit(
						transaction({
							writes: [
								{ kind: "usage", row: { id: ids[1], adjustment: false, usage: usage() } },
								{ kind: "unknown" },
							],
						}),
					),
					assertCode("invalid_transaction"),
				);
				deepStrictEqual(await storage.getStats(), beforeStats);
				deepStrictEqual(
					(await storage.scanEntries()).map(({ id, seq }) => ({ id, seq })),
					[{ id: ids[0], seq: 1 }],
				);
				const result = await storage.commit({ writes: [entry(ids[2], ids[0])] });
				strictEqual(result.firstSeq, 2);
			},
		),
		testCase(factory, "stats", "accepts finite negative adjustment usage", async ({ storage }) => {
			const negative = usage(-10);
			await storage.commit({ writes: [{ kind: "usage", row: { id: ids[0], adjustment: true, usage: negative } }] });
			deepStrictEqual((await storage.getStats()).usage, negative);
		}),
		testCase(
			factory,
			"queries",
			"rejects unknown fields, types, orders, malformed cursors, ids, and primitives",
			async ({ storage }) => {
				const invalidEntryScans: unknown[] = [
					null,
					1,
					{ unknown: true },
					{ type: "unknown" },
					{ order: "newest" },
					{ limit: "1" },
					{ fromSeq: "1" },
				];
				for (const value of invalidEntryScans)
					await rejects(
						storage.scanEntries(value as Parameters<typeof storage.scanEntries>[0]),
						assertCode("invalid_query"),
					);
				const invalidBranches: unknown[] = [
					null,
					1,
					{},
					{ start: ids[0], unknown: true },
					{ start: ids[0], type: "unknown" },
					{ start: ids[0], stopAtType: "unknown" },
					{ start: ids[0], order: "asc" },
					{ start: ids[0], cursor: null },
					{ start: ids[0], cursor: {} },
					{ start: ids[0], cursor: { seq: "1" } },
					{ start: ids[0], cursor: { seq: 1, extra: true } },
					{ start: ids[0], stopAtId: "bad" },
				];
				for (const value of invalidBranches)
					await rejects(
						storage.scanBranch(value as Parameters<typeof storage.scanBranch>[0]),
						assertCode("invalid_query"),
					);
				const sparseIds = Array(1);
				const symbolIds = [ids[0]];
				Object.defineProperty(symbolIds, Symbol("extra"), { value: true });
				const hiddenIds = [ids[0]];
				Object.defineProperty(hiddenIds, "extra", { value: true });
				for (const value of [null, "bad", [1], sparseIds, symbolIds, hiddenIds]) {
					await rejects(storage.getEntries(value as string[]), assertCode("invalid_query"));
					await rejects(storage.getUsageRows(value as string[]), assertCode("invalid_query"));
				}
				await rejects(storage.getEntries([ids[0], ids[0]]), assertCode("invalid_query"));
				await rejects(storage.getUsageRows([ids[0], ids[0]]), assertCode("invalid_query"));
				await rejects(storage.getUsageRows(["bad"]), assertCode("invalid_query"));
				await rejects(storage.getRegister(1 as unknown as string, "k"), assertCode("invalid_query"));
				await rejects(storage.listRegisters(null as unknown as string), assertCode("invalid_query"));
			},
		),
		testCase(factory, "serialization", "serializes concurrent admitted commits", async ({ storage }) => {
			const [a, b] = await Promise.all([
				storage.commit({ writes: [entry(ids[0])] }),
				storage.commit({ writes: [entry(ids[1])] }),
			]);
			deepStrictEqual([a.firstSeq, b.firstSeq], [1, 2]);
		}),
		testCase(
			factory,
			"close",
			"is idempotent, drains admitted commits, and seals later operations",
			async ({ storage }) => {
				const commit = storage.commit({ writes: [entry(ids[0])] });
				const first = storage.close();
				const second = storage.close();
				strictEqual(first, second);
				await Promise.all([commit, first]);
				await rejects(storage.commit({ writes: [entry(ids[1])] }), assertCode("closed"));
				await rejects(storage.getUsageRows([ids[1]]), assertCode("closed"));
				await rejects(storage.getStats(), assertCode("closed"));
			},
		),
	];
}

export function assertIdGeneratorConformance(): void {
	const generator = createIdGenerator();
	const leader = generator.next();
	const follower = createFollowerId(leader, generator);
	ok(isUuidV7(leader));
	ok(isUuidV7(follower));
	strictEqual(uuidV7Timestamp(follower), uuidV7Timestamp(leader));
}
