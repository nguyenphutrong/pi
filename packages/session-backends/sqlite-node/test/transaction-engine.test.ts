import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transaction, UsageRow } from "@nguyenphutrong/pi-session-storage";
import { StorageError } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, initializeSqliteSchema, type SqliteDatabase } from "../src/index.ts";
import { type PreparedTransaction, prepareTransaction } from "../src/sqlite/storage/prepared-transaction.ts";
import { executeTransaction, type TransactionEngineContext } from "../src/sqlite/storage/transaction-engine.ts";

const contextHasTransaction: "transaction" extends keyof TransactionEngineContext["db"] ? true : false = false;
const contextHasClose: "close" extends keyof TransactionEngineContext["db"] ? true : false = false;
const contextHasExec: "exec" extends keyof TransactionEngineContext["db"] ? true : false = false;

const ids = [
	"018f0000-0000-7000-8000-000000000001",
	"018f0000-0001-7000-8000-000000000002",
	"018f0000-0002-7000-8000-000000000003",
	"018f0000-0003-7000-8000-000000000004",
	"018f0000-0004-7000-8000-000000000005",
] as const;
type Usage = UsageRow["usage"];

const zeroUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

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

function entry(id: string, parentId: string | null = null, payload: null | { value: string } = { value: id }) {
	return { kind: "entry" as const, entry: { id, parentId, type: "message" as const, payload } };
}

function bootstrap(context: TransactionEngineContext): void {
	context.db
		.prepare("INSERT INTO sessions (session_id, created_at, storage_version) VALUES (?, ?, 1)")
		.run(context.sessionId, context.timestamp);
	context.db.prepare("INSERT INTO session_sequences (session_id, next_seq) VALUES (?, 1)").run(context.sessionId);
	context.db
		.prepare("INSERT INTO session_stats (session_id, message_count, usage_payload) VALUES (?, 0, ?)")
		.run(context.sessionId, JSON.stringify(zeroUsage()));
	context.db
		.prepare("INSERT INTO writer_leases (session_id, owner_id, fence, expires_at_ms) VALUES (?, 'owner', 1, ?)")
		.run(context.sessionId, context.timestamp + 1000);
}

async function database(): Promise<SqliteDatabase> {
	const db = await createNodeSqliteFactory().open(":memory:");
	initializeSqliteSchema(db);
	return db;
}

function run(
	db: SqliteDatabase,
	transaction: Transaction,
	options: {
		beforeWrites?: (context: TransactionEngineContext) => void;
		project?: Parameters<typeof executeTransaction>[0]["projectInsertedEntry"];
		now?: () => number;
	} = {},
) {
	return executeTransaction({
		db,
		sessionId: "session",
		transaction: prepareTransaction(transaction),
		now: options.now ?? (() => 1234),
		beforeWrites: options.beforeWrites ?? (() => undefined),
		projectInsertedEntry: options.project ?? (() => undefined),
	});
}

function expectCode(operation: () => unknown, code: string): void {
	expect(operation).toThrowError(expect.objectContaining({ name: "StorageError", code }));
}

describe("prepared SQLite transaction", () => {
	it("validates, detaches, serializes, and preserves absent values separately from JSON null", () => {
		const payload = { value: "original" };
		const usageValue = usage();
		const details = { source: ["original"] };
		const registerValue = { nested: [1] };
		const tx: Transaction = {
			writes: [
				{
					kind: "entry",
					entry: { id: ids[0], parentId: null, type: "custom", customType: "payload", payload },
				},
				{
					kind: "entry",
					entry: { id: ids[1], parentId: ids[0], type: "custom", customType: "null", payload: null },
				},
				{ kind: "usage", row: { id: ids[2], adjustment: false, usage: usageValue, details } },
				{ kind: "register", op: "set", namespace: "n", key: "k", value: registerValue },
			],
		};
		const prepared = prepareTransaction(tx);
		payload.value = "mutated";
		usageValue.input = 999;
		details.source.push("mutated");
		registerValue.nested.push(2);
		expect(prepared.writes).toMatchObject([
			{ payload: '{"value":"original"}' },
			{ payload: "null" },
			{ entryId: null, usageJson: JSON.stringify(usage()), details: '{"source":["original"]}' },
			{ value: '{"nested":[1]}' },
		]);
		expect(prepared.writes[2]).not.toHaveProperty("usage");
		expect(Object.isFrozen(prepared)).toBe(true);
		expect(Object.isFrozen(prepared.writes)).toBe(true);
		expect(prepared.writes.every(Object.isFrozen)).toBe(true);
		expect(() => (prepared.writes as unknown as object[]).push(prepared.writes[0]!)).toThrow(TypeError);
		expect(() => {
			(prepared.writes[0] as unknown as { id: string }).id = "mutated";
		}).toThrow(TypeError);
		expect(prepared.writes[0]).toMatchObject({ id: ids[0], payload: '{"value":"original"}' });
		expect(() => prepareTransaction({ writes: [] })).toThrowError(StorageError);
		expect(() =>
			prepareTransaction({
				writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: Number.NaN }],
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_payload" }));
	});
});

describe("ordered SQLite transaction engine", () => {
	it("exposes one frozen prepare-only capability to callbacks", async () => {
		expect(contextHasTransaction).toBe(false);
		expect(contextHasClose).toBe(false);
		expect(contextHasExec).toBe(false);
		const db = await database();
		let callbackDb: TransactionEngineContext["db"] | undefined;
		try {
			run(
				db,
				{ writes: [entry(ids[0])] },
				{
					beforeWrites: (context) => {
						callbackDb = context.db;
						expect(context.db).not.toBe(db);
						expect(Object.isFrozen(context.db)).toBe(true);
						expect(Object.keys(context.db)).toEqual(["prepare"]);
						expect(context.db).not.toHaveProperty("transaction");
						expect(context.db).not.toHaveProperty("close");
						expect(context.db).not.toHaveProperty("exec");
						bootstrap(context);
					},
					project: (context) => {
						expect(context.db).toBe(callbackDb);
						expect(context.db.prepare("SELECT id FROM entries").get()).toEqual({ id: ids[0] });
					},
				},
			);
		} finally {
			db.close();
		}
	});

	it("holds the file write lock before beforeWrites reads and then commits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-engine-transaction-"));
		const path = join(directory, "engine.sqlite");
		const factory = createNodeSqliteFactory();
		const first = await factory.open(path);
		const second = await factory.open(path);
		try {
			initializeSqliteSchema(first);
			second.exec("PRAGMA busy_timeout=1");
			const result = run(
				first,
				{ writes: [entry(ids[0])] },
				{
					beforeWrites: (context) => {
						bootstrap(context);
						expect(context.db.prepare("SELECT session_id FROM sessions").get()).toEqual({
							session_id: "session",
						});
						expect(() =>
							second.transaction(() =>
								second
									.prepare(
										"INSERT INTO sessions (session_id, created_at, storage_version) VALUES ('second', 1, 1)",
									)
									.run(),
							),
						).toThrow(/locked/i);
					},
				},
			);
			expect(result.seqs).toEqual([1]);
			expect(second.prepare("SELECT id FROM entries").all()).toEqual([{ id: ids[0] }]);
		} finally {
			first.close();
			second.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("bootstraps and applies initial writes atomically in exactly one transaction", async () => {
		const inner = await database();
		let transactions = 0;
		const db: SqliteDatabase = {
			exec: (sql) => inner.exec(sql),
			prepare: (sql) => inner.prepare(sql),
			transaction: (fn) => {
				transactions++;
				return inner.transaction(fn);
			},
			close: () => inner.close(),
		};
		try {
			let clockCalls = 0;
			const result = run(
				db,
				{ writes: [entry(ids[0])] },
				{
					beforeWrites: bootstrap,
					now: () => {
						clockCalls++;
						return 1234;
					},
				},
			);
			expect(transactions).toBe(1);
			expect(clockCalls).toBe(1);
			expect(result).toEqual({ firstSeq: 1, seqs: [1], timestamp: 1234 });
			expect(inner.prepare("SELECT id FROM entries").all()).toEqual([{ id: ids[0] }]);
			expect(inner.prepare("SELECT owner_id, fence FROM writer_leases").get()).toEqual({
				owner_id: "owner",
				fence: 1,
			});
		} finally {
			db.close();
		}
	});

	it("assigns one timestamp and exact consecutive sequences in caller and projection order", async () => {
		const db = await database();
		const events: string[] = [];
		let projectedCount = 0;
		try {
			run(
				db,
				{ writes: [{ kind: "register", op: "set", namespace: "n", key: "start", value: 1 }] },
				{ beforeWrites: bootstrap },
			);
			const expectedEntries = [
				{ id: ids[0], parentId: null, seq: 2, timestamp: 5678, type: "message", payload: { value: ids[0] } },
				{ id: ids[1], parentId: ids[0], seq: 4, timestamp: 5678, type: "message", payload: { value: ids[1] } },
			];
			const result = run(
				db,
				{
					writes: [
						entry(ids[0]),
						{ kind: "register", op: "set", namespace: "n", key: "middle", value: 2 },
						entry(ids[1], ids[0]),
						{ kind: "usage", row: { id: ids[2], entryId: ids[1], adjustment: false, usage: usage() } },
					],
				},
				{
					beforeWrites: (context) => {
						expect(context.db.prepare("SELECT id FROM entries").all()).toEqual([]);
						events.push("beforeWrites");
					},
					now: () => 5678,
					project: (context, projected) => {
						const index = projectedCount++;
						expect(projected).toEqual(expectedEntries[index]);
						expect(context.db.prepare("SELECT id FROM entries ORDER BY seq").all()).toHaveLength(index + 1);
						expect(context.db.prepare("SELECT seq FROM registers WHERE key = 'middle'").get()).toEqual(
							index === 0 ? undefined : { seq: 3 },
						);
						events.push(`${projected.id}:${projected.seq}:${projected.timestamp}`);
					},
				},
			);
			expect(result).toEqual({ firstSeq: 2, seqs: [2, 3, 4, 5], timestamp: 5678 });
			expect(events).toEqual(["beforeWrites", `${ids[0]}:2:5678`, `${ids[1]}:4:5678`]);
			expect(db.prepare("SELECT seq FROM registers WHERE key = 'middle'").get()).toEqual({ seq: 3 });
		} finally {
			db.close();
		}
	});

	it("accepts committed and earlier references and rejects missing or forward references", async () => {
		const db = await database();
		try {
			run(db, { writes: [entry(ids[0])] }, { beforeWrites: bootstrap });
			run(db, { writes: [entry(ids[1], ids[0]), entry(ids[2], ids[1])] });
			expectCode(() => run(db, { writes: [entry(ids[3], ids[4]), entry(ids[4], ids[2])] }), "invalid_transaction");
			expectCode(
				() =>
					run(db, {
						writes: [{ kind: "usage", row: { id: ids[3], entryId: ids[4], adjustment: false, usage: usage() } }],
					}),
				"invalid_transaction",
			);
		} finally {
			db.close();
		}
	});

	it("maps same-kind and cross-kind duplicate durable ids to corruption", async () => {
		const db = await database();
		try {
			run(db, { writes: [entry(ids[0])] }, { beforeWrites: bootstrap });
			expectCode(() => run(db, { writes: [entry(ids[0])] }), "corruption");
			expectCode(
				() => run(db, { writes: [{ kind: "usage", row: { id: ids[0], adjustment: false, usage: usage() } }] }),
				"corruption",
			);
			expectCode(() => run(db, { writes: [entry(ids[1]), entry(ids[1])] }), "corruption");
			expectCode(
				() =>
					run(db, {
						writes: [entry(ids[2]), { kind: "usage", row: { id: ids[2], adjustment: false, usage: usage() } }],
					}),
				"corruption",
			);
			expectCode(
				() =>
					run(db, {
						writes: [
							{ kind: "usage", row: { id: ids[3], adjustment: false, usage: usage() } },
							{ kind: "usage", row: { id: ids[3], adjustment: true, usage: usage() } },
						],
					}),
				"corruption",
			);
		} finally {
			db.close();
		}
	});

	it("sets, overwrites, deletes absent, deletes, and recreates registers", async () => {
		const db = await database();
		try {
			run(
				db,
				{ writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: null }] },
				{ beforeWrites: bootstrap },
			);
			run(db, {
				writes: [
					{ kind: "register", op: "set", namespace: "n", key: "k", value: 2 },
					{ kind: "register", op: "delete", namespace: "n", key: "absent" },
					{ kind: "register", op: "delete", namespace: "n", key: "k" },
					{ kind: "register", op: "set", namespace: "n", key: "k", value: 3 },
				],
			});
			expect(db.prepare("SELECT value, seq FROM registers").get()).toEqual({ value: "3", seq: 5 });
		} finally {
			db.close();
		}
	});

	it("stores absent optional JSON as SQL NULL and explicit JSON null as text", async () => {
		const db = await database();
		try {
			run(
				db,
				{
					writes: [
						{ kind: "entry", entry: { id: ids[0], parentId: null, type: "custom", customType: "x" } },
						{
							kind: "entry",
							entry: { id: ids[1], parentId: ids[0], type: "custom", customType: "x", payload: null },
						},
						{ kind: "usage", row: { id: ids[2], adjustment: false, usage: usage() } },
						{ kind: "usage", row: { id: ids[3], adjustment: false, usage: usage(), details: null } },
					],
				},
				{ beforeWrites: bootstrap },
			);
			expect(db.prepare("SELECT payload FROM entries ORDER BY seq").all()).toEqual([
				{ payload: null },
				{ payload: "null" },
			]);
			expect(db.prepare("SELECT entry_id, details FROM usage_ledger ORDER BY seq").all()).toEqual([
				{ entry_id: null, details: null },
				{ entry_id: null, details: "null" },
			]);
		} finally {
			db.close();
		}
	});

	it("computes complete stats, preserving optional totals and finite negative adjustments", async () => {
		const db = await database();
		try {
			run(
				db,
				{ writes: [entry(ids[0]), { kind: "usage", row: { id: ids[1], adjustment: false, usage: usage(1) } }] },
				{ beforeWrites: bootstrap },
			);
			const negative = usage(-2);
			delete negative.cacheWrite1h;
			delete negative.reasoning;
			run(db, { writes: [{ kind: "usage", row: { id: ids[2], adjustment: true, usage: negative } }] });
			const row = db
				.prepare("SELECT message_count, usage_payload FROM session_stats")
				.get<{ message_count: number; usage_payload: string }>();
			expect(row?.message_count).toBe(1);
			expect(JSON.parse(row!.usage_payload)).toEqual({
				input: -1,
				output: 1,
				cacheRead: 3,
				cacheWrite: 5,
				cacheWrite1h: 5,
				reasoning: 6,
				totalTokens: 11,
				cost: { input: -1, output: 1, cacheRead: 3, cacheWrite: 5, total: 7 },
			});
		} finally {
			db.close();
		}
	});

	it("rejects internally corrupted prepared usage before inserting its ledger row", async () => {
		const db = await database();
		try {
			run(
				db,
				{ writes: [{ kind: "register", op: "set", namespace: "n", key: "seed", value: 1 }] },
				{ beforeWrites: bootstrap },
			);
			const valid = prepareTransaction({
				writes: [{ kind: "usage", row: { id: ids[0], adjustment: false, usage: usage() } }],
			});
			const preparedWrite = valid.writes[0]!;
			if (preparedWrite.kind !== "usage") throw new Error("Expected prepared usage write");
			const corrupted: PreparedTransaction = {
				writes: [{ ...preparedWrite, usageJson: "not json" }],
			};
			expectCode(
				() =>
					executeTransaction({
						db,
						sessionId: "session",
						transaction: corrupted,
						now: () => 1234,
						beforeWrites: () => undefined,
						projectInsertedEntry: () => undefined,
					}),
				"corruption",
			);
			expect(db.prepare("SELECT count(*) AS count FROM usage_ledger").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT usage_payload FROM session_stats").get()).toEqual({
				usage_payload: JSON.stringify(zeroUsage()),
			});
		} finally {
			db.close();
		}
	});

	it.each([
		["stats", "session_stats"],
		["sequence", "session_sequences"],
	] as const)("rolls back writes when the final %s update fails", async (_name, table) => {
		const db = await database();
		try {
			run(
				db,
				{ writes: [{ kind: "register", op: "set", namespace: "n", key: "seed", value: 1 }] },
				{ beforeWrites: bootstrap },
			);
			db.exec(
				`CREATE TEMP TRIGGER reject_final_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'final update failed'); END`,
			);
			expect(() => run(db, { writes: [entry(ids[0])] })).toThrow("final update failed");
			expect(db.prepare("SELECT count(*) AS count FROM entries").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT message_count FROM session_stats").get()).toEqual({ message_count: 0 });
			expect(db.prepare("SELECT next_seq FROM session_sequences").get()).toEqual({ next_seq: 2 });
		} finally {
			db.close();
		}
	});

	it.each([
		["input"],
		["output"],
		["cacheRead"],
		["cacheWrite"],
		["totalTokens"],
		["cacheWrite1h"],
		["reasoning"],
	] as const)("rejects usage.%s overflow and rolls back every projection", async (field) => {
		const db = await database();
		try {
			run(
				db,
				{ writes: [{ kind: "register", op: "set", namespace: "n", key: "seed", value: 1 }] },
				{ beforeWrites: bootstrap },
			);
			const baseline = zeroUsage();
			baseline[field] = Number.MAX_VALUE;
			db.prepare("UPDATE session_stats SET usage_payload = ?").run(JSON.stringify(baseline));
			const addition = zeroUsage();
			addition[field] = Number.MAX_VALUE;
			const statsBefore = db.prepare("SELECT * FROM session_stats").get();
			expectCode(
				() => run(db, { writes: [{ kind: "usage", row: { id: ids[0], adjustment: true, usage: addition } }] }),
				"invalid_transaction",
			);
			expect(db.prepare("SELECT count(*) AS count FROM usage_ledger").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT * FROM session_stats").get()).toEqual(statsBefore);
			expect(db.prepare("SELECT next_seq FROM session_sequences").get()).toEqual({ next_seq: 2 });
		} finally {
			db.close();
		}
	});

	it.each(["input", "output", "cacheRead", "cacheWrite", "total"] as const)(
		"rejects usage.cost.%s overflow and rolls back every projection",
		async (field) => {
			const db = await database();
			try {
				run(
					db,
					{ writes: [{ kind: "register", op: "set", namespace: "n", key: "seed", value: 1 }] },
					{ beforeWrites: bootstrap },
				);
				const baseline = zeroUsage();
				baseline.cost[field] = Number.MAX_VALUE;
				db.prepare("UPDATE session_stats SET usage_payload = ?").run(JSON.stringify(baseline));
				const addition = zeroUsage();
				addition.cost[field] = Number.MAX_VALUE;
				const statsBefore = db.prepare("SELECT * FROM session_stats").get();
				expectCode(
					() => run(db, { writes: [{ kind: "usage", row: { id: ids[0], adjustment: true, usage: addition } }] }),
					"invalid_transaction",
				);
				expect(db.prepare("SELECT count(*) AS count FROM usage_ledger").get()).toEqual({ count: 0 });
				expect(db.prepare("SELECT * FROM session_stats").get()).toEqual(statsBefore);
				expect(db.prepare("SELECT next_seq FROM session_sequences").get()).toEqual({ next_seq: 2 });
			} finally {
				db.close();
			}
		},
	);

	it("permits the final safe sequence, then rejects exhaustion without consuming anything", async () => {
		const db = await database();
		try {
			run(
				db,
				{ writes: [{ kind: "register", op: "set", namespace: "n", key: "seed", value: 1 }] },
				{ beforeWrites: bootstrap },
			);
			db.prepare("UPDATE session_sequences SET next_seq = ?").run(Number.MAX_SAFE_INTEGER - 1);
			const final = run(db, {
				writes: [{ kind: "register", op: "set", namespace: "n", key: "final", value: true }],
			});
			expect(final.seqs).toEqual([Number.MAX_SAFE_INTEGER - 1]);
			expect(db.prepare("SELECT next_seq FROM session_sequences").get()).toEqual({
				next_seq: Number.MAX_SAFE_INTEGER,
			});
			const statsBefore = db.prepare("SELECT * FROM session_stats").get();
			expectCode(
				() =>
					run(db, {
						writes: [{ kind: "register", op: "set", namespace: "n", key: "exhausted", value: true }],
					}),
				"invalid_transaction",
			);
			expect(db.prepare("SELECT key FROM registers ORDER BY seq").all()).toEqual([
				{ key: "seed" },
				{ key: "final" },
			]);
			expect(db.prepare("SELECT * FROM session_stats").get()).toEqual(statsBefore);
			expect(db.prepare("SELECT next_seq FROM session_sequences").get()).toEqual({
				next_seq: Number.MAX_SAFE_INTEGER,
			});
		} finally {
			db.close();
		}
	});

	it("rejects unsafe message count and rolls back entry, stats, and sequence", async () => {
		const db = await database();
		try {
			run(
				db,
				{ writes: [{ kind: "register", op: "set", namespace: "n", key: "seed", value: 1 }] },
				{ beforeWrites: bootstrap },
			);
			db.prepare("UPDATE session_stats SET message_count = ?").run(Number.MAX_SAFE_INTEGER);
			expectCode(() => run(db, { writes: [entry(ids[0])] }), "invalid_transaction");
			expect(db.prepare("SELECT count(*) AS count FROM entries").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT message_count FROM session_stats").get()).toEqual({
				message_count: Number.MAX_SAFE_INTEGER,
			});
			expect(db.prepare("SELECT next_seq FROM session_sequences").get()).toEqual({ next_seq: 2 });
		} finally {
			db.close();
		}
	});

	it("rolls back prologue, write, and projection failures and remains reusable after caller errors", async () => {
		const db = await database();
		try {
			expect(() =>
				run(
					db,
					{ writes: [entry(ids[0])] },
					{
						beforeWrites: (context) => {
							bootstrap(context);
							throw new Error("prologue");
						},
					},
				),
			).toThrow("prologue");
			expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT count(*) AS count FROM writer_leases").get()).toEqual({ count: 0 });
			expect(() =>
				run(
					db,
					{ writes: [entry(ids[0])] },
					{
						beforeWrites: bootstrap,
						project: () => {
							throw new Error("initial projection");
						},
					},
				),
			).toThrow("initial projection");
			expect(db.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT count(*) AS count FROM session_sequences").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT count(*) AS count FROM session_stats").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT count(*) AS count FROM writer_leases").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT count(*) AS count FROM entries").get()).toEqual({ count: 0 });
			run(
				db,
				{ writes: [{ kind: "register", op: "set", namespace: "n", key: "seed", value: 1 }] },
				{ beforeWrites: bootstrap },
			);
			const before = db.prepare("SELECT * FROM session_stats").get();
			expect(() =>
				run(
					db,
					{ writes: [entry(ids[0])] },
					{
						project: () => {
							throw new Error("projection");
						},
					},
				),
			).toThrow("projection");
			expect(db.prepare("SELECT count(*) AS count FROM entries").get()).toEqual({ count: 0 });
			expect(db.prepare("SELECT * FROM session_stats").get()).toEqual(before);
			db.exec(
				"CREATE TEMP TRIGGER reject_entry BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'write failed'); END",
			);
			expect(() => run(db, { writes: [entry(ids[1])] })).toThrow("write failed");
			db.exec("DROP TRIGGER reject_entry");
			expectCode(() => run(db, { writes: [entry(ids[2], ids[4])] }), "invalid_transaction");
			const result = run(db, { writes: [entry(ids[3])] });
			expect(result.firstSeq).toBe(2);
			expect(db.prepare("SELECT message_count FROM session_stats").get()).toEqual({ message_count: 1 });
			expect(db.prepare("SELECT next_seq FROM session_sequences").get()).toEqual({ next_seq: 3 });
		} finally {
			db.close();
		}
	});

	it("treats missing canonical rows as corruption and retains unexpected SQLite errors", async () => {
		const db = await database();
		try {
			run(
				db,
				{ writes: [{ kind: "register", op: "set", namespace: "n", key: "seed", value: 1 }] },
				{ beforeWrites: bootstrap },
			);
			db.prepare("DELETE FROM session_stats WHERE session_id = ?").run("session");
			expectCode(() => run(db, { writes: [entry(ids[0])] }), "corruption");
			const sqliteError = new Error("adapter fault");
			const broken: SqliteDatabase = {
				...db,
				transaction: () => {
					throw sqliteError;
				},
			};
			try {
				run(broken, { writes: [entry(ids[1])] });
				throw new Error("Expected adapter fault");
			} catch (error) {
				expect(error).toBe(sqliteError);
			}
		} finally {
			db.close();
		}
	});
});
