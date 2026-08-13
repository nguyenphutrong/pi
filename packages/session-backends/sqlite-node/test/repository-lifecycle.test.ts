import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonValue, StorageError, type Transaction } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	initializeSqliteSchema,
	type SqliteDatabase,
	type SqliteDatabaseFactory,
	type SqliteStatement,
} from "../src/index.ts";
import { SqliteFileQueue } from "../src/sqlite/storage/file-queue.ts";
import type { SqliteStorageHandle } from "../src/sqlite/storage/handle.ts";
import type { TimerFactory, TimerHandle } from "../src/sqlite/storage/lifecycle.ts";
import { type SqliteRepositoryError, SqliteStorageRepository } from "../src/sqlite/storage/repository.ts";
import {
	acquireSqliteLease,
	createSqliteSession,
	isPersistedSqliteCorruption,
	releaseSqliteLease,
	renewSqliteLease,
} from "../src/sqlite/storage/transaction-engine.ts";

const id1 = "018f0000-0000-7000-8000-000000000001";
const id2 = "018f0000-0001-7000-8000-000000000002";
const id3 = "018f0000-0002-7000-8000-000000000003";
const id4 = "018f0000-0003-7000-8000-000000000004";
const register = (key: string, value: JsonValue = key): Transaction => ({
	writes: [{ kind: "register", op: "set", namespace: "test", key, value }],
});
const invalidParentCases: readonly [string, Transaction][] = [
	["missing", { writes: [{ kind: "entry", entry: { id: id3, parentId: id4, type: "message", payload: {} } }] }],
	[
		"forward",
		{
			writes: [
				{ kind: "entry", entry: { id: id3, parentId: id4, type: "message", payload: {} } },
				{ kind: "entry", entry: { id: id4, parentId: null, type: "message", payload: {} } },
			],
		},
	],
];

class FakeTimers implements TimerFactory {
	readonly pending = new Set<{ callback: () => void; delay: number; unref(): void }>();
	schedule(callback: () => void, delay: number): TimerHandle {
		const handle = { callback, delay, unref() {} };
		this.pending.add(handle);
		return handle;
	}
	cancel(handle: TimerHandle): void {
		this.pending.delete(handle as { callback: () => void; delay: number; unref(): void });
	}
	fire(): void {
		const [handle] = this.pending;
		if (!handle) throw new Error("No timer scheduled");
		this.pending.delete(handle);
		handle.callback();
	}
}

function interceptDatabase(
	db: SqliteDatabase,
	hooks: {
		prepare?: (sql: string, statement: SqliteStatement) => SqliteStatement;
		transaction?: <T>(run: () => T) => T;
		close?: () => void;
	},
): SqliteDatabase {
	return {
		exec: (sql) => db.exec(sql),
		prepare: (sql) => hooks.prepare?.(sql, db.prepare(sql)) ?? db.prepare(sql),
		transaction: <T>(run: () => T) => hooks.transaction?.(run) ?? db.transaction(run),
		close: () => (hooks.close ? hooks.close() : db.close()),
	};
}

async function flushRepository(repo: SqliteStorageRepository): Promise<void> {
	await repo.list();
}

async function capturedRepository(
	options: { now?: () => number; ownerId?: () => string; timers?: TimerFactory } = {},
): Promise<{ repo: SqliteStorageRepository; db: SqliteDatabase }> {
	let db: SqliteDatabase | undefined;
	const factory: SqliteDatabaseFactory = {
		async open() {
			db = await createNodeSqliteFactory().open(":memory:");
			return db;
		},
	};
	const repo = new SqliteStorageRepository({
		factory,
		path: ":memory:",
		now: options.now ?? (() => 100),
		ownerId: options.ownerId ?? (() => "owner"),
		timers: options.timers ?? new FakeTimers(),
	});
	await repo.list();
	return { repo, db: db! };
}

async function engineDatabase(): Promise<SqliteDatabase> {
	const db = await createNodeSqliteFactory().open(":memory:");
	initializeSqliteSchema(db);
	return db;
}

describe("SQLite repository lifecycle", () => {
	it("returns rejected promises for malformed create, open, and delete input before FIFO or SQL", async () => {
		let releaseOpen!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseOpen = resolve;
		});
		const inner = await createNodeSqliteFactory().open(":memory:");
		let sqlCalls = 0;
		const db = interceptDatabase(inner, {
			prepare(_sql, statement) {
				sqlCalls++;
				return statement;
			},
		});
		const repo = new SqliteStorageRepository({
			factory: {
				async open() {
					await gate;
					return db;
				},
			},
			path: "x",
		});
		try {
			const calls = [
				() => repo.create(null as never),
				() => repo.open({ id: "bad", createdAt: 1, storageVersion: 1 }),
				() => repo.delete({ id: id1, createdAt: -1, storageVersion: 1 }),
			];
			for (const call of calls) {
				let promise: Promise<unknown> | undefined;
				expect(() => {
					promise = call();
				}).not.toThrow();
				await expect(promise).rejects.toMatchObject({ code: "validation" });
			}
			expect(sqlCalls).toBe(0);
		} finally {
			releaseOpen();
			await repo.close().catch(() => undefined);
		}
	});

	it("reserves parallel producers and keeps successful handles registered through promise resolution", async () => {
		let owner = 0;
		const { repo } = await capturedRepository({ ownerId: () => `owner-${owner++}` });
		let created: SqliteStorageHandle | undefined;
		let opened: SqliteStorageHandle | undefined;
		try {
			const firstCreate = repo.create({ id: id1 });
			const losingCreate = repo.create({ id: id1 });
			await expect(losingCreate).rejects.toMatchObject({ code: "local_ownership" });
			created = await firstCreate;
			await expect(repo.delete(created.metadata)).rejects.toMatchObject({ code: "local_ownership" });
			const metadata = created.metadata;
			await created.close();
			created = undefined;

			const firstOpen = repo.open(metadata);
			const losingOpen = repo.open(metadata);
			await expect(losingOpen).rejects.toMatchObject({ code: "local_ownership" });
			opened = await firstOpen;
			await expect(repo.delete(metadata)).rejects.toMatchObject({ code: "local_ownership" });
		} finally {
			await created?.close().catch(() => undefined);
			await opened?.close().catch(() => undefined);
			await repo.close().catch(() => undefined);
		}
	});

	it("orders delete before create for the same id", async () => {
		const { repo } = await capturedRepository();
		let handle: SqliteStorageHandle | undefined;
		try {
			handle = await repo.create({ id: id1 });
			const metadata = handle.metadata;
			await handle.close();
			handle = undefined;
			const deletion = repo.delete(metadata);
			const creation = repo.create({ id: id1 });
			await expect(deletion).resolves.toEqual({ deleted: true });
			handle = await creation;
			expect(handle.metadata.id).toBe(id1);
		} finally {
			await handle?.close().catch(() => undefined);
			await repo.close().catch(() => undefined);
		}
	});

	it("reserves initialization as the first FIFO position and continues after rejection", async () => {
		const events: string[] = [];
		let releaseOpen!: () => void;
		const openGate = new Promise<void>((resolve) => {
			releaseOpen = resolve;
		});
		const inner = await createNodeSqliteFactory().open(":memory:");
		const repo = new SqliteStorageRepository({
			factory: {
				async open() {
					events.push("init:start");
					await openGate;
					events.push("init:end");
					return inner;
				},
			},
			path: "x",
			now: () => 1,
			ownerId: () => "owner",
			timers: new FakeTimers(),
		});
		const first = repo.open({ id: id1, createdAt: 1, storageVersion: 1 }).catch((error) => {
			events.push(`first:${(error as SqliteRepositoryError).code}`);
		});
		const second = repo.list().then(() => events.push("second"));
		await Promise.resolve();
		expect(events).toEqual(["init:start"]);
		releaseOpen();
		await Promise.all([first, second]);
		// Queue jobs ran first then second; their attached promise reactions may run in either order.
		expect(events.slice(0, 2)).toEqual(["init:start", "init:end"]);
		expect(events.slice(2).sort()).toEqual(["first:missing", "second"]);
		await repo.close();
	});

	it("atomically creates complete canonical state with one clock call and detached initial input", async () => {
		let clockCalls = 0;
		const { repo, db } = await capturedRepository({
			now: () => {
				clockCalls++;
				return 123;
			},
		});
		const transaction = register("original", { nested: [1] });
		const handlePromise = repo.create({ id: id1, initialTransaction: transaction });
		(transaction.writes[0] as { key: string }).key = "mutated";
		const handle = await handlePromise;
		expect(clockCalls).toBe(1);
		expect(handle.metadata).toEqual({ id: id1, createdAt: 123, storageVersion: 1 });
		expect(db.prepare("SELECT created_at, parent_session_id, storage_version, metadata FROM sessions").get()).toEqual(
			{
				created_at: 123,
				parent_session_id: null,
				storage_version: 1,
				metadata: null,
			},
		);
		expect(db.prepare("SELECT next_seq FROM session_sequences").get()).toEqual({ next_seq: 2 });
		expect(db.prepare("SELECT message_count FROM session_stats").get()).toEqual({ message_count: 0 });
		expect(db.prepare("SELECT owner_id, fence, expires_at_ms FROM writer_leases").get()).toEqual({
			owner_id: "owner",
			fence: 1,
			expires_at_ms: 30_123,
		});
		expect(db.prepare("SELECT key, value, seq FROM registers").get()).toEqual({
			key: "original",
			value: '{"nested":[1]}',
			seq: 1,
		});
		await handle.close();
		await repo.close();
	});

	it("accepts entry transactions through atomic create and handle commit", async () => {
		let clocks = 0;
		const { repo, db } = await capturedRepository({
			now: () => {
				clocks++;
				return 10;
			},
		});
		const entry: Transaction = {
			writes: [{ kind: "entry", entry: { id: id2, parentId: null, type: "message", payload: {} } }],
		};
		const handle = await repo.create({ id: id1, initialTransaction: entry });
		expect(clocks).toBe(1);
		expect(db.prepare("SELECT id, seq FROM entries").all()).toEqual([{ id: id2, seq: 1 }]);
		expect(db.prepare("SELECT branch_id, entry_id, entry_seq FROM branch_entries").all()).toEqual([
			{ branch_id: `segment:${id2}`, entry_id: id2, entry_seq: 1 },
		]);
		await expect(
			handle.commit({
				writes: [
					{
						kind: "entry",
						entry: { id: "018f0000-0002-7000-8000-000000000003", parentId: id2, type: "message", payload: {} },
					},
				],
			}),
		).resolves.toMatchObject({ seqs: [2] });
		expect(db.prepare("SELECT next_seq FROM session_sequences").get()).toEqual({ next_seq: 3 });
		await handle.close();
		await repo.close();
	});

	it("rejects missing segment creation membership on the exact-tip path, rolls back, and seals its handle", async () => {
		let owner = 0;
		const { repo, db } = await capturedRepository({ ownerId: () => `owner-${owner++}` });
		let affected: SqliteStorageHandle | undefined;
		let sibling: SqliteStorageHandle | undefined;
		try {
			affected = await repo.create({ id: id1 });
			sibling = await repo.create({ id: id2 });
			await affected.commit({
				writes: [{ kind: "entry", entry: { id: id3, parentId: null, type: "message", payload: {} } }],
			});
			db.exec("PRAGMA foreign_keys=OFF");
			db.prepare("UPDATE branch_meta SET branch_id = ? WHERE session_id = ?").run(`segment:${id4}`, id1);
			db.prepare("UPDATE branch_entries SET branch_id = ? WHERE session_id = ?").run(`segment:${id4}`, id1);
			db.exec("PRAGMA foreign_keys=ON");
			expect(
				db.prepare("SELECT branch_id, tip_entry_id, tip_seq FROM branch_meta WHERE session_id = ?").get(id1),
			).toEqual({ branch_id: `segment:${id4}`, tip_entry_id: id3, tip_seq: 1 });
			expect(
				db
					.prepare("SELECT entry_id FROM branch_entries WHERE session_id = ? AND branch_id = ? AND entry_id = ?")
					.get(id1, `segment:${id4}`, id4),
			).toBeUndefined();
			const before = Object.fromEntries(
				["entries", "branch_meta", "branch_entries", "session_stats", "session_sequences", "writer_leases"].map(
					(table) => [table, db.prepare(`SELECT * FROM ${table} WHERE session_id = ?`).all(id1)],
				),
			);
			let failure: unknown;
			try {
				await affected.commit({
					writes: [{ kind: "entry", entry: { id: id4, parentId: id3, type: "message", payload: {} } }],
				});
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({ code: "corruption" });
			expect(isPersistedSqliteCorruption(failure)).toBe(true);
			for (const [table, rows] of Object.entries(before))
				expect(db.prepare(`SELECT * FROM ${table} WHERE session_id = ?`).all(id1), table).toEqual(rows);
			await expect(affected.commit(register("late"))).rejects.toMatchObject({ code: "closed" });
			await expect(sibling.commit(register("healthy"))).resolves.toMatchObject({ seqs: [1] });
		} finally {
			await affected?.close().catch(() => undefined);
			await sibling?.close().catch(() => undefined);
			await repo.close().catch(() => undefined);
		}
	});

	it.each(invalidParentCases)("keeps a handle reusable after an invalid %s parent", async (_kind, invalid) => {
		const { repo } = await capturedRepository();
		const handle = await repo.create({ id: id1 });
		try {
			let failure: unknown;
			try {
				await handle.commit(invalid);
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({ code: "invalid_transaction" });
			expect(isPersistedSqliteCorruption(failure)).toBe(false);
			await expect(
				handle.commit({
					writes: [{ kind: "entry", entry: { id: id2, parentId: null, type: "message", payload: {} } }],
				}),
			).resolves.toMatchObject({ seqs: [1] });
		} finally {
			await handle.close();
			await repo.close();
		}
	});

	it("rolls back and seals on a one-shot SQL failure during a later projected entry", async () => {
		const { repo, db } = await capturedRepository();
		const handle = await repo.create({ id: id1 });
		try {
			const before = Object.fromEntries(
				["entries", "branch_meta", "branch_entries", "session_stats", "session_sequences", "writer_leases"].map(
					(table) => [table, db.prepare(`SELECT * FROM ${table} WHERE session_id = ?`).all(id1)],
				),
			);
			db.exec(
				`CREATE TEMP TRIGGER fail_later_projection BEFORE INSERT ON branch_entries WHEN NEW.entry_id = '${id4}' BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`,
			);
			let failure: unknown;
			try {
				await handle.commit({
					writes: [
						{ kind: "entry", entry: { id: id3, parentId: null, type: "message", payload: {} } },
						{ kind: "entry", entry: { id: id4, parentId: id3, type: "message", payload: {} } },
					],
				});
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			expect(failure).not.toBeInstanceOf(StorageError);
			expect((failure as Error).message).toContain("injected projection failure");
			for (const [table, rows] of Object.entries(before))
				expect(db.prepare(`SELECT * FROM ${table} WHERE session_id = ?`).all(id1), table).toEqual(rows);
			await expect(handle.commit(register("late"))).rejects.toMatchObject({ code: "closed" });
		} finally {
			await handle.close().catch(() => undefined);
			await repo.close().catch(() => undefined);
		}
	});

	it("keeps producer reservations visible and cancels queued producers on repository close", async () => {
		let releaseOpen!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseOpen = resolve;
		});
		const inner = await createNodeSqliteFactory().open(":memory:");
		const repo = new SqliteStorageRepository({
			factory: {
				async open() {
					await gate;
					return inner;
				},
			},
			path: "x",
			now: () => 1,
			ownerId: () => "owner",
			timers: new FakeTimers(),
		});
		const producer = repo.create({ id: id1 });
		await expect(repo.delete({ id: id1, createdAt: 1, storageVersion: 1 })).rejects.toMatchObject({
			code: "local_ownership",
		});
		const close = repo.close();
		releaseOpen();
		await expect(producer).rejects.toMatchObject({ code: "closed" });
		await close;
	});

	it("lists exact frozen detached metadata in canonical order and maps exact-open failures", async () => {
		const times = [2, 1, 10, 10];
		let owner = 0;
		const { repo, db } = await capturedRepository({
			now: () => times.shift() ?? 10,
			ownerId: () => `owner-${owner++}`,
		});
		const second = await repo.create({ id: id2 });
		await second.close();
		const first = await repo.create({ id: id1 });
		await first.close();
		const list = await repo.list();
		expect(list.map(({ id }) => id)).toEqual([id1, id2]);
		expect(list.every(Object.isFrozen)).toBe(true);
		await expect(repo.open({ ...list[0]!, createdAt: 99 })).rejects.toMatchObject({ code: "metadata_mismatch" });
		await expect(
			repo.open({ id: "018f0000-0002-7000-8000-000000000003", createdAt: 1, storageVersion: 1 }),
		).rejects.toMatchObject({ code: "missing" });
		db.prepare("UPDATE sessions SET metadata = '{}' WHERE session_id = ?").run(id1);
		await expect(repo.list()).rejects.toMatchObject({ code: "version_mismatch" });
		await repo.close();
	});

	it("returns false for missing delete and rejects local delete without consuming clock", async () => {
		let clocks = 0;
		const { repo } = await capturedRepository({
			now: () => {
				clocks++;
				return 10;
			},
		});
		expect(await repo.delete({ id: id1, createdAt: 1, storageVersion: 1 })).toEqual({ deleted: false });
		const handle = await repo.create({ id: id1 });
		const before = clocks;
		await expect(repo.delete(handle.metadata)).rejects.toMatchObject({ code: "local_ownership" });
		expect(clocks).toBe(before);
		await handle.close();
		await repo.close();
	});

	it("returns the exact close promises, seals synchronously, drains admitted work, and permits reopen", async () => {
		let owner = 0;
		const { repo } = await capturedRepository({ ownerId: () => `owner-${owner++}` });
		const handle = await repo.create({ id: id1 });
		const commit = handle.commit(register("drain"));
		const close = handle.close();
		expect(handle.close()).toBe(close);
		await expect(handle.commit(register("late"))).rejects.toMatchObject({ code: "closed" });
		await expect(commit).resolves.toMatchObject({ seqs: [1] });
		await close;
		const reopened = await repo.open(handle.metadata);
		await reopened.close();
		const repoClose = repo.close();
		expect(repo.close()).toBe(repoClose);
		await repoClose;
	});

	it("uses one file FIFO and rejected jobs do not break or overtake later jobs", async () => {
		const queue = new SqliteFileQueue();
		const events: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = queue.enqueue(async () => {
			events.push("first:start");
			await gate;
			events.push("first:end");
		});
		const rejected = queue.enqueue(() => {
			events.push("rejected");
			throw new Error("expected");
		});
		const last = queue.enqueue(() => events.push("last"));
		await Promise.resolve();
		expect(events).toEqual(["first:start"]);
		release();
		await first;
		await expect(rejected).rejects.toThrow("expected");
		await last;
		expect(events).toEqual(["first:start", "first:end", "rejected", "last"]);
	});

	it("keeps exactly one heartbeat scheduled and reschedules only after queued renewal finishes", async () => {
		const timers = new FakeTimers();
		const { repo } = await capturedRepository({ timers });
		const handle = await repo.create({ id: id1 });
		expect(timers.pending.size).toBe(1);
		timers.fire();
		expect(timers.pending.size).toBe(0);
		await Promise.resolve();
		await Promise.resolve();
		expect(timers.pending.size).toBe(1);
		timers.fire();
		await Promise.resolve();
		await Promise.resolve();
		expect(timers.pending.size).toBe(1);
		await handle.close();
		expect(timers.pending.size).toBe(0);
		await repo.close();
	});

	it("contains transient heartbeat SQL faults, reschedules, and seals only the handle that loses its fence", async () => {
		const timers = new FakeTimers();
		let failRenewal = true;
		const inner = await createNodeSqliteFactory().open(":memory:");
		const db = interceptDatabase(inner, {
			prepare(sql, statement) {
				if (failRenewal && sql.startsWith("UPDATE writer_leases SET expires_at_ms")) {
					failRenewal = false;
					throw new Error("transient heartbeat failure");
				}
				return statement;
			},
		});
		const repo = new SqliteStorageRepository({
			factory: { open: async () => db },
			path: "x",
			now: () => 100,
			ownerId: (() => {
				let id = 0;
				return () => `owner-${id++}`;
			})(),
			timers,
		});
		let first: SqliteStorageHandle | undefined;
		let second: SqliteStorageHandle | undefined;
		try {
			first = await repo.create({ id: id1 });
			second = await repo.create({ id: id2 });
			timers.fire();
			await flushRepository(repo);
			expect(timers.pending.size).toBe(2);
			await expect(first.commit(register("after-transient"))).resolves.toMatchObject({ seqs: [1] });

			inner.prepare("UPDATE writer_leases SET owner_id = 'replacement', fence = 2 WHERE session_id = ?").run(id1);
			const firstTimer = [...timers.pending][0]!;
			timers.pending.delete(firstTimer);
			firstTimer.callback();
			await flushRepository(repo);
			await expect(first.commit(register("lost"))).rejects.toMatchObject({ code: "closed" });
			await expect(second.commit(register("unaffected"))).resolves.toMatchObject({ seqs: [1] });
		} finally {
			await first?.close().catch(() => undefined);
			await second?.close().catch(() => undefined);
			await repo.close().catch(() => undefined);
		}
	});

	it("faults only the source handle for persisted canonical corruption", async () => {
		let owner = 0;
		const { repo, db } = await capturedRepository({ ownerId: () => `owner-${owner++}` });
		let first: SqliteStorageHandle | undefined;
		let second: SqliteStorageHandle | undefined;
		try {
			first = await repo.create({ id: id1 });
			second = await repo.create({ id: id2 });
			db.prepare("UPDATE session_stats SET usage_payload = '{}' WHERE session_id = ?").run(id1);
			const corruption = first.commit(register("corrupt"));
			const alreadyAdmitted = first.commit(register("queued"));
			await expect(corruption).rejects.toMatchObject({ code: "corruption" });
			await expect(alreadyAdmitted).rejects.toMatchObject({ code: "corruption" });
			await expect(first.commit(register("late"))).rejects.toMatchObject({ code: "closed" });
			await expect(second.commit(register("healthy"))).resolves.toMatchObject({ seqs: [1] });
		} finally {
			await first?.close().catch(() => undefined);
			await second?.close().catch(() => undefined);
			await repo.close().catch(() => undefined);
		}
	});

	it("admits all handle and repository operations synchronously in one observable FIFO", async () => {
		const events: string[] = [];
		const inner = await createNodeSqliteFactory().open(":memory:");
		const db = interceptDatabase(inner, {
			prepare(sql, statement) {
				if (sql.startsWith("UPDATE writer_leases SET expires_at_ms")) events.push("commit:start");
				return statement;
			},
		});
		const repo = new SqliteStorageRepository({
			factory: { open: async () => db },
			path: "x",
			now: () => 100,
			ownerId: () => "owner",
			timers: new FakeTimers(),
		});
		const handle = await repo.create({ id: id1 });
		events.length = 0;
		const first = handle.commit(register("first")).then(() => events.push("first:resolved"));
		const list = repo.list().then(() => events.push("list:resolved"));
		const second = handle.commit(register("second")).then(() => events.push("second:resolved"));
		await Promise.all([first, list, second]);
		expect(events).toEqual(["commit:start", "first:resolved", "list:resolved", "commit:start", "second:resolved"]);
		await handle.close();
		await repo.close();
	});

	it("starts synchronous cross-handle commits in exact file FIFO order", async () => {
		const trace: string[] = [];
		const inner = await createNodeSqliteFactory().open(":memory:");
		const db = interceptDatabase(inner, {
			prepare(sql, statement) {
				if (!sql.startsWith("UPDATE writer_leases SET expires_at_ms")) return statement;
				return {
					...statement,
					run(...params) {
						trace.push(params[1] as string);
						return statement.run(...params);
					},
				};
			},
		});
		let owner = 0;
		const repo = new SqliteStorageRepository({
			factory: { open: async () => db },
			path: "x",
			now: () => 100,
			ownerId: () => `owner-${owner++}`,
			timers: new FakeTimers(),
		});
		let h1: SqliteStorageHandle | undefined;
		let h2: SqliteStorageHandle | undefined;
		try {
			h1 = await repo.create({ id: id1 });
			h2 = await repo.create({ id: id2 });
			trace.length = 0;
			const commits = [h1.commit(register("one")), h2.commit(register("two")), h1.commit(register("three"))];
			await Promise.all(commits);
			expect(trace).toEqual([id1, id2, id1]);
		} finally {
			await h1?.close().catch(() => undefined);
			await h2?.close().catch(() => undefined);
			await repo.close().catch(() => undefined);
		}
	});

	it("closes an opened database after initialization failure and preserves initialization error precedence", async () => {
		const inner = await createNodeSqliteFactory().open(":memory:");
		const initializationError = new Error("schema initialization failed");
		let closeAttempts = 0;
		const db: SqliteDatabase = {
			exec() {
				throw initializationError;
			},
			prepare: (sql) => inner.prepare(sql),
			transaction: (run) => inner.transaction(run),
			close() {
				closeAttempts++;
				inner.close();
				throw new Error("connection close failed");
			},
		};
		const repo = new SqliteStorageRepository({ factory: { open: async () => db }, path: "x" });
		await expect(repo.list()).rejects.toBe(initializationError);
		await expect(repo.close()).rejects.toBe(initializationError);
		expect(closeAttempts).toBe(1);
	});

	it("preserves a prior terminal handle error over release failure while cleaning registry", async () => {
		const inner = await createNodeSqliteFactory().open(":memory:");
		let releaseAttempts = 0;
		const db = interceptDatabase(inner, {
			prepare(sql, statement) {
				if (!sql.startsWith("DELETE FROM writer_leases")) return statement;
				return {
					...statement,
					run() {
						releaseAttempts++;
						throw new Error("release failed");
					},
				};
			},
		});
		const repo = new SqliteStorageRepository({
			factory: { open: async () => db },
			path: "x",
			now: () => 100,
			ownerId: () => "owner",
			timers: new FakeTimers(),
		});
		const handle = await repo.create({ id: id1 });
		inner.prepare("UPDATE session_stats SET usage_payload = '{}' WHERE session_id = ?").run(id1);
		let terminal: unknown;
		try {
			await handle.commit(register("fault"));
		} catch (error) {
			terminal = error;
		}
		await expect(handle.close()).rejects.toBe(terminal);
		expect(releaseAttempts).toBe(1);
		await expect(repo.delete(handle.metadata)).rejects.toMatchObject({ code: "busy" });
		await repo.close().catch(() => undefined);
	});

	it("rolls back every bootstrap row when the initial write fails", async () => {
		const inner = await createNodeSqliteFactory().open(":memory:");
		const db = interceptDatabase(inner, {
			prepare(sql, statement) {
				if (!sql.startsWith("INSERT INTO registers")) return statement;
				return {
					...statement,
					run() {
						throw new Error("initial write failed");
					},
				};
			},
		});
		const repo = new SqliteStorageRepository({
			factory: { open: async () => db },
			path: "x",
			now: () => 100,
			ownerId: () => "owner",
			timers: new FakeTimers(),
		});
		try {
			await expect(repo.create({ id: id1, initialTransaction: register("fail") })).rejects.toThrow(
				"initial write failed",
			);
			for (const table of ["sessions", "session_sequences", "session_stats", "writer_leases", "registers"])
				expect(inner.prepare(`SELECT count(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
		} finally {
			await repo.close().catch(() => undefined);
		}
	});

	it("attempts every handle release and database close while returning the first release error", async () => {
		const releases: string[] = [];
		let databaseClosed = false;
		const inner = await createNodeSqliteFactory().open(":memory:");
		const db = interceptDatabase(inner, {
			prepare(sql, statement) {
				if (!sql.startsWith("DELETE FROM writer_leases")) return statement;
				return {
					...statement,
					run(...params) {
						const session = params[0] as string;
						releases.push(session);
						throw new Error(session === id1 ? "first release" : "second release");
					},
				};
			},
			close() {
				databaseClosed = true;
				inner.close();
			},
		});
		let owner = 0;
		const repo = new SqliteStorageRepository({
			factory: { open: async () => db },
			path: "x",
			now: () => 100,
			ownerId: () => `owner-${owner++}`,
			timers: new FakeTimers(),
		});
		await repo.create({ id: id1 });
		await repo.create({ id: id2 });
		await expect(repo.close()).rejects.toThrow("first release");
		expect(releases).toEqual([id1, id2]);
		expect(databaseClosed).toBe(true);
	});

	it("fences two repositories on one real file at the exact expiry boundary", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-lifecycle-"));
		const path = join(directory, "sessions.sqlite");
		let now = 100;
		const timers1 = new FakeTimers();
		const timers2 = new FakeTimers();
		const repo1 = new SqliteStorageRepository({
			factory: createNodeSqliteFactory(),
			path,
			now: () => now,
			ownerId: () => "owner-1",
			leaseTtlMs: 10,
			heartbeatMs: 5,
			timers: timers1,
		});
		const repo2 = new SqliteStorageRepository({
			factory: createNodeSqliteFactory(),
			path,
			now: () => now,
			ownerId: () => "owner-2",
			leaseTtlMs: 10,
			heartbeatMs: 5,
			timers: timers2,
		});
		let stale: SqliteStorageHandle | undefined;
		let replacement: SqliteStorageHandle | undefined;
		try {
			stale = await repo1.create({ id: id1 });
			now = 109;
			await expect(repo2.open(stale.metadata)).rejects.toMatchObject({ code: "busy" });
			now = 110;
			replacement = await repo2.open(stale.metadata);
			await expect(stale.commit(register("stale"))).rejects.toMatchObject({ code: "closed" });
			await stale.close().catch(() => undefined);
			await expect(replacement.commit(register("replacement"))).resolves.toMatchObject({ seqs: [1] });
			await replacement.close();

			const reopened = await repo2.open(stale.metadata);
			await reopened.close();
		} finally {
			await stale?.close().catch(() => undefined);
			await replacement?.close().catch(() => undefined);
			await repo1.close().catch(() => undefined);
			await repo2.close().catch(() => undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("deletes an externally owned real-file session exactly at expiry without stale-release interference", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-sqlite-delete-"));
		const path = join(directory, "sessions.sqlite");
		let now = 100;
		const repo1 = new SqliteStorageRepository({
			factory: createNodeSqliteFactory(),
			path,
			now: () => now,
			ownerId: () => "stale",
			leaseTtlMs: 10,
			heartbeatMs: 5,
			timers: new FakeTimers(),
		});
		const repo2 = new SqliteStorageRepository({
			factory: createNodeSqliteFactory(),
			path,
			now: () => now,
			ownerId: () => "deleter",
			leaseTtlMs: 10,
			heartbeatMs: 5,
			timers: new FakeTimers(),
		});
		let stale: SqliteStorageHandle | undefined;
		try {
			stale = await repo1.create({ id: id1 });
			const metadata = stale.metadata;
			now = 109;
			await expect(repo2.delete(metadata)).rejects.toMatchObject({ code: "busy" });
			now = 110;
			await expect(repo2.delete(metadata)).resolves.toEqual({ deleted: true });
			await stale.close();
			stale = undefined;
			const replacement = await repo2.create({ id: id1 });
			await expect(replacement.commit(register("replacement"))).resolves.toMatchObject({ seqs: [1] });
			await replacement.close();
			expect(await repo2.list()).toHaveLength(1);
		} finally {
			await stale?.close().catch(() => undefined);
			await repo1.close().catch(() => undefined);
			await repo2.close().catch(() => undefined);
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("SQLite lease boundaries", () => {
	it("fences replacement at expiry, preserves active/max fences, saturates expiry, and stale release is exact", async () => {
		const db = await engineDatabase();
		try {
			createSqliteSession(db, { id: id1, storageVersion: 1 }, "first", () => 10, 10);
			expect(() => acquireSqliteLease(db, id1, "second", () => 19, 10)).toThrowError(
				expect.objectContaining({ code: "busy" }),
			);
			expect(db.prepare("SELECT owner_id, fence, expires_at_ms FROM writer_leases").get()).toEqual({
				owner_id: "first",
				fence: 1,
				expires_at_ms: 20,
			});
			expect(acquireSqliteLease(db, id1, "second", () => 20, Number.MAX_SAFE_INTEGER)).toBe(2);
			expect(db.prepare("SELECT owner_id, fence, expires_at_ms FROM writer_leases").get()).toEqual({
				owner_id: "second",
				fence: 2,
				expires_at_ms: Number.MAX_SAFE_INTEGER,
			});
			releaseSqliteLease(db, { sessionId: id1, ownerId: "first", fence: 1 });
			expect(db.prepare("SELECT owner_id, fence FROM writer_leases").get()).toEqual({
				owner_id: "second",
				fence: 2,
			});
			db.prepare("UPDATE writer_leases SET fence = ?, expires_at_ms = 0").run(Number.MAX_SAFE_INTEGER);
			expect(() => acquireSqliteLease(db, id1, "third", () => 1, 10)).toThrowError(
				expect.objectContaining({ code: "fence_exhausted" }),
			);
			expect(db.prepare("SELECT owner_id, fence FROM writer_leases").get()).toEqual({
				owner_id: "second",
				fence: Number.MAX_SAFE_INTEGER,
			});
		} finally {
			db.close();
		}
	});

	it("renews exact live leases and reports loss without changing a replacement", async () => {
		const db = await engineDatabase();
		try {
			createSqliteSession(db, { id: id1, storageVersion: 1 }, "first", () => 10, 10);
			expect(renewSqliteLease(db, { sessionId: id1, ownerId: "first", fence: 1 }, () => 15, 20)).toBe(true);
			expect(db.prepare("SELECT expires_at_ms FROM writer_leases").get()).toEqual({ expires_at_ms: 35 });
			db.prepare("UPDATE writer_leases SET owner_id = 'other', fence = 2, expires_at_ms = 100").run();
			expect(renewSqliteLease(db, { sessionId: id1, ownerId: "first", fence: 1 }, () => 16, 20)).toBe(false);
			expect(db.prepare("SELECT owner_id, fence, expires_at_ms FROM writer_leases").get()).toEqual({
				owner_id: "other",
				fence: 2,
				expires_at_ms: 100,
			});
		} finally {
			db.close();
		}
	});
});

describe("SQLite lifecycle module boundary", () => {
	it("keeps lifecycle private and transaction ownership confined to the engine after schema", () => {
		const root = dirname(fileURLToPath(import.meta.url));
		const sourceRoot = join(root, "../src");
		const rootIndex = readFileSync(join(sourceRoot, "index.ts"), "utf8");
		const sqliteIndex = readFileSync(join(sourceRoot, "sqlite/index.ts"), "utf8");
		expect(rootIndex).not.toMatch(/storage\/|SqliteStorageRepository|SqliteStorageHandle/);
		expect(sqliteIndex).not.toMatch(/storage\/|SqliteStorageRepository|SqliteStorageHandle/);
		for (const name of ["file-queue.ts", "handle.ts", "lifecycle.ts", "prepared-transaction.ts", "repository.ts"])
			expect(readFileSync(join(sourceRoot, "sqlite/storage", name), "utf8"), name).not.toMatch(/\.transaction\s*\(/);
		const engine = readFileSync(join(sourceRoot, "sqlite/storage/transaction-engine.ts"), "utf8");
		expect(engine).toMatch(/\.transaction\s*\(/);
		for (const forbidden of ["record", "reducer", "history", "branch", "Harness"])
			expect(`${rootIndex}\n${sqliteIndex}`).not.toContain(forbidden);
	});
});
