import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StorageError, type Transaction } from "@nguyenphutrong/pi-session-storage";
import {
	createOrdinaryReadConformance,
	type OrdinaryReadConformanceFixture,
} from "@nguyenphutrong/pi-session-storage/testing";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	type SqliteDatabase,
	type SqliteDatabaseFactory,
	type SqliteStatement,
} from "../src/index.ts";
import type { SqliteStorageHandle } from "../src/sqlite/storage/handle.ts";
import type { TimerFactory, TimerHandle } from "../src/sqlite/storage/lifecycle.ts";
import { READ_REGISTERS_SQL } from "../src/sqlite/storage/ordinary-reader.ts";
import { prepareTransaction } from "../src/sqlite/storage/prepared-transaction.ts";
import { SqliteStorageRepository } from "../src/sqlite/storage/repository.ts";
import {
	deleteSqliteSession,
	executeTransaction,
	isPersistedSqliteCorruption,
} from "../src/sqlite/storage/transaction-engine.ts";

const sessionId = "018f0000-0000-7000-8000-000000000001";

class DormantTimers implements TimerFactory {
	readonly handles = new Set<TimerHandle>();
	schedule(_callback: () => void, _delayMs: number): TimerHandle {
		const handle = {};
		this.handles.add(handle);
		return handle;
	}
	cancel(handle: TimerHandle): void {
		this.handles.delete(handle);
	}
}

class ManualTimers extends DormantTimers {
	readonly callbacks = new Map<TimerHandle, () => void>();
	override schedule(callback: () => void, delayMs: number): TimerHandle {
		const handle = super.schedule(callback, delayMs);
		this.callbacks.set(handle, callback);
		return handle;
	}
	override cancel(handle: TimerHandle): void {
		super.cancel(handle);
		this.callbacks.delete(handle);
	}
	fire(): void {
		const [handle] = this.handles;
		if (!handle) throw new Error("Expected a scheduled timer");
		this.handles.delete(handle);
		this.callbacks.get(handle)?.();
		this.callbacks.delete(handle);
	}
}

interface Fixture extends OrdinaryReadConformanceFixture {
	readonly db: SqliteDatabase;
	readonly handle: SqliteStorageHandle;
	readonly repository: SqliteStorageRepository;
}

async function fixture(timers: TimerFactory = new DormantTimers()): Promise<Fixture> {
	const inner = await createNodeSqliteFactory().open(":memory:");
	const db: SqliteDatabase = inner;
	const repository = new SqliteStorageRepository({
		factory: { open: async () => inner },
		path: "ordinary-reader",
		now: () => 100,
		ownerId: () => "ordinary-reader-owner",
		timers,
	});
	const handle = await repository.create({ id: sessionId });
	return {
		db,
		handle,
		repository,
		storage: handle,
		async seed(transaction: Transaction) {
			executeTransaction({
				db,
				sessionId,
				transaction: prepareTransaction(transaction),
				now: () => 200,
				beforeWrites: () => undefined,
				projectInsertedEntry: () => undefined,
			});
		},
		async [Symbol.asyncDispose]() {
			await handle.close().catch(() => undefined);
			await repository.close().catch(() => undefined);
		},
	};
}

const ordinaryReads = createOrdinaryReadConformance(() => fixture());

describe("SQLite ordinary-read conformance", () => {
	for (const testCase of ordinaryReads) it(`${testCase.group}: ${testCase.name}`, () => testCase.run());
});

describe("SQLite ordinary-reader invariants", () => {
	it("uses canonical indexes without branch access, table scans, temporary sorts, or transactions", async () => {
		await using value = await fixture();
		await value.seed({
			writes: [
				{
					kind: "entry",
					entry: { id: "018f0000-0001-7000-8000-000000000002", parentId: null, type: "message", payload: {} },
				},
				{ kind: "register", op: "set", namespace: "n", key: "k", value: 1 },
			],
		});
		const plans = [
			value.db
				.prepare("EXPLAIN QUERY PLAN SELECT id FROM entries WHERE session_id = ? AND id IN (?)")
				.all<{ detail: string }>(sessionId, "018f0000-0001-7000-8000-000000000002"),
			value.db
				.prepare("EXPLAIN QUERY PLAN SELECT id FROM usage_ledger WHERE session_id = ? AND id IN (?)")
				.all<{ detail: string }>(sessionId, "018f0000-0002-7000-8000-000000000003"),
			value.db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT namespace FROM registers WHERE session_id = ? AND namespace = ? AND key = ?",
				)
				.all<{ detail: string }>(sessionId, "n", "k"),
			value.db.prepare(`EXPLAIN QUERY PLAN ${READ_REGISTERS_SQL}`).all<{ detail: string }>(sessionId, "n"),
			value.db
				.prepare(
					"EXPLAIN QUERY PLAN SELECT id FROM entries INDEXED BY ix_entry_seq WHERE session_id = ? ORDER BY seq ASC",
				)
				.all<{ detail: string }>(sessionId),
		]
			.flat()
			.map((row) => row.detail)
			.join("\n");
		expect(plans).toMatch(/PRIMARY KEY|sqlite_autoindex_entries/);
		expect(plans.match(/PRIMARY KEY/g)).toHaveLength(4);
		expect(plans).toContain("ix_entry_seq");
		expect(plans).not.toMatch(/SCAN (entries|usage_ledger|registers)|TEMP B-TREE/);

		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "../src/sqlite/storage/ordinary-reader.ts"),
			"utf8",
		);
		expect(source).not.toMatch(/branch_entries|branch_segments|\.transaction\s*\(|BEGIN|COMMIT/);
	});

	it("decodes SQL NULL separately from stored JSON null", async () => {
		await using value = await fixture();
		const ids = [
			"018f0000-0001-7000-8000-000000000002",
			"018f0000-0002-7000-8000-000000000003",
			"018f0000-0003-7000-8000-000000000004",
			"018f0000-0004-7000-8000-000000000005",
		];
		const zero = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		await value.seed({
			writes: [
				{ kind: "entry", entry: { id: ids[0]!, parentId: null, type: "custom", customType: "x" } },
				{
					kind: "entry",
					entry: { id: ids[1]!, parentId: ids[0]!, type: "custom", customType: "x", payload: null },
				},
				{ kind: "usage", row: { id: ids[2]!, adjustment: false, usage: zero } },
				{ kind: "usage", row: { id: ids[3]!, adjustment: false, usage: zero, details: null } },
				{ kind: "register", op: "set", namespace: "n", key: "null", value: null },
			],
		});
		const entries = await value.handle.getEntries(ids.slice(0, 2));
		expect(entries.get(ids[0]!)).not.toHaveProperty("payload");
		expect(entries.get(ids[1]!)?.payload).toBeNull();
		const usage = await value.handle.getUsageRows(ids.slice(2));
		expect(usage.get(ids[2]!)).not.toHaveProperty("details");
		expect(usage.get(ids[3]!)?.details).toBeNull();
		expect((await value.handle.getRegister("n", "null"))?.value).toBeNull();
	});

	it.each([
		["entry payload", "UPDATE entries SET payload = 'bad'", "getEntries"],
		["usage payload", "UPDATE usage_ledger SET usage = 'bad'", "getUsageRows"],
		["usage details", "UPDATE usage_ledger SET details = 'bad'", "getUsageRows"],
		["register value", "UPDATE registers SET value = 'bad'", "getRegister"],
		["stats payload", "UPDATE session_stats SET usage_payload = 'bad'", "getStats"],
	] as const)("marks malformed persisted %s as corruption and faults only its handle", async (_label, sql, method) => {
		await using value = await fixture();
		const entryId = "018f0000-0001-7000-8000-000000000002";
		const usageId = "018f0000-0002-7000-8000-000000000003";
		const zero = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		await value.seed({
			writes: [
				{ kind: "entry", entry: { id: entryId, parentId: null, type: "message", payload: {} } },
				{ kind: "usage", row: { id: usageId, entryId, adjustment: false, usage: zero, details: {} } },
				{ kind: "register", op: "set", namespace: "n", key: "k", value: {} },
			],
		});
		value.db.exec("PRAGMA ignore_check_constraints=ON");
		value.db.prepare(sql).run();
		value.db.exec("PRAGMA ignore_check_constraints=OFF");
		const operation =
			method === "getEntries"
				? value.handle.getEntries([entryId])
				: method === "getUsageRows"
					? value.handle.getUsageRows([usageId])
					: method === "getRegister"
						? value.handle.getRegister("n", "k")
						: value.handle.getStats();
		let terminal: unknown;
		try {
			await operation;
		} catch (error) {
			terminal = error;
		}
		expect(terminal).toEqual(expect.objectContaining({ code: "corruption" }));
		await expect(value.handle.getStats()).rejects.toMatchObject({ code: "closed" });
	});

	it.each([
		["entry seq", "UPDATE entries SET seq = 0", "getEntries"],
		["entry timestamp", "UPDATE entries SET timestamp = -1", "getEntries"],
		["entry type", "UPDATE entries SET type = 'wrong'", "getEntries"],
		["entry custom scalar", "UPDATE entries SET custom_type = ''", "getEntries"],
		["usage adjustment", "UPDATE usage_ledger SET adjustment = 2", "getUsageRows"],
		["usage seq", "UPDATE usage_ledger SET seq = 0", "getUsageRows"],
		["register seq", "UPDATE registers SET seq = 0", "getRegister"],
		["stats count", "UPDATE session_stats SET message_count = -1", "getStats"],
		["stats Usage shape", "UPDATE session_stats SET usage_payload = '{\"input\":0}'", "getStats"],
	] as const)("marks invalid persisted scalar domain %s as corruption", async (_label, sql, method) => {
		await using value = await fixture();
		const entryId = "018f0000-0001-7000-8000-000000000002";
		const usageId = "018f0000-0002-7000-8000-000000000003";
		const zero = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		await value.seed({
			writes: [
				{ kind: "entry", entry: { id: entryId, parentId: null, type: "custom", customType: "x", payload: {} } },
				{ kind: "usage", row: { id: usageId, entryId, adjustment: false, usage: zero } },
				{ kind: "register", op: "set", namespace: "n", key: "k", value: 1 },
			],
		});
		value.db.exec("PRAGMA ignore_check_constraints=ON");
		value.db.prepare(sql).run();
		value.db.exec("PRAGMA ignore_check_constraints=OFF");
		const operation =
			method === "getEntries"
				? value.handle.getEntries([entryId])
				: method === "getUsageRows"
					? value.handle.getUsageRows([usageId])
					: method === "getRegister"
						? value.handle.getRegister("n", "k")
						: value.handle.getStats();
		await expect(operation).rejects.toMatchObject({ code: "corruption" });
	});

	it("preserves an injected adapter read error by identity", async () => {
		const adapterError = new Error("injected read failure");
		const inner = await createNodeSqliteFactory().open(":memory:");
		let armed = false;
		const db: SqliteDatabase = {
			exec: (sql) => inner.exec(sql),
			transaction: (run) => inner.transaction(run),
			close: () => inner.close(),
			prepare(sql) {
				if (armed && sql.startsWith("SELECT message_count")) throw adapterError;
				return inner.prepare(sql);
			},
		};
		let captured: SqliteDatabase | undefined;
		const factory: SqliteDatabaseFactory = {
			open: async () => {
				captured = db;
				return db;
			},
		};
		const repository = new SqliteStorageRepository({
			factory,
			path: "x",
			now: () => 1,
			ownerId: () => "owner",
			timers: new DormantTimers(),
		});
		const handle = await repository.create({ id: sessionId });
		expect(captured).toBe(db);
		armed = true;
		await expect(handle.getStats()).rejects.toBe(adapterError);
		await handle.close().catch(() => undefined);
		await repository.close().catch(() => undefined);
	});

	it("keeps the ordinary reader and handle out of public exports", () => {
		const root = dirname(fileURLToPath(import.meta.url));
		for (const path of ["../src/index.ts", "../src/sqlite/index.ts"])
			expect(readFileSync(join(root, path), "utf8")).not.toMatch(/ordinary-reader|SqliteStorageHandle/);
	});

	it("admits empty exact reads into the file FIFO before close", async () => {
		await using value = await fixture();
		const trace: string[] = [];
		const commit = value.handle
			.commit({ writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: 1 }] })
			.then(() => trace.push("commit"));
		const empty = value.handle.getEntries([]).then(() => trace.push("empty"));
		const close = value.handle.close().then(() => trace.push("close"));
		await Promise.all([commit, empty, close]);
		expect(trace).toEqual(["commit", "empty", "close"]);
	});

	it("performs zero SQL for queued empty exact reads", async () => {
		await using value = await fixture();
		let prepares = 0;
		const original = value.db.prepare.bind(value.db);
		value.db.prepare = ((sql: string) => {
			prepares++;
			return original(sql);
		}) as SqliteDatabase["prepare"];
		await Promise.all([value.handle.getEntries([]), value.handle.getUsageRows([])]);
		expect(prepares).toBe(0);
	});

	it.each(["entries", "usage"] as const)(
		"rejects a partial multi-chunk %s read when a second file connection deletes the session at exact lease expiry",
		async (kind) => {
			const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-ordinary-recheck-"));
			const path = join(directory, "sessions.sqlite");
			let now = 100;
			let dbA: SqliteDatabase | undefined;
			let dbB: SqliteDatabase | undefined;
			const capturingFactory = (capture: (db: SqliteDatabase) => void): SqliteDatabaseFactory => ({
				async open(databasePath) {
					const db = await createNodeSqliteFactory().open(databasePath);
					capture(db);
					return db;
				},
			});
			const repositoryA = new SqliteStorageRepository({
				factory: capturingFactory((db) => {
					dbA = db;
				}),
				path,
				now: () => now,
				ownerId: () => "reader-a",
				leaseTtlMs: 10,
				heartbeatMs: 5,
				timers: new DormantTimers(),
			});
			const repositoryB = new SqliteStorageRepository({
				factory: capturingFactory((db) => {
					dbB = db;
				}),
				path,
				now: () => now,
				ownerId: () => "deleter-b",
				leaseTtlMs: 10,
				heartbeatMs: 5,
				timers: new DormantTimers(),
			});
			let handle: SqliteStorageHandle | undefined;
			try {
				handle = await repositoryA.create({ id: sessionId });
				await repositoryB.list();
				if (!dbA || !dbB) throw new Error("Expected both file-backed SQLite connections");
				const ids = Array.from(
					{ length: 901 },
					(_, index) =>
						`018f0000-${kind === "entries" ? "0001" : "0002"}-7000-8000-${index.toString(16).padStart(12, "0")}`,
				);
				const zero = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				executeTransaction({
					db: dbA,
					sessionId,
					transaction: prepareTransaction({
						writes:
							kind === "entries"
								? [{ kind: "entry", entry: { id: ids[0]!, parentId: null, type: "message", payload: {} } }]
								: [{ kind: "usage", row: { id: ids[0]!, adjustment: false, usage: zero } }],
					}),
					now: () => 101,
					beforeWrites: () => undefined,
					projectInsertedEntry: () => undefined,
				});

				const trace: string[] = [];
				const originalPrepare = dbA.prepare.bind(dbA);
				const exactPrefix = kind === "entries" ? "SELECT id, parent_id" : "SELECT id, seq, entry_id";
				let exactChunks = 0;
				dbA.prepare = ((sql: string): SqliteStatement => {
					const statement = originalPrepare(sql);
					if (sql.startsWith("SELECT session_id FROM sessions")) trace.push("canonical-recheck");
					if (!sql.startsWith(exactPrefix)) return statement;
					return {
						run: (...params) => statement.run(...params),
						get: <TRow extends object>(...params: unknown[]) => statement.get<TRow>(...params),
						all: <TRow extends object>(...params: unknown[]) => {
							const rows = statement.all<TRow>(...params);
							exactChunks++;
							trace.push(`chunk-${exactChunks}`);
							if (exactChunks === 1) {
								now = 110;
								expect(deleteSqliteSession(dbB!, handle!.metadata, "deleter-b", () => now, 10)).toBe(true);
								trace.push("deleted-at-expiry");
							}
							return rows;
						},
					};
				}) as SqliteDatabase["prepare"];

				let result: ReadonlyMap<string, unknown> | undefined;
				let terminal: unknown;
				try {
					result = kind === "entries" ? await handle.getEntries(ids) : await handle.getUsageRows(ids);
				} catch (error) {
					terminal = error;
				}
				expect(trace).toEqual([
					"canonical-recheck",
					"chunk-1",
					"deleted-at-expiry",
					"chunk-2",
					"canonical-recheck",
				]);
				expect(result).toBeUndefined();
				expect(terminal).toBeInstanceOf(StorageError);
				expect(terminal).toMatchObject({ code: "corruption" });
				expect(isPersistedSqliteCorruption(terminal)).toBe(true);
				await expect(handle.getStats()).rejects.toMatchObject({ code: "closed" });
			} finally {
				await handle?.close().catch(() => undefined);
				await repositoryA.close().catch(() => undefined);
				await repositoryB.close().catch(() => undefined);
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("reopens a fresh handle with prior entries, registers, usage, and stats", async () => {
		await using value = await fixture();
		const entryId = "018f0000-0001-7000-8000-000000000002";
		const usageId = "018f0000-0002-7000-8000-000000000003";
		const zero = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		await value.seed({
			writes: [
				{ kind: "entry", entry: { id: entryId, parentId: null, type: "message", payload: { saved: true } } },
				{ kind: "register", op: "set", namespace: "n", key: "k", value: { saved: true } },
				{ kind: "usage", row: { id: usageId, entryId, adjustment: false, usage: zero } },
			],
		});
		const metadata = value.handle.metadata;
		await value.handle.close();
		const reopened = await value.repository.open(metadata);
		expect((await reopened.getEntries([entryId])).get(entryId)?.payload).toEqual({ saved: true });
		expect((await reopened.getRegister("n", "k"))?.value).toEqual({ saved: true });
		expect((await reopened.getUsageRows([usageId])).has(usageId)).toBe(true);
		expect(await reopened.getStats()).toEqual({ messageCount: 1, usage: zero });
		await reopened.close();
	});

	it("orders commit, non-empty read, fired heartbeat, and close in one FIFO", async () => {
		const timers = new ManualTimers();
		await using value = await fixture(timers);
		const entryId = "018f0000-0001-7000-8000-000000000002";
		await value.seed({
			writes: [{ kind: "entry", entry: { id: entryId, parentId: null, type: "message", payload: {} } }],
		});
		const trace: string[] = [];
		let leaseUpdates = 0;
		const original = value.db.prepare.bind(value.db);
		value.db.prepare = ((sql: string) => {
			if (sql.startsWith("INSERT INTO registers")) trace.push("commit");
			else if (sql.startsWith("SELECT id, parent_id")) trace.push("read");
			else if (sql.startsWith("UPDATE writer_leases") && ++leaseUpdates === 2) trace.push("heartbeat");
			else if (sql.startsWith("DELETE FROM writer_leases")) trace.push("close");
			return original(sql);
		}) as SqliteDatabase["prepare"];
		const commit = value.handle.commit({
			writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: 1 }],
		});
		const read = value.handle.getEntries([entryId]);
		timers.fire();
		await Promise.all([commit, read]);
		await value.handle.close();
		expect(trace).toEqual(["commit", "read", "heartbeat", "close"]);
	});

	it("shares one read terminal by identity, closes later reads, and isolates sibling sessions", async () => {
		await using value = await fixture();
		const siblingId = "018f0000-0009-7000-8000-000000000009";
		const sibling = await value.repository.create({ id: siblingId });
		value.db.exec("PRAGMA ignore_check_constraints=ON");
		value.db.prepare("UPDATE session_stats SET message_count = -1 WHERE session_id = ?").run(sessionId);
		value.db.exec("PRAGMA ignore_check_constraints=OFF");
		const first = value.handle.getStats();
		const admitted = value.handle.getStats();
		let terminal: unknown;
		try {
			await first;
		} catch (error) {
			terminal = error;
		}
		await expect(admitted).rejects.toBe(terminal);
		await expect(value.handle.getStats()).rejects.toMatchObject({ code: "closed" });
		await sibling.commit({ writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: 1 }] });
		expect((await sibling.getRegister("n", "k"))?.value).toBe(1);
		await sibling.close();
	});
});
