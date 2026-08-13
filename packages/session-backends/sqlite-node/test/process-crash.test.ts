import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteStorageRepository } from "../src/index.ts";
import type { TimerFactory, TimerHandle } from "../src/sqlite/storage/lifecycle.ts";
import {
	CHILD_ID,
	CLOCK,
	CRASH_OWNER,
	type CrashMode,
	PROTOCOL_VERSION,
	type ProtocolEvent,
	ROOT_ID,
	SESSION_ID,
	TAKEOVER_OWNER,
	TTL,
	USAGE_ID,
} from "./process-crash-support.ts";

class DormantTimers implements TimerFactory {
	schedule(_callback: () => void, _delay: number): TimerHandle {
		return {};
	}
	cancel(_handle: TimerHandle): void {}
}

const CHILD = fileURLToPath(new URL("./process-crash-child.ts", import.meta.url));
const ORDERS = {
	sessions: "created_at, session_id",
	session_sequences: "session_id",
	entries: "session_id, seq, id",
	registers: "session_id, namespace, key",
	usage_ledger: "session_id, seq, id",
	session_stats: "session_id",
	writer_leases: "session_id",
	branch_meta: "session_id, branch_id",
	branch_entries: "session_id, branch_id, entry_seq, entry_id",
} as const;
type Table = keyof typeof ORDERS;
type Snapshot = Record<Table, readonly Record<string, unknown>[]>;

const CUTS = [
	"before-first-operation",
	"lease-renew",
	"entry-insert",
	"branch-entry-insert",
	"branch-meta-update",
	"usage-insert",
	"register-set:new",
	"register-set:overwrite",
	"register-delete:delete",
	"register-delete:absent",
	"stats-update",
	"sequence-update",
	"after-commit",
] as const;
const CREATE_CUTS = [
	"before-first-operation",
	"session-catalog-insert",
	"session-sequences-insert",
	"session-stats-initial-insert",
	"writer-lease-insert",
	"register-set:lane.leaf",
	"register-set:lane.state",
	"final-stats-update",
	"final-sequence-update",
	"after-commit",
] as const;
const ZERO_USAGE =
	'{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}';
const COMMITTED_USAGE =
	'{"input":2,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":5,"cost":{"input":0.2,"output":0.3,"cacheRead":0,"cacheWrite":0,"total":0.5}}';
const SESSION = {
	session_id: SESSION_ID,
	created_at: CLOCK,
	parent_session_id: null,
	storage_version: 1,
	metadata: null,
};
const LEASE = { session_id: SESSION_ID, owner_id: CRASH_OWNER, fence: 1, expires_at_ms: CLOCK + TTL };
const ROOT_ENTRY = {
	session_id: SESSION_ID,
	id: ROOT_ID,
	seq: 1,
	parent_id: null,
	timestamp: CLOCK,
	type: "message",
	custom_type: null,
	payload: '{"role":"user","content":"root"}',
};
const BRANCH_ID = `segment:${ROOT_ID}`;
const ROOT_BRANCH_ENTRY = {
	session_id: SESSION_ID,
	branch_id: BRANCH_ID,
	entry_seq: 1,
	entry_id: ROOT_ID,
	entry_type: "message",
};
const EXPECTED_BASELINE: Snapshot = {
	sessions: [SESSION],
	session_sequences: [{ session_id: SESSION_ID, next_seq: 4 }],
	entries: [ROOT_ENTRY],
	registers: [
		{ session_id: SESSION_ID, namespace: "test", key: "delete", value: '"remove"', seq: 3 },
		{ session_id: SESSION_ID, namespace: "test", key: "overwrite", value: '"old"', seq: 2 },
	],
	usage_ledger: [],
	session_stats: [{ session_id: SESSION_ID, message_count: 1, usage_payload: ZERO_USAGE }],
	writer_leases: [LEASE],
	branch_meta: [
		{
			session_id: SESSION_ID,
			branch_id: BRANCH_ID,
			tip_entry_id: ROOT_ID,
			tip_seq: 1,
			base_branch_id: null,
			base_seq: null,
		},
	],
	branch_entries: [ROOT_BRANCH_ENTRY],
};
const EXPECTED_COMPLETE: Snapshot = {
	sessions: [SESSION],
	session_sequences: [{ session_id: SESSION_ID, next_seq: 10 }],
	entries: [
		ROOT_ENTRY,
		{
			session_id: SESSION_ID,
			id: CHILD_ID,
			seq: 4,
			parent_id: ROOT_ID,
			timestamp: CLOCK,
			type: "message",
			custom_type: null,
			payload: '{"role":"assistant","content":"child"}',
		},
	],
	registers: [
		{ session_id: SESSION_ID, namespace: "test", key: "new", value: '{"committed":true}', seq: 6 },
		{ session_id: SESSION_ID, namespace: "test", key: "overwrite", value: '"new"', seq: 7 },
	],
	usage_ledger: [
		{
			session_id: SESSION_ID,
			id: USAGE_ID,
			seq: 5,
			entry_id: CHILD_ID,
			usage: COMMITTED_USAGE,
			adjustment: 0,
			details: null,
		},
	],
	session_stats: [{ session_id: SESSION_ID, message_count: 2, usage_payload: COMMITTED_USAGE }],
	writer_leases: [LEASE],
	branch_meta: [
		{
			session_id: SESSION_ID,
			branch_id: BRANCH_ID,
			tip_entry_id: CHILD_ID,
			tip_seq: 4,
			base_branch_id: null,
			base_seq: null,
		},
	],
	branch_entries: [
		ROOT_BRANCH_ENTRY,
		{ session_id: SESSION_ID, branch_id: BRANCH_ID, entry_seq: 4, entry_id: CHILD_ID, entry_type: "message" },
	],
};
const EMPTY: Snapshot = {
	sessions: [],
	session_sequences: [],
	entries: [],
	registers: [],
	usage_ledger: [],
	session_stats: [],
	writer_leases: [],
	branch_meta: [],
	branch_entries: [],
};
const EXPECTED_CREATE_COMPLETE: Snapshot = {
	sessions: [SESSION],
	session_sequences: [{ session_id: SESSION_ID, next_seq: 3 }],
	entries: [],
	registers: [
		{ session_id: SESSION_ID, namespace: "lane.leaf", key: "main", value: "null", seq: 1 },
		{
			session_id: SESSION_ID,
			namespace: "lane.state",
			key: "main",
			value: '{"currentOperationId":null,"pendingNextRun":[]}',
			seq: 2,
		},
	],
	usage_ledger: [],
	session_stats: [{ session_id: SESSION_ID, message_count: 0, usage_payload: ZERO_USAGE }],
	writer_leases: [LEASE],
	branch_meta: [],
	branch_entries: [],
};

interface ChildResult {
	readonly events: readonly ProtocolEvent[];
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

interface CrashCase {
	readonly dir: string;
	readonly path: string;
	readonly result: ChildResult;
	readonly state: Snapshot;
}

function runChild(mode: CrashMode, path: string, cut: string): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--no-warnings", CHILD, mode, path, cut], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGKILL");
			reject(error);
		};
		const timer = setTimeout(() => {
			fail(new Error(`Child timed out at ${cut}`));
		}, 10_000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > 64 * 1024) return fail(new Error(`Child stdout byte limit exceeded at ${cut}`));
			stdout += chunk.toString("utf8");
			const lines = stdout.split("\n");
			if (lines.length - (lines.at(-1) === "" ? 1 : 0) > 3)
				return fail(new Error(`Child event limit exceeded at ${cut}`));
			if (lines.some((line) => Buffer.byteLength(line) > 16 * 1024))
				return fail(new Error(`Child line limit exceeded at ${cut}`));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.byteLength;
			if (stderrBytes > 16 * 1024) return fail(new Error(`Child stderr byte limit exceeded at ${cut}`));
			stderr += chunk.toString("utf8");
			fail(new Error(`Unexpected child stderr at ${cut}: ${stderr}`));
		});
		child.on("error", (error) => fail(error));
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				if (!stdout.endsWith("\n")) throw new Error(`Incomplete protocol line at ${cut}`);
				const parsed: unknown[] = stdout
					.slice(0, -1)
					.split("\n")
					.map((line) => JSON.parse(line) as unknown);
				const valid = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
					typeof value === "object" &&
					value !== null &&
					Object.getPrototypeOf(value) === Object.prototype &&
					Object.keys(value).length === keys.length &&
					keys.every((key) => Object.hasOwn(value, key));
				if (!valid(parsed[0], ["v", "event"]) || parsed[0].v !== 1 || parsed[0].event !== "armed")
					throw new Error(`Invalid armed event at ${cut}`);
				if (cut === "trace") {
					if (
						!valid(parsed[1], ["v", "event", "cuts"]) ||
						parsed[1].v !== 1 ||
						parsed[1].event !== "catalog" ||
						!Array.isArray(parsed[1].cuts) ||
						!parsed[1].cuts.every((item) => typeof item === "string") ||
						!valid(parsed[2], ["v", "event"]) ||
						parsed[2].v !== 1 ||
						parsed[2].event !== "complete" ||
						parsed.length !== 3
					)
						throw new Error("Invalid trace protocol");
				} else if (
					!valid(parsed[1], ["v", "event", "cut"]) ||
					parsed[1].v !== 1 ||
					parsed[1].event !== "cut-reached" ||
					parsed[1].cut !== cut ||
					parsed.length !== 2
				) {
					throw new Error(`Invalid crash protocol at ${cut}`);
				}
				const events = parsed as ProtocolEvent[];
				resolve({ events, code, signal });
			} catch (error) {
				reject(error);
			}
		});
	});
}

function snapshot(path: string): Snapshot {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const read = (table: Table): Record<string, unknown>[] =>
			db.prepare(`SELECT * FROM ${table} ORDER BY ${ORDERS[table]}`).all();
		return {
			sessions: read("sessions"),
			session_sequences: read("session_sequences"),
			entries: read("entries"),
			registers: read("registers"),
			usage_ledger: read("usage_ledger"),
			session_stats: read("session_stats"),
			writer_leases: read("writer_leases"),
			branch_meta: read("branch_meta"),
			branch_entries: read("branch_entries"),
		};
	} finally {
		db.close();
	}
}

async function makeCase(cut: string, mode: CrashMode = "commit"): Promise<CrashCase> {
	const dir = await mkdtemp(join(tmpdir(), "pi-sqlite-crash-"));
	const path = join(dir, "session.sqlite");
	try {
		const result = await runChild(mode, path, cut);
		if (cut !== "trace") await Promise.all([access(`${path}-wal`), access(`${path}-shm`)]);
		return { dir, path, result, state: snapshot(path) };
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}

function assertKilled(result: ChildResult, cut: string): void {
	expect(result.code).toBeNull();
	expect(result.signal).toBe("SIGKILL");
	expect(result.events).toEqual([
		{ v: PROTOCOL_VERSION, event: "armed" },
		{ v: PROTOCOL_VERSION, event: "cut-reached", cut },
	]);
}

async function verifyTakeover(path: string, committed: boolean): Promise<void> {
	const timers = new DormantTimers();
	const repository = new SqliteStorageRepository({
		factory: createNodeSqliteFactory(),
		path,
		now: () => CLOCK + TTL,
		ownerId: () => TAKEOVER_OWNER,
		leaseTtlMs: TTL,
		heartbeatMs: 500,
		timers,
	});
	const handle = await repository.open({ id: SESSION_ID, createdAt: CLOCK, storageVersion: 1 });
	try {
		const lease = new DatabaseSync(path, { readOnly: true });
		try {
			expect(lease.prepare("SELECT owner_id, fence, expires_at_ms FROM writer_leases").get()).toEqual({
				owner_id: TAKEOVER_OWNER,
				fence: 2,
				expires_at_ms: CLOCK + TTL * 2,
			});
		} finally {
			lease.close();
		}
		const start = committed ? CHILD_ID : ROOT_ID;
		expect((await handle.scanBranchStructure({ start, order: "oldestFirst" })).map((entry) => entry.id)).toEqual(
			committed ? [ROOT_ID, CHILD_ID] : [ROOT_ID],
		);
		expect(await handle.getStats()).toMatchObject({ messageCount: committed ? 2 : 1 });
		const result = await handle.commit({
			writes: [{ kind: "register", op: "set", namespace: "test", key: "takeover", value: true }],
		});
		expect(result.seqs).toEqual([committed ? 10 : 4]);
	} finally {
		await handle.close();
		await repository.close();
	}
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		expect(db.prepare("SELECT * FROM writer_leases").all()).toEqual([]);
	} finally {
		db.close();
	}
}

async function verifyCreateRecovery(path: string, committed: boolean): Promise<void> {
	const timers = new DormantTimers();
	const repository = new SqliteStorageRepository({
		factory: createNodeSqliteFactory(),
		path,
		now: () => CLOCK + TTL,
		ownerId: () => TAKEOVER_OWNER,
		leaseTtlMs: TTL,
		heartbeatMs: 500,
		timers,
	});
	try {
		const metadata = { id: SESSION_ID, createdAt: CLOCK, storageVersion: 1 };
		expect(await repository.list()).toEqual(committed ? [metadata] : []);
		if (!committed) return;
		const handle = await repository.open(metadata);
		try {
			const lease = new DatabaseSync(path, { readOnly: true });
			try {
				expect(lease.prepare("SELECT owner_id, fence, expires_at_ms FROM writer_leases").get()).toEqual({
					owner_id: TAKEOVER_OWNER,
					fence: 2,
					expires_at_ms: CLOCK + TTL * 2,
				});
			} finally {
				lease.close();
			}
			expect(await handle.getStats()).toEqual({
				messageCount: 0,
				usage: JSON.parse(ZERO_USAGE) as unknown,
			});
			expect(await handle.getRegister("lane.leaf", "main")).toEqual({
				namespace: "lane.leaf",
				key: "main",
				value: null,
				seq: 1,
			});
			expect(await handle.getRegister("lane.state", "main")).toEqual({
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: null, pendingNextRun: [] },
				seq: 2,
			});
			const result = await handle.commit({
				writes: [{ kind: "register", op: "set", namespace: "test", key: "takeover", value: true }],
			});
			expect(result.seqs).toEqual([3]);
		} finally {
			await handle.close();
		}
	} finally {
		await repository.close();
	}
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		expect(db.prepare("SELECT * FROM writer_leases").all()).toEqual([]);
	} finally {
		db.close();
	}
}

describe.skipIf(process.platform === "win32")("SQLite ordinary commit process crash atomicity", () => {
	it(
		"discovers every semantic mutation and accepts only complete atomic states at every cut",
		{ timeout: 180_000 },
		async () => {
			const trace = await makeCase("trace");
			let baseline: CrashCase | undefined;
			let complete: CrashCase | undefined;
			try {
				expect(trace.result).toMatchObject({ code: 0, signal: null });
				expect(trace.result.events).toEqual([
					{ v: PROTOCOL_VERSION, event: "armed" },
					{ v: PROTOCOL_VERSION, event: "catalog", cuts: CUTS },
					{ v: PROTOCOL_VERSION, event: "complete" },
				]);
				const catalogEvent = trace.result.events[1];
				const cuts = catalogEvent?.cuts ?? [];
				expect(new Set(cuts).size).toBe(cuts.length);
				expect(trace.state).toEqual({ ...EXPECTED_COMPLETE, writer_leases: [] });
				baseline = await makeCase("before-first-operation");
				complete = await makeCase("after-commit");
				assertKilled(baseline.result, "before-first-operation");
				assertKilled(complete.result, "after-commit");
				expect(baseline.state).toEqual(EXPECTED_BASELINE);
				expect(complete.state).toEqual(EXPECTED_COMPLETE);
				for (const cut of cuts) {
					const crash: CrashCase =
						cut === "before-first-operation" ? baseline : cut === "after-commit" ? complete : await makeCase(cut);
					try {
						assertKilled(crash.result, cut);
						const committed = cut === "after-commit";
						expect(crash.state).toEqual(committed ? EXPECTED_COMPLETE : EXPECTED_BASELINE);
						await verifyTakeover(crash.path, committed);
					} finally {
						if (crash !== baseline && crash !== complete) await rm(crash.dir, { recursive: true, force: true });
					}
				}
			} finally {
				await rm(trace.dir, { recursive: true, force: true });
				if (baseline) await rm(baseline.dir, { recursive: true, force: true });
				if (complete) await rm(complete.dir, { recursive: true, force: true });
			}
		},
	);

	it("keeps atomic repository creation absent or complete at every semantic cut", { timeout: 180_000 }, async () => {
		const trace = await makeCase("trace", "create");
		let absent: CrashCase | undefined;
		let complete: CrashCase | undefined;
		try {
			expect(trace.result).toMatchObject({ code: 0, signal: null });
			expect(trace.result.events).toEqual([
				{ v: PROTOCOL_VERSION, event: "armed" },
				{ v: PROTOCOL_VERSION, event: "catalog", cuts: CREATE_CUTS },
				{ v: PROTOCOL_VERSION, event: "complete" },
			]);
			expect(trace.state).toEqual({ ...EXPECTED_CREATE_COMPLETE, writer_leases: [] });
			absent = await makeCase("before-first-operation", "create");
			complete = await makeCase("after-commit", "create");
			for (const cut of CREATE_CUTS) {
				const crash: CrashCase =
					cut === "before-first-operation"
						? absent
						: cut === "after-commit"
							? complete
							: await makeCase(cut, "create");
				try {
					assertKilled(crash.result, cut);
					const committed = cut === "after-commit";
					expect(crash.state).toEqual(committed ? EXPECTED_CREATE_COMPLETE : EMPTY);
					await verifyCreateRecovery(crash.path, committed);
				} finally {
					if (crash !== absent && crash !== complete) await rm(crash.dir, { recursive: true, force: true });
				}
			}
		} finally {
			await rm(trace.dir, { recursive: true, force: true });
			if (absent) await rm(absent.dir, { recursive: true, force: true });
			if (complete) await rm(complete.dir, { recursive: true, force: true });
		}
	});
});
