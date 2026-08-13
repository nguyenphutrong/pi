import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as Harness from "../src/index.ts";
import { CURRENT_STORAGE_VERSION, SessionError, type SessionMetadata, SqliteSessionRepo } from "../src/index.ts";
import { attachRuntime } from "../src/runtime-port.ts";
import { id, user, ZERO_USAGE } from "./fixtures.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "harness-sqlite-repo-"));
	directories.push(directory);
	return join(directory, "sessions.sqlite");
}

function asRepoOptions(value: unknown): ConstructorParameters<typeof SqliteSessionRepo>[0] {
	return value as ConstructorParameters<typeof SqliteSessionRepo>[0];
}

function asCreateOptions(value: unknown): Parameters<SqliteSessionRepo["create"]>[0] {
	return value as Parameters<SqliteSessionRepo["create"]>[0];
}

function asMetadata(value: unknown): SessionMetadata {
	return value as SessionMetadata;
}

async function code(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
		return undefined;
	} catch (error) {
		return error instanceof SessionError ? error.code : undefined;
	}
}

describe("SqliteSessionRepo", () => {
	it("accepts only exact { path } construction and exposes no injectable capabilities", async () => {
		const path = await databasePath();
		const accessor = Object.defineProperty({}, "path", { enumerable: true, get: () => path });
		const hidden = Object.defineProperty({ path }, "factory", { enumerable: false, value: {} });
		const cases: [string, unknown][] = [
			["null", null],
			["array", [path]],
			["custom prototype", Object.assign(Object.create({}), { path })],
			["accessor", accessor],
			["symbol", { path, [Symbol("factory")]: true }],
			["hidden", hidden],
			["extra", { path, factory: {} }],
			["timer", { path, timers: {} }],
			["repair", { path, repair: true }],
			["missing", {}],
			["empty", { path: "" }],
		];
		for (const [label, candidate] of cases)
			expect(() => new SqliteSessionRepo(asRepoOptions(candidate)), label).toThrowError(
				expect.objectContaining({ code: "invalid_metadata" }),
			);
		const repo = new SqliteSessionRepo({ path });
		expect(Reflect.ownKeys(repo)).toEqual([]);
		expect(Object.getOwnPropertyNames(Object.getPrototypeOf(repo)).sort()).toEqual([
			"close",
			"constructor",
			"create",
			"delete",
			"list",
			"open",
		]);
		await repo.close();
	});

	it("atomically creates seq 1 leaf and seq 2 idle state; first attachment is seq 3", async () => {
		const path = await databasePath();
		const repo = new SqliteSessionRepo({ path });
		const parent = await repo.create();
		await parent.close();
		const session = await repo.create({ parentSessionId: parent.metadata.id });
		const metadata = session.metadata;
		expect(Object.isFrozen(metadata)).toBe(true);
		const listed = await repo.list();
		expect(listed[1]).toEqual(metadata);
		expect(listed[1]).not.toBe(metadata);
		expect(Object.isFrozen(listed)).toBe(false);
		expect(Object.isFrozen(listed[1])).toBe(true);
		await session.close();
		const db = new DatabaseSync(path);
		expect(
			db
				.prepare("SELECT namespace, key, value, seq FROM registers WHERE session_id = ? ORDER BY seq")
				.all(metadata.id),
		).toEqual([
			{ namespace: "lane.leaf", key: "main", value: "null", seq: 1 },
			{
				namespace: "lane.state",
				key: "main",
				value: '{"currentOperationId":null,"pendingNextRun":[]}',
				seq: 2,
			},
		]);
		db.close();
		const reopened = await repo.open(metadata);
		const attached = await attachRuntime(reopened, {
			model: { provider: "test", modelId: "sqlite" },
			thinkingLevel: "low",
			activeToolNames: [],
		});
		expect(attached.mainLeaf).toEqual({ seq: 1, value: null });
		expect(attached.laneState).toEqual({ seq: 2, value: { currentOperationId: null, pendingNextRun: [] } });
		expect(attached.laneConfiguration.seq).toBe(3);
		await reopened.close();
		await repo.close();
	});

	it("rolls back the catalog, lease, and first main register when atomic initialization fails", async () => {
		const path = await databasePath();
		const repo = new SqliteSessionRepo({ path });
		await repo.list();
		const db = new DatabaseSync(path);
		db.exec(`
			CREATE TRIGGER reject_main_state
			BEFORE INSERT ON registers
			WHEN NEW.namespace = 'lane.state' AND NEW.key = 'main'
			BEGIN
				SELECT RAISE(ABORT, 'reject main state');
			END
		`);
		db.close();
		const sessionId = id();
		expect(await code(repo.create({ id: sessionId }))).toBe("storage");
		await repo.close();
		const evidence = new DatabaseSync(path);
		for (const table of ["sessions", "session_sequences", "session_stats", "writer_leases", "registers"])
			expect(
				evidence.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(sessionId),
				table,
			).toEqual({ count: 0 });
		evidence.close();
	});

	it("maps missing parents, duplicates, concurrent creates, and local/external ownership", async () => {
		const path = await databasePath();
		const first = new SqliteSessionRepo({ path });
		for (const candidate of [null, [], { extra: true }, { id: "bad" }, { parentSessionId: "bad" }])
			expect(await code(first.create(asCreateOptions(candidate)))).toBe("invalid_metadata");
		expect(await code(first.create({ parentSessionId: id() }))).toBe("not_found");
		const sessionId = id();
		const results = await Promise.allSettled([first.create({ id: sessionId }), first.create({ id: sessionId })]);
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
		const session = results.find((result) => result.status === "fulfilled")?.value;
		if (!session) throw new Error("Expected one created session");
		expect(await code(first.open(session.metadata))).toBe("active");
		expect(await code(first.create({ id: sessionId }))).toBe("metadata_mismatch");
		const second = new SqliteSessionRepo({ path });
		expect(await code(second.open(session.metadata))).toBe("active");
		await session.close();
		const external = await second.open(session.metadata);
		expect(await code(first.open(session.metadata))).toBe("active");
		await external.close();
		await Promise.all([first.close(), second.close()]);
	});

	it("validates open metadata and preserves entries and sequences across fresh repositories", async () => {
		const path = await databasePath();
		const repo = new SqliteSessionRepo({ path });
		const session = await repo.create();
		const first = await session.appendMessage(user("one"));
		await session.close();
		const metadata = session.metadata;
		const malformed = [null, [], {}, { ...metadata, extra: true }, { ...metadata, id: "bad" }];
		for (const candidate of malformed) expect(await code(repo.open(asMetadata(candidate)))).toBe("invalid_metadata");
		expect(await code(repo.open({ ...metadata, storageVersion: CURRENT_STORAGE_VERSION + 1 }))).toBe(
			"storage_version_newer",
		);
		expect(await code(repo.open({ ...metadata, storageVersion: CURRENT_STORAGE_VERSION - 1 }))).toBe(
			"storage_version_older",
		);
		expect(await code(repo.open({ ...metadata, createdAt: metadata.createdAt + 1 }))).toBe("metadata_mismatch");
		expect(await code(repo.open({ ...metadata, id: id() }))).toBe("not_found");
		await repo.close();
		const fresh = new SqliteSessionRepo({ path });
		const reopened = await fresh.open(metadata);
		expect((await reopened.getEntry(first))?.seq).toBe(3);
		const second = await reopened.appendMessage(user("two"));
		expect((await reopened.getEntry(second))?.seq).toBe(5);
		expect(await reopened.getStats()).toEqual({ messageCount: 2, usage: ZERO_USAGE });
		await reopened.close();
		await fresh.close();
	});

	it("maps active, busy, mismatch, missing, and successful delete", async () => {
		const path = await databasePath();
		const first = new SqliteSessionRepo({ path });
		const session = await first.create();
		expect(await code(first.delete(session.metadata))).toBe("active");
		const second = new SqliteSessionRepo({ path });
		expect(await code(second.delete(session.metadata))).toBe("active");
		await session.close();
		expect(await code(first.delete({ ...session.metadata, storageVersion: CURRENT_STORAGE_VERSION + 1 }))).toBe(
			"storage_version_newer",
		);
		expect(await code(first.delete({ ...session.metadata, storageVersion: CURRENT_STORAGE_VERSION - 1 }))).toBe(
			"storage_version_older",
		);
		expect(await code(first.delete({ ...session.metadata, createdAt: session.metadata.createdAt + 1 }))).toBe(
			"metadata_mismatch",
		);
		expect(await code(first.delete({ ...session.metadata, id: id() }))).toBe("not_found");
		await first.delete(session.metadata);
		expect(await code(first.delete(session.metadata))).toBe("not_found");
		await Promise.all([first.close(), second.close()]);
	});

	it("maps an unsupported persisted catalog version to corruption during list", async () => {
		const path = await databasePath();
		const repo = new SqliteSessionRepo({ path });
		const session = await repo.create();
		await session.close();
		const db = new DatabaseSync(path);
		db.exec("PRAGMA ignore_check_constraints = ON");
		db.prepare("UPDATE sessions SET storage_version = ? WHERE session_id = ?").run(
			CURRENT_STORAGE_VERSION + 1,
			session.metadata.id,
		);
		db.close();
		expect(await code(repo.list())).toBe("corruption");
		await repo.close();
	});

	it("releases the exact acquired lease after main-lane validation fails without repairing", async () => {
		const path = await databasePath();
		const repo = new SqliteSessionRepo({ path });
		const session = await repo.create();
		const metadata = session.metadata;
		await session.close();
		const db = new DatabaseSync(path);
		db.prepare("DELETE FROM registers WHERE session_id = ? AND namespace = 'lane.state' AND key = 'main'").run(
			metadata.id,
		);
		expect(db.prepare("SELECT COUNT(*) AS count FROM writer_leases WHERE session_id = ?").get(metadata.id)).toEqual({
			count: 0,
		});
		db.close();
		expect(await code(repo.open(metadata))).toBe("corruption");
		const evidence = new DatabaseSync(path);
		expect(
			evidence.prepare("SELECT COUNT(*) AS count FROM writer_leases WHERE session_id = ?").get(metadata.id),
		).toEqual({
			count: 0,
		});
		expect(
			evidence
				.prepare("SELECT COUNT(*) AS count FROM registers WHERE session_id = ? AND namespace = 'lane.state'")
				.get(metadata.id),
		).toEqual({ count: 0 });
		evidence.close();
		await repo.close();
	});

	it("makes closes idempotent, rejects late operations, and maps SQLite/storage failures", async () => {
		const path = await databasePath();
		const repo = new SqliteSessionRepo({ path });
		const session = await repo.create();
		const db = new DatabaseSync(path);
		db.exec("PRAGMA foreign_keys=OFF; DROP TABLE writer_leases");
		db.close();
		const firstClose = session.close();
		expect(session.close()).toBe(firstClose);
		await expect(firstClose).rejects.toMatchObject({ code: "storage" });
		expect(await code(session.getLeafId())).toBe("closed");
		const repoClose = repo.close();
		expect(repo.close()).toBe(repoClose);
		await expect(repoClose).resolves.toBeUndefined();
		expect(await code(repo.list())).toBe("closed");
		expect(await code(repo.create())).toBe("closed");
	});

	it("keeps the Harness root boundary free of backend administration and concrete internals", () => {
		const forbidden = /repair|factory|timer|lease|fence|handle/i;
		expect(Object.keys(Harness).filter((name) => forbidden.test(name))).toEqual([]);
		expect(Object.keys(Harness)).toContain("SqliteSessionRepo");
	});
});
