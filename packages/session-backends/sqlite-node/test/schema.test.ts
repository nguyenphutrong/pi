import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	initializeSqliteSchema,
	SQLITE_SCHEMA_INDEXES,
	SQLITE_SCHEMA_TABLES,
	SQLITE_SCHEMA_TRIGGERS,
	type SqliteDatabase,
} from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDatabase(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-session-sqlite-"));
	tempDirs.push(directory);
	return join(directory, "sessions.sqlite");
}

function names(db: SqliteDatabase, type: string): string[] {
	return db
		.prepare("SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
		.all<{ name: string }>(type)
		.map((row) => row.name);
}

function insertSession(db: SqliteDatabase, id = "session"): void {
	db.prepare(
		"INSERT INTO sessions (session_id, created_at, parent_session_id, storage_version, metadata) VALUES (?, 0, NULL, 1, NULL)",
	).run(id);
}

function insertEntry(
	db: SqliteDatabase,
	id: string,
	seq: number,
	options?: { type?: string; customType?: string | null; payload?: string | null },
): void {
	const payload = options && Object.hasOwn(options, "payload") ? options.payload : "{}";
	db.prepare(
		"INSERT INTO entries (session_id, id, seq, parent_id, timestamp, type, custom_type, payload) VALUES ('session', ?, ?, NULL, 0, ?, ?, ?)",
	).run(id, seq, options?.type ?? "message", options?.customType ?? null, payload);
}

describe("canonical SQLite schema", () => {
	it("creates exactly the canonical tables, indexes, and triggers", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			initializeSqliteSchema(db);
			expect(names(db, "table")).toEqual(SQLITE_SCHEMA_TABLES);
			expect(names(db, "index")).toEqual(SQLITE_SCHEMA_INDEXES);
			expect(names(db, "trigger")).toEqual(SQLITE_SCHEMA_TRIGGERS);
			for (const forbidden of [
				"records",
				"lanes",
				"facts",
				"values",
				"slot_history",
				"log",
				"migrations",
				"branch_tips",
			])
				expect(names(db, "table")).not.toContain(forbidden);
		} finally {
			db.close();
		}
	});

	it("configures durable file pragmas and reopens the current schema", async () => {
		const path = tempDatabase();
		const factory = createNodeSqliteFactory();
		for (let open = 0; open < 2; open++) {
			const db = await factory.open(path);
			try {
				initializeSqliteSchema(db);
				expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
				expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
				expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
				expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
				expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
			} finally {
				db.close();
			}
		}
	});

	it("refuses non-empty legacy version zero and newer versions", async () => {
		const legacy = await createNodeSqliteFactory().open(":memory:");
		try {
			legacy.exec("CREATE TABLE legacy (id TEXT)");
			expect(() => initializeSqliteSchema(legacy)).toThrow("non-empty legacy");
		} finally {
			legacy.close();
		}
		const newer = await createNodeSqliteFactory().open(":memory:");
		try {
			newer.exec("PRAGMA user_version=2");
			expect(() => initializeSqliteSchema(newer)).toThrow("version 2");
		} finally {
			newer.close();
		}
	});

	it("rejects a damaged current inventory", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			initializeSqliteSchema(db);
			db.exec("DROP TRIGGER usage_id_not_entry");
			expect(() => initializeSqliteSchema(db)).toThrow("trigger inventory");
		} finally {
			db.close();
		}
	});

	it("rejects extra schema objects and changed canonical definitions", async () => {
		const extra = await createNodeSqliteFactory().open(":memory:");
		try {
			initializeSqliteSchema(extra);
			extra.exec("CREATE VIEW extra_view AS SELECT session_id FROM sessions");
			expect(() => initializeSqliteSchema(extra)).toThrow("schema object inventory");
		} finally {
			extra.close();
		}

		const changed = await createNodeSqliteFactory().open(":memory:");
		try {
			initializeSqliteSchema(changed);
			changed.exec("DROP INDEX ix_usage_seq; CREATE INDEX ix_usage_seq ON usage_ledger(session_id, id)");
			expect(() => initializeSqliteSchema(changed)).toThrow("index definition: ix_usage_seq");
		} finally {
			changed.close();
		}

		const changedTable = await createNodeSqliteFactory().open(":memory:");
		try {
			initializeSqliteSchema(changedTable);
			changedTable.exec(`
				PRAGMA foreign_keys=OFF;
				DROP TABLE sessions;
				CREATE TABLE sessions (
					session_id TEXT PRIMARY KEY,
					created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),
					parent_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
					storage_version INTEGER NOT NULL CHECK(storage_version = 1),
					metadata TEXT CHECK(metadata IS NULL OR json_valid(metadata))
				);
			`);
			expect(() => initializeSqliteSchema(changedTable)).toThrow("table definition: sessions");
		} finally {
			changedTable.close();
		}
	});

	it("enforces foreign keys, entry envelopes, JSON, safe integers, and booleans", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			initializeSqliteSchema(db);
			expect(() => insertEntry(db, "missing-session", 1)).toThrow("FOREIGN KEY");
			insertSession(db);
			expect(() => insertEntry(db, "bad-type", 1, { type: "unknown" })).toThrow("CHECK");
			expect(() => insertEntry(db, "bad-json", 1, { payload: "{" })).toThrow("CHECK");
			expect(() => insertEntry(db, "unsafe", 9_007_199_254_740_992)).toThrow("CHECK");
			expect(() => insertEntry(db, "custom-missing", 1, { type: "custom", payload: null })).toThrow("CHECK");
			db.prepare("INSERT INTO session_sequences VALUES ('session', 1)").run();
			expect(() =>
				db.prepare("INSERT INTO usage_ledger VALUES ('session', 'u', 2, NULL, '{}', 2, NULL)").run(),
			).toThrow("CHECK");
		} finally {
			db.close();
		}
	});

	it("preserves absent custom payload separately from JSON null", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			initializeSqliteSchema(db);
			insertSession(db);
			insertEntry(db, "absent", 1, { type: "custom", customType: "x", payload: null });
			insertEntry(db, "json-null", 2, { type: "custom", customType: "x", payload: "null" });
			expect(db.prepare("SELECT id, payload FROM entries ORDER BY seq").all()).toEqual([
				{ id: "absent", payload: null },
				{ id: "json-null", payload: "null" },
			]);
		} finally {
			db.close();
		}
	});

	it("rejects cross-table durable IDs in both insertion directions", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			initializeSqliteSchema(db);
			insertSession(db);
			insertEntry(db, "entry-first", 1);
			expect(() =>
				db.prepare("INSERT INTO usage_ledger VALUES ('session', 'entry-first', 2, NULL, '{}', 0, NULL)").run(),
			).toThrow("durable id already used by entry");
			db.prepare("INSERT INTO usage_ledger VALUES ('session', 'usage-first', 3, NULL, '{}', 0, NULL)").run();
			expect(() => insertEntry(db, "usage-first", 4)).toThrow("durable id already used by usage");
		} finally {
			db.close();
		}
	});

	it("requires branch metadata before branch rows and supports repair deletion order", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			initializeSqliteSchema(db);
			insertSession(db);
			insertEntry(db, "entry", 1);
			const branchRow = "INSERT INTO branch_entries VALUES ('session', 'branch', 1, 'entry', 'message')";
			expect(() => db.exec(branchRow)).toThrow("FOREIGN KEY");
			db.exec("INSERT INTO branch_meta VALUES ('session', 'branch', 'entry', 1, NULL, NULL)");
			db.exec(branchRow);
			expect(() => db.exec("DELETE FROM branch_meta WHERE branch_id = 'branch'")).toThrow("FOREIGN KEY");
			db.exec("DELETE FROM branch_entries; DELETE FROM branch_meta");
		} finally {
			db.close();
		}
	});

	it("cascades every session-owned row only when its session is deleted", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			initializeSqliteSchema(db);
			insertSession(db);
			insertEntry(db, "entry", 1);
			db.exec(`
				INSERT INTO session_sequences VALUES ('session', 4);
				INSERT INTO registers VALUES ('session', 'namespace', 'key', '{}', 2);
				INSERT INTO usage_ledger VALUES ('session', 'usage', 3, 'entry', '{}', 0, NULL);
				INSERT INTO session_stats VALUES ('session', 1, '{}');
				INSERT INTO writer_leases VALUES ('session', 'owner', 1, 1);
				INSERT INTO branch_meta VALUES ('session', 'branch', 'entry', 1, NULL, NULL);
				INSERT INTO branch_entries VALUES ('session', 'branch', 1, 'entry', 'message');
				DELETE FROM sessions WHERE session_id = 'session';
			`);
			for (const table of SQLITE_SCHEMA_TABLES) {
				expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
			}
		} finally {
			db.close();
		}
	});
});
