import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqliteFactory } from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("node:sqlite adapter", () => {
	it("commits a synchronous transaction and returns its result", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
			const result = db.transaction(() => {
				db.prepare("INSERT INTO values_table (value) VALUES (?)").run(42);
				return "committed";
			});

			expect(result).toBe("committed");
			expect(db.prepare("SELECT value FROM values_table").get()).toEqual({ value: 42 });
		} finally {
			db.close();
		}
	});

	it("forwards positional and named statement parameters", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			db.exec("CREATE TABLE values_table (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
			expect(db.prepare("INSERT INTO values_table (value) VALUES (?)").run("positional")).toEqual({
				changes: 1,
				lastInsertRowid: 1,
			});
			expect(db.prepare("INSERT INTO values_table (value) VALUES (:value)").run({ value: "named" })).toEqual({
				changes: 1,
				lastInsertRowid: 2,
			});
			expect(db.prepare("SELECT value FROM values_table WHERE id = ?").get(1)).toEqual({ value: "positional" });
			expect(db.prepare("SELECT value FROM values_table WHERE id >= :id ORDER BY id").all({ id: 2 })).toEqual([
				{ value: "named" },
			]);
		} finally {
			db.close();
		}
	});

	it("rejects asynchronous transaction callbacks", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
			const asynchronous = async () => {
				db.prepare("INSERT INTO values_table (value) VALUES (?)").run(42);
				await Promise.resolve();
			};
			expect(() => db.transaction(asynchronous)).toThrow("SQLite transaction callbacks must be synchronous");
			await Promise.resolve();
			expect(db.prepare("SELECT value FROM values_table").all()).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("rolls back a failed transaction", async () => {
		const db = await createNodeSqliteFactory().open(":memory:");
		try {
			db.exec("CREATE TABLE values_table (value INTEGER NOT NULL)");
			expect(() =>
				db.transaction(() => {
					db.prepare("INSERT INTO values_table (value) VALUES (?)").run(42);
					throw new Error("stop");
				}),
			).toThrow("stop");
			expect(db.prepare("SELECT value FROM values_table").all()).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("takes the write lock before a read can create a stale WAL snapshot", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-session-sqlite-transaction-"));
		tempDirs.push(directory);
		const path = join(directory, "transactions.sqlite");
		const factory = createNodeSqliteFactory();
		const first = await factory.open(path);
		const second = await factory.open(path);
		try {
			first.exec(
				"PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1; CREATE TABLE values_table (value INTEGER NOT NULL)",
			);
			second.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1");

			first.exec("BEGIN");
			first.prepare("SELECT value FROM values_table").all();
			second.transaction(() => second.prepare("INSERT INTO values_table VALUES (?)").run(1));
			expect(() => first.prepare("INSERT INTO values_table VALUES (?)").run(2)).toThrow(/locked/i);
			first.exec("ROLLBACK");

			first.transaction(() => {
				first.prepare("SELECT value FROM values_table").all();
				expect(() =>
					second.transaction(() => second.prepare("INSERT INTO values_table VALUES (?)").run(2)),
				).toThrow(/locked/i);
				first.prepare("INSERT INTO values_table VALUES (?)").run(2);
			});
			second.transaction(() => second.prepare("INSERT INTO values_table VALUES (?)").run(3));
			expect(first.prepare("SELECT value FROM values_table ORDER BY value").all()).toEqual([
				{ value: 1 },
				{ value: 2 },
				{ value: 3 },
			]);
		} finally {
			first.close();
			second.close();
		}
	});
});
