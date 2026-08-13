import type { EntryType, Transaction } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, initializeSqliteSchema, type SqliteDatabase } from "../src/index.ts";
import {
	MATERIALIZE_SEGMENT_SQL,
	PARENT_CANDIDATES_SQL,
	SEGMENT_IDENTITY_SQL,
} from "../src/sqlite/storage/branch-chain.ts";
import { COPY_MEMBERSHIP_SQL, EXACT_TIP_SQL } from "../src/sqlite/storage/branch-projection.ts";
import { prepareTransaction } from "../src/sqlite/storage/prepared-transaction.ts";
import {
	commitSqliteTransaction,
	createSqliteSession,
	isPersistedSqliteCorruption,
} from "../src/sqlite/storage/transaction-engine.ts";

const session = "018f1000-0000-7000-8000-000000000000";
const ids = Array.from(
	{ length: 16 },
	(_, index) => `018f1000-${String(index + 1).padStart(4, "0")}-7000-8000-${String(index + 1).padStart(12, "0")}`,
);
const lease = { sessionId: session, ownerId: "owner", fence: 1 } as const;

function write(id: string, parentId: string | null, type: EntryType = "message") {
	return { kind: "entry" as const, entry: { id, parentId, type, payload: { id } } };
}

function tx(...writes: ReturnType<typeof write>[]): Transaction {
	return { writes };
}

async function setup(): Promise<SqliteDatabase> {
	const db = await createNodeSqliteFactory().open(":memory:");
	initializeSqliteSchema(db);
	createSqliteSession(db, { id: session, storageVersion: 1 }, lease.ownerId, () => 10, 100);
	return db;
}

function commit(db: SqliteDatabase, transaction: Transaction, now = 20) {
	return commitSqliteTransaction(db, lease, prepareTransaction(transaction), () => now, 100);
}

function meta(db: SqliteDatabase) {
	return db
		.prepare(
			"SELECT branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq FROM branch_meta WHERE session_id = ? ORDER BY branch_id",
		)
		.all(session);
}

function members(db: SqliteDatabase) {
	return db
		.prepare(
			"SELECT branch_id, entry_seq, entry_id, entry_type FROM branch_entries WHERE session_id = ? ORDER BY branch_id, entry_seq, entry_id",
		)
		.all(session);
}

function expectCorruption(operation: () => unknown): unknown {
	let caught: unknown;
	try {
		operation();
	} catch (error) {
		caught = error;
	}
	expect(caught).toMatchObject({ code: "corruption" });
	expect(isPersistedSqliteCorruption(caught)).toBe(true);
	return caught;
}

describe("SQLite segmented branch projection", () => {
	it("uses the required covering indexes for each projection query plan", async () => {
		const db = await setup();
		try {
			commit(db, tx(write(ids[0]!, null), write(ids[1]!, ids[0]!), write(ids[2]!, ids[1]!)));
			const plans = {
				parent: db.prepare(`EXPLAIN QUERY PLAN ${PARENT_CANDIDATES_SQL}`).all(session, ids[1]),
				tip: db.prepare(`EXPLAIN QUERY PLAN ${EXACT_TIP_SQL}`).all(session, ids[2]),
				identity: db
					.prepare(`EXPLAIN QUERY PLAN ${SEGMENT_IDENTITY_SQL}`)
					.all(session, `segment:${ids[0]}`, ids[0]),
				materialize: db.prepare(`EXPLAIN QUERY PLAN ${MATERIALIZE_SEGMENT_SQL}`).all(session, `segment:${ids[0]}`),
				copy: db.prepare(`EXPLAIN QUERY PLAN ${COPY_MEMBERSHIP_SQL}`).all(session, `segment:${ids[0]}`, 0, 2),
			};
			const details = Object.fromEntries(
				Object.entries(plans).map(([name, rows]) => [name, rows.map((row) => (row as { detail: string }).detail)]),
			);
			expect(details.parent).toEqual([expect.stringContaining("USING COVERING INDEX ix_be_entry")]);
			expect(details.tip).toEqual([expect.stringContaining("USING INDEX ix_bm_tip")]);
			expect(details.identity).toEqual([
				expect.stringMatching(
					/USING (?:COVERING INDEX )?PRIMARY KEY \(session_id=\? AND branch_id=\? AND entry_id=\?\)/,
				),
			]);
			expect(details.materialize).toEqual([
				expect.stringContaining("USING COVERING INDEX ix_be_seq"),
				expect.stringMatching(/SEARCH e USING PRIMARY KEY \(session_id=\? AND id=\?\)/),
			]);
			expect(details.copy).toEqual([expect.stringContaining("USING COVERING INDEX ix_be_seq")]);
			for (const [name, detail] of Object.entries(details)) {
				expect(detail.join("\n"), name).not.toMatch(/SCAN entries|USE TEMP B-TREE/);
			}
		} finally {
			db.close();
		}
	});

	it("rejects a malformed segment identity on the exact-tip path and rolls back all state", async () => {
		const db = await setup();
		try {
			commit(db, tx(write(ids[0]!, null)));
			db.exec("PRAGMA foreign_keys=OFF");
			db.prepare("UPDATE branch_meta SET branch_id = 'bad' WHERE session_id = ?").run(session);
			db.prepare("UPDATE branch_entries SET branch_id = 'bad' WHERE session_id = ?").run(session);
			db.exec("PRAGMA foreign_keys=ON");
			expect(db.prepare(EXACT_TIP_SQL).get(session, ids[0])).toEqual({ branch_id: "bad", tip_seq: 1 });
			const tables = [
				"entries",
				"branch_meta",
				"branch_entries",
				"session_stats",
				"session_sequences",
				"writer_leases",
			] as const;
			const before = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
			expectCorruption(() => commit(db, tx(write(ids[1]!, ids[0]!)), 30));
			for (const [table, rows] of Object.entries(before))
				expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(rows);
		} finally {
			db.close();
		}
	});

	it("creates the exact root segment and extends its exact tip", async () => {
		const db = await setup();
		try {
			expect(commit(db, tx(write(ids[0]!, null), write(ids[1]!, ids[0]!)))).toMatchObject({ seqs: [1, 2] });
			expect(meta(db)).toEqual([
				{
					branch_id: `segment:${ids[0]}`,
					tip_entry_id: ids[1],
					tip_seq: 2,
					base_branch_id: null,
					base_seq: null,
				},
			]);
			expect(members(db)).toEqual([
				{ branch_id: `segment:${ids[0]}`, entry_seq: 1, entry_id: ids[0], entry_type: "message" },
				{ branch_id: `segment:${ids[0]}`, entry_seq: 2, entry_id: ids[1], entry_type: "message" },
			]);
		} finally {
			db.close();
		}
	});

	it("diverges without compaction by copying root through parent and leaves the stale branch valid", async () => {
		const db = await setup();
		try {
			commit(db, tx(write(ids[0]!, null), write(ids[1]!, ids[0]!), write(ids[2]!, ids[1]!)));
			commit(db, tx(write(ids[3]!, ids[1]!)));
			expect(meta(db)).toEqual([
				{ branch_id: `segment:${ids[0]}`, tip_entry_id: ids[2], tip_seq: 3, base_branch_id: null, base_seq: null },
				{ branch_id: `segment:${ids[3]}`, tip_entry_id: ids[3], tip_seq: 4, base_branch_id: null, base_seq: null },
			]);
			expect(members(db)).toEqual([
				{ branch_id: `segment:${ids[0]}`, entry_seq: 1, entry_id: ids[0], entry_type: "message" },
				{ branch_id: `segment:${ids[0]}`, entry_seq: 2, entry_id: ids[1], entry_type: "message" },
				{ branch_id: `segment:${ids[0]}`, entry_seq: 3, entry_id: ids[2], entry_type: "message" },
				{ branch_id: `segment:${ids[3]}`, entry_seq: 1, entry_id: ids[0], entry_type: "message" },
				{ branch_id: `segment:${ids[3]}`, entry_seq: 2, entry_id: ids[1], entry_type: "message" },
				{ branch_id: `segment:${ids[3]}`, entry_seq: 4, entry_id: ids[3], entry_type: "message" },
			]);
		} finally {
			db.close();
		}
	});

	it("bases divergence at the newest compaction owner and copies only (C,parent]", async () => {
		const db = await setup();
		try {
			commit(
				db,
				tx(
					write(ids[0]!, null),
					write(ids[1]!, ids[0]!, "compaction"),
					write(ids[2]!, ids[1]!),
					write(ids[3]!, ids[2]!),
				),
			);
			commit(db, tx(write(ids[4]!, ids[2]!)));
			commit(db, tx(write(ids[5]!, ids[1]!)));
			expect(meta(db)).toEqual([
				{ branch_id: `segment:${ids[0]}`, tip_entry_id: ids[3], tip_seq: 4, base_branch_id: null, base_seq: null },
				{
					branch_id: `segment:${ids[4]}`,
					tip_entry_id: ids[4],
					tip_seq: 5,
					base_branch_id: `segment:${ids[0]}`,
					base_seq: 2,
				},
				{
					branch_id: `segment:${ids[5]}`,
					tip_entry_id: ids[5],
					tip_seq: 6,
					base_branch_id: `segment:${ids[0]}`,
					base_seq: 2,
				},
			]);
			expect(members(db).filter((row) => (row as { branch_id: string }).branch_id !== `segment:${ids[0]}`)).toEqual([
				{ branch_id: `segment:${ids[4]}`, entry_seq: 3, entry_id: ids[2], entry_type: "message" },
				{ branch_id: `segment:${ids[4]}`, entry_seq: 5, entry_id: ids[4], entry_type: "message" },
				{ branch_id: `segment:${ids[5]}`, entry_seq: 6, entry_id: ids[5], entry_type: "message" },
			]);
		} finally {
			db.close();
		}
	});

	it("finds a newest compaction in an older base, including the junction, without gaps or duplicates", async () => {
		const db = await setup();
		try {
			commit(
				db,
				tx(
					write(ids[0]!, null),
					write(ids[1]!, ids[0]!, "compaction"),
					write(ids[2]!, ids[1]!),
					write(ids[3]!, ids[2]!),
				),
			);
			commit(db, tx(write(ids[4]!, ids[2]!), write(ids[5]!, ids[4]!)));
			commit(db, tx(write(ids[6]!, ids[4]!)));
			expect(meta(db).find((row) => (row as { branch_id: string }).branch_id === `segment:${ids[6]}`)).toEqual({
				branch_id: `segment:${ids[6]}`,
				tip_entry_id: ids[6],
				tip_seq: 7,
				base_branch_id: `segment:${ids[0]}`,
				base_seq: 2,
			});
			expect(members(db).filter((row) => (row as { branch_id: string }).branch_id === `segment:${ids[6]}`)).toEqual([
				{ branch_id: `segment:${ids[6]}`, entry_seq: 3, entry_id: ids[2], entry_type: "message" },
				{ branch_id: `segment:${ids[6]}`, entry_seq: 5, entry_id: ids[4], entry_type: "message" },
				{ branch_id: `segment:${ids[6]}`, entry_seq: 7, entry_id: ids[6], entry_type: "message" },
			]);
		} finally {
			db.close();
		}
	});

	it("selects the agreeing physical candidate with the higher valid tip sequence", async () => {
		const db = await setup();
		try {
			commit(
				db,
				tx(
					write(ids[0]!, null),
					write(ids[1]!, ids[0]!, "compaction"),
					write(ids[2]!, ids[1]!),
					write(ids[3]!, ids[2]!),
					write(ids[4]!, ids[3]!),
				),
			);
			db.prepare("INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq) VALUES (?, ?, ?, 4)").run(
				session,
				`segment:${ids[3]}`,
				ids[3],
			);
			for (let index = 0; index <= 3; index++) {
				db.prepare(
					"INSERT INTO branch_entries (session_id, branch_id, entry_seq, entry_id, entry_type) SELECT session_id, ?, entry_seq, entry_id, entry_type FROM branch_entries WHERE session_id = ? AND branch_id = ? AND entry_id = ?",
				).run(`segment:${ids[3]}`, session, `segment:${ids[0]}`, ids[index]);
			}
			commit(db, tx(write(ids[5]!, ids[2]!)));
			expect(meta(db).find((row) => (row as { branch_id: string }).branch_id === `segment:${ids[5]}`)).toEqual({
				branch_id: `segment:${ids[5]}`,
				tip_entry_id: ids[5],
				tip_seq: 6,
				base_branch_id: `segment:${ids[0]}`,
				base_seq: 2,
			});
		} finally {
			db.close();
		}
	});

	it("rejects ordered membership whose sequence disagrees with the canonical entry and rolls back exactly", async () => {
		const db = await setup();
		try {
			commit(db, {
				writes: [
					write(ids[0]!, null),
					{ kind: "register", op: "set", namespace: "test", key: "between", value: true },
					write(ids[1]!, ids[0]!),
					write(ids[2]!, ids[1]!),
				],
			});
			db.prepare("UPDATE branch_entries SET entry_seq = 2 WHERE session_id = ? AND entry_id = ?").run(
				session,
				ids[0],
			);
			const tables = [
				"entries",
				"registers",
				"branch_meta",
				"branch_entries",
				"session_stats",
				"session_sequences",
				"writer_leases",
			] as const;
			const before = Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
			expectCorruption(() => commit(db, tx(write(ids[3]!, ids[1]!)), 30));
			for (const [table, rows] of Object.entries(before)) {
				expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(rows);
			}
		} finally {
			db.close();
		}
	});

	it("projects root, child, sibling divergence and compaction chains from callback-visible writes", async () => {
		const db = await setup();
		try {
			expect(commit(db, tx(write(ids[0]!, null), write(ids[1]!, ids[0]!), write(ids[2]!, ids[0]!)))).toMatchObject({
				seqs: [1, 2, 3],
			});
			expect(commit(db, tx(write(ids[3]!, ids[2]!, "compaction"), write(ids[4]!, ids[3]!)))).toMatchObject({
				seqs: [4, 5],
			});
			expect(meta(db)).toEqual([
				{ branch_id: `segment:${ids[0]}`, tip_entry_id: ids[1], tip_seq: 2, base_branch_id: null, base_seq: null },
				{ branch_id: `segment:${ids[2]}`, tip_entry_id: ids[4], tip_seq: 5, base_branch_id: null, base_seq: null },
			]);
			expect(members(db)).toEqual([
				{ branch_id: `segment:${ids[0]}`, entry_seq: 1, entry_id: ids[0], entry_type: "message" },
				{ branch_id: `segment:${ids[0]}`, entry_seq: 2, entry_id: ids[1], entry_type: "message" },
				{ branch_id: `segment:${ids[2]}`, entry_seq: 1, entry_id: ids[0], entry_type: "message" },
				{ branch_id: `segment:${ids[2]}`, entry_seq: 3, entry_id: ids[2], entry_type: "message" },
				{ branch_id: `segment:${ids[2]}`, entry_seq: 4, entry_id: ids[3], entry_type: "compaction" },
				{ branch_id: `segment:${ids[2]}`, entry_seq: 5, entry_id: ids[4], entry_type: "message" },
			]);
		} finally {
			db.close();
		}
	});

	it("rejects a tip id whose persisted tip sequence is not the canonical parent sequence and rolls back all state", async () => {
		const db = await setup();
		try {
			commit(db, tx(write(ids[0]!, null)));
			db.exec("PRAGMA ignore_check_constraints=ON");
			db.prepare("UPDATE branch_meta SET tip_seq = 99 WHERE session_id = ?").run(session);
			db.exec("PRAGMA ignore_check_constraints=OFF");
			const before = {
				entries: db.prepare("SELECT * FROM entries").all(),
				meta: meta(db),
				members: members(db),
				stats: db.prepare("SELECT * FROM session_stats").all(),
				sequence: db.prepare("SELECT * FROM session_sequences").all(),
				lease: db.prepare("SELECT * FROM writer_leases").all(),
			};
			expectCorruption(() => commit(db, tx(write(ids[1]!, ids[0]!)), 30));
			expect({
				entries: db.prepare("SELECT * FROM entries").all(),
				meta: meta(db),
				members: members(db),
				stats: db.prepare("SELECT * FROM session_stats").all(),
				sequence: db.prepare("SELECT * FROM session_sequences").all(),
				lease: db.prepare("SELECT * FROM writer_leases").all(),
			}).toEqual(before);
		} finally {
			db.close();
		}
	});

	it.each(["zero", "malformed-segment-id", "missing-segment-suffix"] as const)(
		"rejects missing or structurally invalid physical parent candidates: %s candidate",
		async (kind) => {
			const db = await setup();
			try {
				commit(db, tx(write(ids[0]!, null), write(ids[1]!, ids[0]!), write(ids[2]!, ids[1]!)));
				if (kind === "zero") {
					db.prepare("DELETE FROM branch_entries WHERE session_id = ? AND entry_id = ?").run(session, ids[1]);
				} else {
					const branchId = kind === "malformed-segment-id" ? "bad" : `segment:${ids[4]}`;
					db.prepare(
						"INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq) VALUES (?, ?, ?, 2)",
					).run(session, branchId, ids[1]);
					db.prepare(
						"INSERT INTO branch_entries (session_id, branch_id, entry_seq, entry_id, entry_type) VALUES (?, ?, 1, ?, 'message')",
					).run(session, branchId, ids[0]);
					db.prepare(
						"INSERT INTO branch_entries (session_id, branch_id, entry_seq, entry_id, entry_type) VALUES (?, ?, 2, ?, 'message')",
					).run(session, branchId, ids[1]);
				}
				expect(db.prepare(EXACT_TIP_SQL).get(session, kind === "zero" ? ids[1] : ids[0])).toBeUndefined();
				const before = [db.prepare("SELECT id, seq FROM entries ORDER BY seq").all(), meta(db), members(db)];
				expectCorruption(() => commit(db, tx(write(ids[3]!, kind === "zero" ? ids[1]! : ids[0]!))));
				expect([db.prepare("SELECT id, seq FROM entries ORDER BY seq").all(), meta(db), members(db)]).toEqual(
					before,
				);
			} finally {
				db.close();
			}
		},
	);

	it("atomically creates initial entries and removes every catalog, lease, entry, and projection row on failure", async () => {
		const success = await createNodeSqliteFactory().open(":memory:");
		initializeSqliteSchema(success);
		try {
			createSqliteSession(
				success,
				{ id: session, storageVersion: 1 },
				"owner",
				() => 10,
				100,
				prepareTransaction(tx(write(ids[0]!, null), write(ids[1]!, ids[0]!))),
			);
			expect(success.prepare("SELECT id, seq FROM entries ORDER BY seq").all()).toEqual([
				{ id: ids[0], seq: 1 },
				{ id: ids[1], seq: 2 },
			]);
			expect(meta(success)).toEqual([
				{ branch_id: `segment:${ids[0]}`, tip_entry_id: ids[1], tip_seq: 2, base_branch_id: null, base_seq: null },
			]);
		} finally {
			success.close();
		}

		const failed = await createNodeSqliteFactory().open(":memory:");
		initializeSqliteSchema(failed);
		try {
			failed.exec(
				"CREATE TEMP TRIGGER reject_projection BEFORE INSERT ON branch_entries BEGIN SELECT RAISE(ABORT, 'projection failed'); END",
			);
			expect(() =>
				createSqliteSession(
					failed,
					{ id: session, storageVersion: 1 },
					"owner",
					() => 10,
					100,
					prepareTransaction(tx(write(ids[0]!, null))),
				),
			).toThrow("projection failed");
			for (const table of [
				"sessions",
				"session_sequences",
				"session_stats",
				"writer_leases",
				"entries",
				"branch_meta",
				"branch_entries",
			])
				expect(failed.prepare(`SELECT * FROM ${table}`).all(), table).toEqual([]);
		} finally {
			failed.close();
		}
	});
});
