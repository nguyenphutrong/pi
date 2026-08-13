import type { EntryType, Transaction } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, type SqliteDatabase, type SqliteStatement } from "../src/index.ts";
import { initializeSqliteSchema } from "../src/sqlite/schema.ts";
import type { TimerFactory, TimerHandle } from "../src/sqlite/storage/lifecycle.ts";
import { SqliteStorageRepository } from "../src/sqlite/storage/repository.ts";
import { isPersistedSqliteCorruption } from "../src/sqlite/storage/transaction-engine.ts";

const sessionId = "018f3000-0000-7000-8000-000000000000";
const siblingId = "018f3000-ffff-7000-8000-000000000000";
const parentId = "018f3000-eeee-7000-8000-000000000000";
const ids = Array.from(
	{ length: 14 },
	(_, index) => `018f3000-${String(index + 1).padStart(4, "0")}-7000-8000-${String(index + 1).padStart(12, "0")}`,
);

const timers: TimerFactory = {
	schedule: () => ({}),
	cancel: (_handle: TimerHandle) => undefined,
};

function entry(index: number, parent: number | null, type: EntryType = "message"): Transaction["writes"][number] {
	return {
		kind: "entry",
		entry: { id: ids[index]!, parentId: parent === null ? null : ids[parent]!, type, payload: { index } },
	};
}

function interceptDatabase(
	db: SqliteDatabase,
	hooks: {
		prepare?: (sql: string, statement: SqliteStatement) => SqliteStatement;
		transaction?: <T>(run: () => T) => T;
	} = {},
): SqliteDatabase {
	return {
		exec: (sql) => db.exec(sql),
		prepare: (sql) => hooks.prepare?.(sql, db.prepare(sql)) ?? db.prepare(sql),
		transaction: <T>(run: () => T) => (hooks.transaction ? hooks.transaction(run) : db.transaction(run)),
		close: () => db.close(),
	};
}

function projection(db: SqliteDatabase, id = sessionId) {
	return {
		meta: db.prepare("SELECT * FROM branch_meta WHERE session_id = ? ORDER BY branch_id").all(id),
		entries: db
			.prepare("SELECT * FROM branch_entries WHERE session_id = ? ORDER BY branch_id, entry_seq, entry_id")
			.all(id),
	};
}

function lease(db: SqliteDatabase) {
	return db.prepare("SELECT * FROM writer_leases WHERE session_id = ?").all(sessionId);
}

async function fixture(
	options: { now?: () => number; ownerId?: () => string; wrap?: (db: SqliteDatabase) => SqliteDatabase } = {},
) {
	const inner = await createNodeSqliteFactory().open(":memory:");
	const db = options.wrap?.(inner) ?? inner;
	let owner = 0;
	const repository = new SqliteStorageRepository({
		factory: { open: async () => db },
		path: "repair",
		now: options.now ?? (() => 100),
		ownerId: options.ownerId ?? (() => `owner-${owner++}`),
		timers,
	});
	await repository.list();
	return { inner, db, repository };
}

async function seeded(value: Awaited<ReturnType<typeof fixture>>, writes = [entry(0, null), entry(1, 0)]) {
	const handle = await value.repository.create({ id: sessionId });
	await handle.commit({ writes });
	const metadata = handle.metadata;
	await handle.close();
	return metadata;
}

function expireLease(db: SqliteDatabase) {
	db.prepare(
		"INSERT INTO writer_leases (session_id, owner_id, fence, expires_at_ms) VALUES (?, 'old-owner', 7, 99)",
	).run(sessionId);
}

function disableStructuralChecks(db: SqliteDatabase, run: () => void): void {
	db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
	try {
		run();
	} finally {
		db.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON");
	}
}

async function expectCorruptionAndExactRollback(
	value: Awaited<ReturnType<typeof fixture>>,
	metadata: Awaited<ReturnType<typeof seeded>>,
): Promise<void> {
	const oldProjection = projection(value.inner);
	const oldLease = lease(value.inner);
	let error: unknown;
	try {
		await value.repository.repairBranchProjection(metadata);
	} catch (caught) {
		error = caught;
	}
	expect(error).toMatchObject({ code: "corruption" });
	expect(isPersistedSqliteCorruption(error)).toBe(true);
	expect(projection(value.inner)).toEqual(oldProjection);
	expect(lease(value.inner)).toEqual(oldLease);
}

describe("SQLite explicit branch repair", () => {
	it("fully replaces a conflicting projection, preserves canonical and sibling state, and remains appendable", async () => {
		const value = await fixture();
		try {
			const metadata = await seeded(value, [
				entry(0, null),
				entry(1, 0, "compaction"),
				entry(2, 1),
				entry(3, 2),
				entry(4, null),
				entry(5, 4),
				entry(6, 2),
				entry(7, 6),
			]);
			const sibling = await value.repository.create({ id: siblingId });
			await sibling.commit({ writes: [entry(10, null)] });
			const siblingMetadata = sibling.metadata;
			await sibling.close();
			const canonicalHandle = await value.repository.open(metadata);
			await canonicalHandle.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "test", key: "state", value: { retained: true } },
					{
						kind: "usage",
						row: {
							id: ids[9]!,
							adjustment: false,
							usage: {
								input: 1,
								output: 2,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 3,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						},
					},
				],
			});
			await canonicalHandle.close();
			const canonicalTables = ["entries", "registers", "usage_ledger", "session_stats", "session_sequences"];
			const canonical = canonicalTables.map((table) =>
				value.inner.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY 1, 2`).all(sessionId),
			);
			const siblingProjection = projection(value.inner, siblingId);
			disableStructuralChecks(value.inner, () => {
				value.inner.prepare("UPDATE branch_meta SET tip_seq = 1 WHERE session_id = ?").run(sessionId);
				value.inner
					.prepare("DELETE FROM branch_entries WHERE session_id = ? AND entry_id = ?")
					.run(sessionId, ids[2]);
			});

			await value.repository.repairBranchProjection(metadata);
			const repaired = projection(value.inner);
			expect(repaired).toEqual({
				meta: [
					{
						session_id: sessionId,
						branch_id: `segment:${ids[0]}`,
						tip_entry_id: ids[3],
						tip_seq: 4,
						base_branch_id: null,
						base_seq: null,
					},
					{
						session_id: sessionId,
						branch_id: `segment:${ids[4]}`,
						tip_entry_id: ids[5],
						tip_seq: 6,
						base_branch_id: null,
						base_seq: null,
					},
					{
						session_id: sessionId,
						branch_id: `segment:${ids[6]}`,
						tip_entry_id: ids[7],
						tip_seq: 8,
						base_branch_id: `segment:${ids[0]}`,
						base_seq: 2,
					},
				],
				entries: [
					...([0, 1, 2, 3] as const).map((index) => ({
						session_id: sessionId,
						branch_id: `segment:${ids[0]}`,
						entry_seq: index + 1,
						entry_id: ids[index],
						entry_type: index === 1 ? "compaction" : "message",
					})),
					...([4, 5] as const).map((index) => ({
						session_id: sessionId,
						branch_id: `segment:${ids[4]}`,
						entry_seq: index + 1,
						entry_id: ids[index],
						entry_type: "message",
					})),
					...([2, 6, 7] as const).map((index) => ({
						session_id: sessionId,
						branch_id: `segment:${ids[6]}`,
						entry_seq: index + 1,
						entry_id: ids[index],
						entry_type: "message",
					})),
				],
			});
			await value.repository.repairBranchProjection(metadata);
			expect(projection(value.inner)).toEqual(repaired);
			canonicalTables.forEach((table, index) => {
				expect(
					value.inner.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY 1, 2`).all(sessionId),
				).toEqual(canonical[index]);
			});
			expect(projection(value.inner, siblingId)).toEqual(siblingProjection);
			expect(lease(value.inner)).toEqual([]);

			const reopened = await value.repository.open(metadata);
			expect((await reopened.scanBranch({ start: ids[7]!, order: "oldestFirst" })).map(({ id }) => id)).toEqual([
				ids[0],
				ids[1],
				ids[2],
				ids[6],
				ids[7],
			]);
			expect((await reopened.scanEntries({ fromSeq: 2, toSeq: 8 })).map(({ seq }) => seq)).toEqual([
				2, 3, 4, 5, 6, 7, 8,
			]);
			await expect(reopened.commit({ writes: [entry(8, 7)] })).resolves.toMatchObject({ seqs: [11] });
			await reopened.close();
			const siblingReopened = await value.repository.open(siblingMetadata);
			await siblingReopened.close();
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it("repairs an empty canonical entry inventory to an empty projection", async () => {
		const value = await fixture();
		try {
			const handle = await value.repository.create({ id: sessionId });
			const metadata = handle.metadata;
			await handle.close();
			await expect(value.repository.repairBranchProjection(metadata)).resolves.toBeUndefined();
			expect(projection(value.inner)).toEqual({ meta: [], entries: [] });
			expect(lease(value.inner)).toEqual([]);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it("accepts canonical sequence gaps and multiple roots", async () => {
		const value = await fixture();
		try {
			const metadata = await seeded(value, [entry(0, null), entry(1, 0), entry(2, null)]);
			disableStructuralChecks(value.inner, () => {
				value.inner.prepare("UPDATE entries SET seq = 5 WHERE session_id = ? AND id = ?").run(sessionId, ids[1]);
				value.inner.prepare("UPDATE entries SET seq = 9 WHERE session_id = ? AND id = ?").run(sessionId, ids[2]);
				value.inner.prepare("UPDATE session_sequences SET next_seq = 10 WHERE session_id = ?").run(sessionId);
			});
			await expect(value.repository.repairBranchProjection(metadata)).resolves.toBeUndefined();
			expect(projection(value.inner)).toEqual({
				meta: [
					{
						session_id: sessionId,
						branch_id: `segment:${ids[0]}`,
						tip_entry_id: ids[1],
						tip_seq: 5,
						base_branch_id: null,
						base_seq: null,
					},
					{
						session_id: sessionId,
						branch_id: `segment:${ids[2]}`,
						tip_entry_id: ids[2],
						tip_seq: 9,
						base_branch_id: null,
						base_seq: null,
					},
				],
				entries: [
					{
						session_id: sessionId,
						branch_id: `segment:${ids[0]}`,
						entry_seq: 1,
						entry_id: ids[0],
						entry_type: "message",
					},
					{
						session_id: sessionId,
						branch_id: `segment:${ids[0]}`,
						entry_seq: 5,
						entry_id: ids[1],
						entry_type: "message",
					},
					{
						session_id: sessionId,
						branch_id: `segment:${ids[2]}`,
						entry_seq: 9,
						entry_id: ids[2],
						entry_type: "message",
					},
				],
			});
			expect(lease(value.inner)).toEqual([]);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it.each([
		["sequence at next_seq", "UPDATE entries SET seq = 4 WHERE session_id = ? AND id = ?", undefined],
		["missing parent", "UPDATE entries SET parent_id = ? WHERE session_id = ? AND id = ?", ids[9]],
		["forward parent", "UPDATE entries SET parent_id = ? WHERE session_id = ? AND id = ?", ids[2]],
		["malformed JSON payload", "UPDATE entries SET payload = 'bad' WHERE session_id = ? AND id = ?", undefined],
		["missing full payload", "UPDATE entries SET payload = NULL WHERE session_id = ? AND id = ?", undefined],
		[
			"malformed custom shape",
			"UPDATE entries SET type = 'custom', custom_type = NULL WHERE session_id = ? AND id = ?",
			undefined,
		],
	] as const)("rejects persisted canonical corruption: %s", async (_label, sql, parent) => {
		const value = await fixture();
		try {
			const metadata = await seeded(value, [entry(0, null), entry(1, 0), entry(2, 1)]);
			expireLease(value.inner);
			disableStructuralChecks(value.inner, () => {
				value.inner.prepare(sql).run(...(parent ? [parent, sessionId, ids[1]] : [sessionId, ids[1]]));
			});
			await expectCorruptionAndExactRollback(value, metadata);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it.each([
		["missing", "DELETE FROM session_sequences WHERE session_id = ?"],
		["zero", "UPDATE session_sequences SET next_seq = 0 WHERE session_id = ?"],
		["malformed", "UPDATE session_sequences SET next_seq = 'bad' WHERE session_id = ?"],
		["unsafe", `UPDATE session_sequences SET next_seq = ${Number.MAX_SAFE_INTEGER + 1} WHERE session_id = ?`],
		["at-or-below maximum entry", "UPDATE session_sequences SET next_seq = 2 WHERE session_id = ?"],
	] as const)("rejects persisted next_seq corruption: %s", async (_label, sql) => {
		const value = await fixture();
		try {
			const metadata = await seeded(value);
			expireLease(value.inner);
			disableStructuralChecks(value.inner, () => value.inner.prepare(sql).run(sessionId));
			await expectCorruptionAndExactRollback(value, metadata);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it.each([
		["timestamp", "timestamp = -1"],
		["id", "id = 'bad'"],
		["sequence scalar", "seq = 'bad'"],
		["parent scalar", "parent_id = 7"],
		["type", "type = 'bad'"],
		["custom_type", "custom_type = 'unexpected'"],
	] as const)("rejects a malformed canonical entry scalar: %s", async (_label, assignment) => {
		const value = await fixture();
		try {
			const metadata = await seeded(value);
			expireLease(value.inner);
			disableStructuralChecks(value.inner, () =>
				value.inner
					.prepare(`UPDATE entries SET ${assignment} WHERE session_id = ? AND id = ?`)
					.run(sessionId, ids[1]),
			);
			await expectCorruptionAndExactRollback(value, metadata);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it.each([
		["created timestamp", "created_at = -1"],
		["catalog metadata", "metadata = 'not-json'"],
		["storage version", "storage_version = 2"],
	] as const)("rolls back exactly for persisted catalog corruption: %s", async (_label, assignment) => {
		const value = await fixture();
		try {
			const metadata = await seeded(value);
			expireLease(value.inner);
			disableStructuralChecks(value.inner, () =>
				value.inner.prepare(`UPDATE sessions SET ${assignment} WHERE session_id = ?`).run(sessionId),
			);
			const old = { projection: projection(value.inner), lease: lease(value.inner) };
			await expect(value.repository.repairBranchProjection(metadata)).rejects.toMatchObject({
				code: "metadata_mismatch",
			});
			expect({ projection: projection(value.inner), lease: lease(value.inner) }).toEqual(old);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it("rejects a duplicate/non-increasing canonical sequence and rolls back exactly", async () => {
		let canonicalReads = 0;
		const value = await fixture({
			wrap: (inner) =>
				interceptDatabase(inner, {
					prepare: (sql, statement) =>
						sql.startsWith("SELECT id, parent_id, seq") && sql.includes("ORDER BY seq")
							? {
									...statement,
									all: <TRow extends object>(...params: unknown[]): TRow[] => {
										const result = statement.all<TRow>(...params);
										if (++canonicalReads === 1 && result[1]) {
											const first = result[0] as TRow & { seq: unknown };
											result[1] = { ...result[1], seq: first.seq };
										}
										return result;
									},
								}
							: statement,
				}),
		});
		try {
			const metadata = await seeded(value);
			expireLease(value.inner);
			await expectCorruptionAndExactRollback(value, metadata);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it.each([
		["after deletes", "branch_meta", undefined],
		["on the first membership insert", "branch_entries", undefined],
		["mid replay", "branch_entries", ids[2]],
	] as const)("atomically rolls replacement back on a fault %s", async (_label, table, target) => {
		const value = await fixture();
		try {
			const metadata = await seeded(value, [entry(0, null), entry(1, 0), entry(2, 1), entry(3, 2)]);
			expireLease(value.inner);
			const oldProjection = projection(value.inner);
			const oldLease = lease(value.inner);
			value.inner.exec(
				`CREATE TEMP TRIGGER fail_repair BEFORE INSERT ON ${table}${target ? ` WHEN NEW.entry_id = '${target}'` : ""} BEGIN SELECT RAISE(ABORT, 'injected repair fault'); END`,
			);
			await expect(value.repository.repairBranchProjection(metadata)).rejects.toThrow("injected repair fault");
			expect(projection(value.inner)).toEqual(oldProjection);
			expect(lease(value.inner)).toEqual(oldLease);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it("rolls replacement back when the exact final repair lease delete fails", async () => {
		let failDelete = false;
		const value = await fixture({
			wrap: (inner) =>
				interceptDatabase(inner, {
					prepare: (sql, statement) =>
						failDelete && sql === "DELETE FROM writer_leases WHERE session_id = ? AND owner_id = ? AND fence = ?"
							? { ...statement, run: () => ({ changes: 0 }) }
							: statement,
				}),
		});
		try {
			const metadata = await seeded(value);
			expireLease(value.inner);
			const old = { projection: projection(value.inner), lease: lease(value.inner) };
			failDelete = true;
			await expect(value.repository.repairBranchProjection(metadata)).rejects.toMatchObject({ code: "missing" });
			expect({ projection: projection(value.inner), lease: lease(value.inner) }).toEqual(old);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it.each(["missing", "extra", "duplicate", "foreign"] as const)(
		"rolls replacement back when post-rebuild inventory has a %s membership",
		async (anomaly) => {
			let corruptInventory = false;
			const value = await fixture({
				wrap: (inner) =>
					interceptDatabase(inner, {
						prepare: (sql, statement) =>
							sql.startsWith("SELECT session_id, branch_id, entry_seq, entry_id, entry_type FROM branch_entries")
								? {
										...statement,
										all: <TRow extends object>(...params: unknown[]): TRow[] => {
											const rows = statement.all<TRow>(...params);
											if (!corruptInventory) return rows;
											if (anomaly === "missing") return rows.slice(1);
											const first = rows[0] as TRow & { session_id: string; entry_id: string };
											if (anomaly === "duplicate") return [...rows, { ...first }];
											if (anomaly === "foreign") return [...rows, { ...first, session_id: siblingId }];
											return [...rows, { ...first, entry_id: ids[13]! }];
										},
									}
								: statement,
					}),
			});
			try {
				const metadata = await seeded(value);
				expireLease(value.inner);
				const old = { projection: projection(value.inner), lease: lease(value.inner) };
				corruptInventory = true;
				await expect(value.repository.repairBranchProjection(metadata)).rejects.toMatchObject({
					code: "corruption",
				});
				expect({ projection: projection(value.inner), lease: lease(value.inner) }).toEqual(old);
			} finally {
				await value.repository.close().catch(() => undefined);
			}
		},
	);

	it("rejects an unexpired external lease without change", async () => {
		const value = await fixture();
		try {
			const metadata = await seeded(value);
			value.inner.prepare("INSERT INTO writer_leases VALUES (?, 'external', 4, 101)").run(sessionId);
			const old = { projection: projection(value.inner), lease: lease(value.inner) };
			await expect(value.repository.repairBranchProjection(metadata)).rejects.toMatchObject({ code: "busy" });
			expect({ projection: projection(value.inner), lease: lease(value.inner) }).toEqual(old);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it("takes over a lease at exact expiry and removes it in the repair transaction", async () => {
		const value = await fixture();
		try {
			const metadata = await seeded(value);
			value.inner.prepare("INSERT INTO writer_leases VALUES (?, 'external', 4, 100)").run(sessionId);
			await expect(value.repository.repairBranchProjection(metadata)).resolves.toBeUndefined();
			expect(lease(value.inner)).toEqual([]);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it("rejects an expired MAX_SAFE_INTEGER fence without change", async () => {
		const value = await fixture();
		try {
			const metadata = await seeded(value);
			value.inner
				.prepare("INSERT INTO writer_leases VALUES (?, 'external', ?, 99)")
				.run(sessionId, Number.MAX_SAFE_INTEGER);
			const old = { projection: projection(value.inner), lease: lease(value.inner) };
			await expect(value.repository.repairBranchProjection(metadata)).rejects.toMatchObject({
				code: "fence_exhausted",
			});
			expect({ projection: projection(value.inner), lease: lease(value.inner) }).toEqual(old);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it("uses exactly one standard database transaction and no release transaction per repair", async () => {
		let transactions = 0;
		let initialized = false;
		const value = await fixture({
			wrap: (inner) =>
				interceptDatabase(inner, {
					transaction: (run) => {
						if (initialized) transactions++;
						return inner.transaction(run);
					},
				}),
		});
		try {
			initialized = true;
			const metadata = await seeded(value);
			transactions = 0;
			await value.repository.repairBranchProjection(metadata);
			expect(transactions).toBe(1);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it("rejects repair, open, and delete while an active handle owns the session", async () => {
		const value = await fixture();
		try {
			const handle = await value.repository.create({ id: sessionId });
			for (const operation of [
				value.repository.repairBranchProjection(handle.metadata),
				value.repository.open(handle.metadata),
				value.repository.delete(handle.metadata),
			])
				await expect(operation).rejects.toMatchObject({ code: "local_ownership" });
			await handle.close();
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it("cancels a queued repair behind initialization while keeping its reservation visible", async () => {
		const inner = await createNodeSqliteFactory().open(":memory:");
		initializeSqliteSchema(inner);
		inner.prepare("INSERT INTO sessions VALUES (?, 100, NULL, 1, NULL)").run(sessionId);
		inner.prepare("INSERT INTO session_sequences VALUES (?, 1)").run(sessionId);
		inner.prepare("INSERT INTO session_stats VALUES (?, 0, ?)").run(
			sessionId,
			JSON.stringify({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			}),
		);
		const metadata = { id: sessionId, createdAt: 100, storageVersion: 1 } as const;
		const before = projection(inner);
		let releaseInitialization!: () => void;
		const initializationGate = new Promise<void>((resolve) => {
			releaseInitialization = resolve;
		});
		let transactions = 0;
		const intercepted = interceptDatabase(inner, {
			transaction: (run) => {
				transactions++;
				return inner.transaction(run);
			},
		});
		const db = { ...intercepted, close: () => undefined };
		const repository = new SqliteStorageRepository({
			factory: {
				open: async () => {
					await initializationGate;
					return db;
				},
			},
			path: "repair",
			now: () => 100,
			timers,
		});
		try {
			const repair = repository.repairBranchProjection(metadata);
			for (const operation of [
				repository.repairBranchProjection(metadata),
				repository.open(metadata),
				repository.delete(metadata),
			])
				await expect(operation).rejects.toMatchObject({ code: "local_ownership" });
			const close = repository.close();
			releaseInitialization();
			await expect(repair).rejects.toMatchObject({ code: "closed" });
			await close;
			expect(transactions).toBe(0);
			expect(projection(inner)).toEqual(before);
			await expect(repository.repairBranchProjection(metadata)).rejects.toMatchObject({ code: "closed" });
		} finally {
			releaseInitialization();
			await repository.close().catch(() => undefined);
			inner.close();
		}
	});

	it.each([
		["missing timestamp", { id: sessionId, storageVersion: 1 }],
		["malformed input", null],
		["version", { id: sessionId, createdAt: 100, storageVersion: 2 }],
	] as const)("validates metadata before starting a transaction: %s", async (_label, metadata) => {
		let transactions = 0;
		const value = await fixture({
			wrap: (inner) =>
				interceptDatabase(inner, {
					transaction: (run) => {
						transactions++;
						return inner.transaction(run);
					},
				}),
		});
		try {
			transactions = 0;
			await expect(value.repository.repairBranchProjection(metadata as never)).rejects.toBeDefined();
			expect(transactions).toBe(0);
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});

	it.each([
		["createdAt", { createdAt: 101 }],
		["optional parent presence", { parentSessionId: parentId }],
	] as const)("rejects exact catalog metadata mismatch: %s", async (_label, change) => {
		const value = await fixture();
		try {
			const metadata = await seeded(value);
			await expect(value.repository.repairBranchProjection({ ...metadata, ...change })).rejects.toMatchObject({
				code: "metadata_mismatch",
			});
		} finally {
			await value.repository.close().catch(() => undefined);
		}
	});
});
