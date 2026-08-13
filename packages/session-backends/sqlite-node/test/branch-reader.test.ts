import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EntryType, StorageError, type Transaction } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	type SqliteDatabase,
	type SqliteDatabaseFactory,
	type SqliteStatement,
} from "../src/index.ts";
import { MATERIALIZE_SEGMENT_SQL } from "../src/sqlite/storage/branch-chain.ts";
import { READ_BRANCH_PAYLOAD_SQL, READ_TYPED_BRANCH_PAYLOAD_SQL } from "../src/sqlite/storage/branch-reader.ts";
import type { SqliteStorageHandle } from "../src/sqlite/storage/handle.ts";
import type { TimerFactory, TimerHandle } from "../src/sqlite/storage/lifecycle.ts";
import { SqliteStorageRepository } from "../src/sqlite/storage/repository.ts";
import { deleteSqliteSession, isPersistedSqliteCorruption } from "../src/sqlite/storage/transaction-engine.ts";

const sessionId = "018f2000-0000-7000-8000-000000000000";
const siblingId = "018f2000-ffff-7000-8000-000000000000";
const ids = Array.from(
	{ length: 32 },
	(_, index) => `018f2000-${String(index + 1).padStart(4, "0")}-7000-8000-${String(index + 1).padStart(12, "0")}`,
);

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

interface Fixture extends AsyncDisposable {
	readonly db: SqliteDatabase;
	readonly handle: SqliteStorageHandle;
	readonly repository: SqliteStorageRepository;
}

async function fixture(): Promise<Fixture> {
	const db = await createNodeSqliteFactory().open(":memory:");
	const repository = new SqliteStorageRepository({
		factory: { open: async () => db },
		path: "branch-reader",
		now: () => 100,
		ownerId: () => "branch-reader-owner",
		timers: new DormantTimers(),
	});
	const handle = await repository.create({ id: sessionId });
	return {
		db,
		handle,
		repository,
		async [Symbol.asyncDispose]() {
			await handle.close().catch(() => undefined);
			await repository.close().catch(() => undefined);
		},
	};
}

function entry(
	index: number,
	parentIndex: number | null,
	type: EntryType = "message",
	customType?: string,
): Transaction["writes"][number] {
	return {
		kind: "entry",
		entry: {
			id: ids[index]!,
			parentId: parentIndex === null ? null : ids[parentIndex]!,
			type,
			...(customType === undefined ? {} : { customType }),
			payload: { index, marker: `payload-${index}` },
		},
	};
}

async function commit(handle: SqliteStorageHandle, ...writes: Transaction["writes"]): Promise<void> {
	await handle.commit({ writes });
}

function exact(entries: Awaited<ReturnType<SqliteStorageHandle["scanBranch"]>>) {
	return entries.map(({ id, seq, type, customType, payload }) => ({ id, seq, type, customType, payload }));
}

async function expectPersistedCorruption(operation: Promise<unknown>): Promise<unknown> {
	let terminal: unknown;
	try {
		await operation;
	} catch (error) {
		terminal = error;
	}
	expect(terminal).toBeInstanceOf(StorageError);
	expect(terminal).toMatchObject({ code: "corruption" });
	expect(isPersistedSqliteCorruption(terminal)).toBe(true);
	return terminal;
}

async function seedComplex(handle: SqliteStorageHandle): Promise<void> {
	await commit(
		handle,
		entry(0, null),
		entry(1, 0, "custom", "alpha"),
		entry(2, 1, "compaction"),
		entry(3, 2),
		entry(4, 3, "custom", "beta"),
		entry(5, 4, "compaction"),
		entry(6, 5, "custom", "alpha"),
		entry(7, 6),
	);
	await commit(handle, entry(8, 6));
	await commit(handle, entry(9, 4, "custom", "alpha"));
}

describe("SQLite segmented branch reader", () => {
	it("matches exact Memory ordering, inclusive stop, filtering, cursor, and limit semantics", async () => {
		await using value = await fixture();
		await seedComplex(value.handle);

		expect(exact(await value.handle.scanBranch({ start: ids[7]! }))).toEqual(
			[7, 6, 5, 4, 3, 2, 1, 0].map((index) => ({
				id: ids[index],
				seq: index + 1,
				type:
					index === 2 || index === 5
						? "compaction"
						: index === 1 || index === 4 || index === 6
							? "custom"
							: "message",
				customType: index === 1 || index === 6 ? "alpha" : index === 4 ? "beta" : undefined,
				payload: { index, marker: `payload-${index}` },
			})),
		);
		expect((await value.handle.scanBranch({ start: ids[7]!, order: "oldestFirst" })).map((item) => item.id)).toEqual(
			[0, 1, 2, 3, 4, 5, 6, 7].map((index) => ids[index]),
		);
		expect(
			exact(
				await value.handle.scanBranch({
					start: ids[7]!,
					stopAtType: "compaction",
					type: "custom",
					customType: "alpha",
				}),
			),
		).toEqual([
			{ id: ids[6], seq: 7, type: "custom", customType: "alpha", payload: { index: 6, marker: "payload-6" } },
		]);
		expect(
			(
				await value.handle.scanBranch({ start: ids[7]!, order: "oldestFirst", stopAtId: ids[5], type: "custom" })
			).map((item) => item.id),
		).toEqual([ids[1], ids[4]]);
		expect(
			(await value.handle.scanBranch({ start: ids[7]!, cursor: { seq: 7 }, limit: 2 })).map((item) => item.id),
		).toEqual([ids[5], ids[4]]);
		expect(
			(await value.handle.scanBranch({ start: ids[7]!, order: "oldestFirst", cursor: { seq: 3 }, limit: 2 })).map(
				(item) => item.id,
			),
		).toEqual([ids[3], ids[4]]);
	});

	it("keeps every stale and current nested-base path exact and assigns the compaction junction to its older base", async () => {
		await using value = await fixture();
		await commit(value.handle, entry(0, null), entry(1, 0, "compaction"), entry(2, 1), entry(3, 2));
		await commit(value.handle, entry(4, 2), entry(5, 4, "compaction"), entry(6, 5));
		await commit(value.handle, entry(7, 4), entry(8, 7, "compaction"), entry(9, 8));
		await commit(value.handle, entry(10, 9));
		await commit(value.handle, entry(11, 9));
		const expected = new Map<number, number[]>([
			[3, [0, 1, 2, 3]],
			[6, [0, 1, 2, 4, 5, 6]],
			[10, [0, 1, 2, 4, 7, 8, 9, 10]],
			[11, [0, 1, 2, 4, 7, 8, 9, 11]],
		]);
		for (const [tip, path] of expected)
			expect(
				(await value.handle.scanBranch({ start: ids[tip]!, order: "oldestFirst" })).map(({ id }) => id),
			).toEqual(path.map((index) => ids[index]));
		const newest = value.db
			.prepare("SELECT base_branch_id, base_seq FROM branch_meta WHERE session_id = ? AND branch_id = ?")
			.get<{ base_branch_id: string; base_seq: number }>(sessionId, `segment:${ids[11]}`);
		expect(newest).toEqual({ base_branch_id: `segment:${ids[7]}`, base_seq: 9 });
		expect(
			value.db
				.prepare("SELECT branch_id FROM branch_entries WHERE session_id = ? AND entry_id = ? ORDER BY branch_id")
				.all(sessionId, ids[8]),
		).toContainEqual({ branch_id: `segment:${ids[7]}` });
	});

	it("returns detached structure in payload order without selecting payload", async () => {
		await using value = await fixture();
		await seedComplex(value.handle);
		const prepared: string[] = [];
		const original = value.db.prepare.bind(value.db);
		value.db.prepare = ((sql: string) => {
			prepared.push(sql);
			return original(sql);
		}) as SqliteDatabase["prepare"];
		const query = { start: ids[7]!, type: "custom" as const };
		const structure = await value.handle.scanBranchStructure(query);
		const structureSql = prepared.join("\n");
		prepared.length = 0;
		const payload = await value.handle.scanBranch(query);
		expect(structure.map(({ id }) => id)).toEqual(payload.map(({ id }) => id));
		expect(Object.keys(structure[0]!)).not.toContain("payload");
		expect(structureSql).not.toMatch(/e\.payload|\bpayload\b/i);
		query.start = ids[0]!;
		(structure[0] as { id: string }).id = ids[31]!;
		expect((await value.handle.scanBranchStructure({ start: ids[7]!, type: "custom" })).map(({ id }) => id)).toEqual([
			ids[6],
			ids[4],
			ids[1],
		]);
	});

	it("runs no payload SQL for an empty selected result while validating closure and the canonical session", async () => {
		await using value = await fixture();
		await commit(value.handle, entry(0, null), entry(1, 0));
		const prepared: string[] = [];
		const original = value.db.prepare.bind(value.db);
		value.db.prepare = ((sql: string) => {
			prepared.push(sql);
			return original(sql);
		}) as SqliteDatabase["prepare"];
		expect(await value.handle.scanBranch({ start: ids[1]!, type: "compaction" })).toEqual([]);
		expect(
			prepared.filter((sql) => sql === READ_BRANCH_PAYLOAD_SQL || sql === READ_TYPED_BRANCH_PAYLOAD_SQL),
		).toEqual([]);
		expect(prepared.filter((sql) => sql.startsWith("SELECT session_id FROM sessions"))).toHaveLength(2);
		expect(prepared).toContain(MATERIALIZE_SEGMENT_SQL);
	});

	it("uses the exact branch driver and entry point-join plans without payload materialization", async () => {
		await using value = await fixture();
		await commit(value.handle, entry(0, null), entry(1, 0, "custom", "x"));
		const plans = [
			value.db.prepare(`EXPLAIN QUERY PLAN ${READ_BRANCH_PAYLOAD_SQL}`).all(sessionId, `segment:${ids[0]}`, 1, 2),
			value.db
				.prepare(`EXPLAIN QUERY PLAN ${READ_TYPED_BRANCH_PAYLOAD_SQL}`)
				.all(sessionId, `segment:${ids[0]}`, "custom", 1, 2),
			value.db.prepare(`EXPLAIN QUERY PLAN ${MATERIALIZE_SEGMENT_SQL}`).all(sessionId, `segment:${ids[0]}`),
		].map((rows) => rows.map((row) => (row as { detail: string }).detail).join("\n"));
		expect(plans[0]).toMatch(/ix_be_seq/);
		expect(plans[1]).toMatch(/ix_be_type/);
		for (const plan of plans) {
			expect(plan).toMatch(/SEARCH e USING PRIMARY KEY \(session_id=\? AND id=\?\)/);
			expect(plan).not.toMatch(/SCAN entries|TEMP B-TREE/);
		}
		expect(MATERIALIZE_SEGMENT_SQL).not.toMatch(/payload/i);
	});

	it.each([
		["missing start", "DELETE FROM entries WHERE session_id = ? AND id = ?", ids[1]],
		["missing projection", "DELETE FROM branch_entries WHERE session_id = ? AND entry_id = ?", ids[1]],
		["malformed structure", "UPDATE entries SET timestamp = -1 WHERE session_id = ? AND id = ?", ids[1]],
		["malformed metadata", "UPDATE branch_meta SET tip_seq = 99 WHERE session_id = ?", undefined],
		[
			"malformed membership",
			"UPDATE branch_entries SET entry_type = 'custom' WHERE session_id = ? AND entry_id = ?",
			ids[1],
		],
		["malformed payload JSON", "UPDATE entries SET payload = 'bad' WHERE session_id = ? AND id = ?", ids[1]],
		["invalid optional payload shape", "UPDATE entries SET payload = NULL WHERE session_id = ? AND id = ?", ids[1]],
	] as const)(
		"marks %s as private corruption, seals only that handle, and does not repair",
		async (_name, sql, id) => {
			await using value = await fixture();
			await commit(value.handle, entry(0, null), entry(1, 0));
			const sibling = await value.repository.create({ id: siblingId });
			value.db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
			value.db.prepare(sql).run(...(id === undefined ? [sessionId] : [sessionId, id]));
			value.db.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
			await expectPersistedCorruption(value.handle.scanBranch({ start: ids[1]! }));
			await expect(value.handle.scanBranch({ start: ids[1]! })).rejects.toMatchObject({ code: "closed" });
			await sibling.commit({ writes: [{ kind: "register", op: "set", namespace: "n", key: "k", value: 1 }] });
			expect((await sibling.getRegister("n", "k"))?.value).toBe(1);
			await sibling.close();
		},
	);

	it.each(["base", "cycle", "junction"] as const)(
		"marks malformed %s chains as persisted corruption",
		async (kind) => {
			await using value = await fixture();
			await commit(value.handle, entry(0, null), entry(1, 0, "compaction"), entry(2, 1), entry(3, 2));
			await commit(value.handle, entry(4, 2));
			const branch = `segment:${ids[4]}`;
			value.db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
			if (kind === "base")
				value.db
					.prepare("UPDATE branch_meta SET base_seq = NULL WHERE session_id = ? AND branch_id = ?")
					.run(sessionId, branch);
			else if (kind === "cycle")
				value.db
					.prepare(
						"UPDATE branch_meta SET base_branch_id = ?, base_seq = 2 WHERE session_id = ? AND branch_id = ?",
					)
					.run(branch, sessionId, branch);
			else
				value.db
					.prepare("DELETE FROM branch_entries WHERE session_id = ? AND branch_id = ? AND entry_seq = 2")
					.run(sessionId, `segment:${ids[0]}`);
			value.db.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
			await expectPersistedCorruption(value.handle.scanBranch({ start: ids[4]! }));
			await expect(value.handle.getStats()).rejects.toMatchObject({ code: "closed" });
		},
	);

	it("rejects injected missing, duplicate, foreign, and mismatched payload rows as persisted corruption", async () => {
		for (const kind of ["missing", "duplicate", "foreign", "mismatch"] as const) {
			await using value = await fixture();
			await commit(value.handle, entry(0, null), entry(1, 0));
			const original = value.db.prepare.bind(value.db);
			value.db.prepare = ((sql: string) => {
				const statement = original(sql);
				if (sql !== READ_BRANCH_PAYLOAD_SQL) return statement;
				return {
					run: (...params) => statement.run(...params),
					get: <TRow extends object>(...params: unknown[]) => statement.get<TRow>(...params),
					all: <TRow extends object>(...params: unknown[]) => {
						const rows = statement.all<Record<string, unknown>>(...params);
						if (kind === "missing") rows.pop();
						else if (kind === "duplicate") rows.push({ ...rows[0] });
						else if (kind === "foreign") rows[0] = { ...rows[0], entry_id: ids[31] };
						else rows[0] = { ...rows[0], entry_seq: 99 };
						return rows as TRow[];
					},
				};
			}) as SqliteDatabase["prepare"];
			await expectPersistedCorruption(value.handle.scanBranch({ start: ids[1]! }));
		}
	});

	it.each([
		["bad start", { start: "bad" }],
		["bad stop", { start: ids[0], stopAtId: "bad" }],
		["bad limit", { start: ids[0], limit: 0 }],
		["bad cursor", { start: ids[0], cursor: { seq: -1 } }],
		["bad custom filter", { start: ids[0], customType: "x" }],
		["bad order", { start: ids[0], order: "sideways" }],
		["unknown field", { start: ids[0], extra: true }],
		["primitive", 1],
		["non-cloneable", { start: ids[0], extra: () => undefined }],
	] as const)("returns reusable invalid_query for %s", async (_name, query) => {
		await using value = await fixture();
		await commit(value.handle, entry(0, null));
		await expect(value.handle.scanBranch(query as never)).rejects.toMatchObject({ code: "invalid_query" });
		expect((await value.handle.scanBranch({ start: ids[0]! })).map(({ id }) => id)).toEqual([ids[0]]);
	});

	it("drains an admitted branch read before close and rejects later admission", async () => {
		await using value = await fixture();
		await commit(value.handle, entry(0, null));
		const trace: string[] = [];
		const read = value.handle.scanBranch({ start: ids[0]! }).then(() => trace.push("read"));
		const close = value.handle.close().then(() => trace.push("close"));
		await expect(value.handle.scanBranch({ start: ids[0]! })).rejects.toMatchObject({ code: "closed" });
		await Promise.all([read, close]);
		expect(trace).toEqual(["read", "close"]);
	});

	it.each(["payload", "empty", "structure"] as const)(
		"rejects rather than returning partial data when deletion follows %s closure",
		async (kind) => {
			const directory = await mkdtemp(join(tmpdir(), "pi-branch-race-"));
			const path = join(directory, "sessions.sqlite");
			let now = 100;
			let dbA: SqliteDatabase | undefined;
			let dbB: SqliteDatabase | undefined;
			const factory = (capture: (db: SqliteDatabase) => void): SqliteDatabaseFactory => ({
				async open(databasePath) {
					const db = await createNodeSqliteFactory().open(databasePath);
					capture(db);
					return db;
				},
			});
			const repositoryA = new SqliteStorageRepository({
				factory: factory((db) => {
					dbA = db;
				}),
				path,
				now: () => now,
				ownerId: () => "a",
				leaseTtlMs: 10,
				heartbeatMs: 5,
				timers: new DormantTimers(),
			});
			const repositoryB = new SqliteStorageRepository({
				factory: factory((db) => {
					dbB = db;
				}),
				path,
				now: () => now,
				ownerId: () => "b",
				leaseTtlMs: 10,
				heartbeatMs: 5,
				timers: new DormantTimers(),
			});
			let handle: SqliteStorageHandle | undefined;
			try {
				handle = await repositoryA.create({ id: sessionId });
				await repositoryB.list();
				await commit(handle, entry(0, null), entry(1, 0));
				if (!dbA || !dbB) throw new Error("Expected two connections");
				const original = dbA.prepare.bind(dbA);
				let deleted = false;
				dbA.prepare = ((sql: string): SqliteStatement => {
					const statement = original(sql);
					if (sql !== MATERIALIZE_SEGMENT_SQL) return statement;
					return {
						run: (...params) => statement.run(...params),
						get: <TRow extends object>(...params: unknown[]) => statement.get<TRow>(...params),
						all: <TRow extends object>(...params: unknown[]) => {
							const rows = statement.all<TRow>(...params);
							if (!deleted) {
								deleted = true;
								now = 110;
								expect(deleteSqliteSession(dbB!, handle!.metadata, "b", () => now, 10)).toBe(true);
							}
							return rows;
						},
					};
				}) as SqliteDatabase["prepare"];
				const operation =
					kind === "structure"
						? handle.scanBranchStructure({ start: ids[1]! })
						: handle.scanBranch({ start: ids[1]!, ...(kind === "empty" ? { type: "compaction" as const } : {}) });
				await expectPersistedCorruption(operation);
				await expect(handle.getStats()).rejects.toMatchObject({ code: "closed" });
			} finally {
				await handle?.close().catch(() => undefined);
				await repositoryA.close().catch(() => undefined);
				await repositoryB.close().catch(() => undefined);
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("keeps branch reads bounded, non-transactional, non-repairing, and private", () => {
		const root = dirname(fileURLToPath(import.meta.url));
		const reader = readFileSync(join(root, "../src/sqlite/storage/branch-reader.ts"), "utf8");
		const chain = readFileSync(join(root, "../src/sqlite/storage/branch-chain.ts"), "utf8");
		const combined = `${reader}\n${chain}`;
		expect(combined).not.toMatch(
			/\.transaction\s*\(|\bBEGIN\b|\bCOMMIT\b|parentId\).*while|SELECT \* FROM entries|repair/i,
		);
		expect(combined).not.toMatch(/callback|execute\s*\(sql/i);
		for (const barrel of ["../src/index.ts", "../src/sqlite/index.ts"])
			expect(readFileSync(join(root, barrel), "utf8")).not.toMatch(
				/branch-reader|branch-chain|READ_BRANCH_PAYLOAD_SQL|MATERIALIZE_SEGMENT_SQL|SqliteStorageHandle/,
			);
	});
});
