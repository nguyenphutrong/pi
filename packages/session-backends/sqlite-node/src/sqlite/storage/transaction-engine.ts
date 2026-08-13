import {
	assertUsage,
	type CommitResult,
	type Entry,
	StorageError,
	type UsageRow,
} from "@nguyenphutrong/pi-session-storage";
import type { SqliteDatabase } from "../types.ts";
import { projectSqliteEntry } from "./branch-projection.ts";
import { throwPersistedCorruption } from "./persisted-corruption.ts";
import type { PreparedTransaction } from "./prepared-transaction.ts";

export { isPersistedSqliteCorruption } from "./persisted-corruption.ts";

export interface TransactionEngineContext {
	readonly db: Pick<SqliteDatabase, "prepare">;
	readonly sessionId: string;
	readonly timestamp: number;
}

export interface TransactionEngineOptions {
	db: SqliteDatabase;
	sessionId: string;
	transaction: PreparedTransaction;
	now: () => number;
	beforeWrites: (context: TransactionEngineContext) => void;
	projectInsertedEntry: (context: TransactionEngineContext, entry: Entry) => void;
}

function markedCorruption(message: string): never {
	return throwPersistedCorruption(message);
}

interface StatsRow {
	message_count: number;
	usage_payload: string;
}

type Usage = UsageRow["usage"];

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function invalid(message: string): never {
	throw new StorageError("invalid_transaction", message);
}

function corruption(message: string): never {
	throw new StorageError("corruption", message);
}

function parseUsage(payload: string): Usage {
	try {
		const value: unknown = JSON.parse(payload);
		assertUsage(value);
		return value;
	} catch {
		return markedCorruption("Canonical session stats contain invalid usage");
	}
}

function parsePreparedUsage(payload: string): Usage {
	try {
		const value: unknown = JSON.parse(payload);
		assertUsage(value);
		return value;
	} catch {
		return corruption("Prepared transaction contains invalid serialized usage");
	}
}

function addUsage(total: Usage, addition: Usage): void {
	for (const field of USAGE_FIELDS) {
		total[field] += addition[field];
		if (!Number.isFinite(total[field])) invalid(`Accumulated usage.${field} is not finite`);
	}
	for (const field of COST_FIELDS) {
		total.cost[field] += addition.cost[field];
		if (!Number.isFinite(total.cost[field])) invalid(`Accumulated usage.cost.${field} is not finite`);
	}
	for (const field of ["cacheWrite1h", "reasoning"] as const) {
		if (addition[field] !== undefined) {
			total[field] = (total[field] ?? 0) + addition[field];
			if (!Number.isFinite(total[field])) invalid(`Accumulated usage.${field} is not finite`);
		}
	}
}

function applyPreparedInCurrentTransaction(
	db: SqliteDatabase,
	sessionId: string,
	transaction: PreparedTransaction,
	context: TransactionEngineContext,
	projectInsertedEntry: TransactionEngineOptions["projectInsertedEntry"],
): CommitResult {
	const timestamp = context.timestamp;

	if (!db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId))
		markedCorruption("Missing canonical session row");
	const sequence = db
		.prepare("SELECT next_seq FROM session_sequences WHERE session_id = ?")
		.get<{ next_seq: number }>(sessionId);
	const statsRow = db
		.prepare("SELECT message_count, usage_payload FROM session_stats WHERE session_id = ?")
		.get<StatsRow>(sessionId);
	if (!sequence) markedCorruption("Missing canonical sequence row");
	if (!statsRow) markedCorruption("Missing canonical stats row");
	if (!Number.isSafeInteger(sequence.next_seq) || sequence.next_seq < 1)
		markedCorruption("Invalid canonical sequence row");
	if (!Number.isSafeInteger(statsRow.message_count) || statsRow.message_count < 0)
		markedCorruption("Invalid canonical stats row");
	if (transaction.writes.length > Number.MAX_SAFE_INTEGER - sequence.next_seq)
		invalid("Transaction exhausts the safe sequence range");
	const preparedUsage = transaction.writes.map((write) =>
		write.kind === "usage" ? parsePreparedUsage(write.usageJson) : undefined,
	);

	const knownEntries = new Set<string>();
	const newIds = new Set<string>();
	for (const write of transaction.writes) {
		if (write.kind === "register") continue;
		if (newIds.has(write.id)) corruption(`Duplicate durable id: ${write.id}`);
		newIds.add(write.id);
		const entryExists = db
			.prepare("SELECT 1 AS present FROM entries WHERE session_id = ? AND id = ?")
			.get(sessionId, write.id);
		const usageExists = db
			.prepare("SELECT 1 AS present FROM usage_ledger WHERE session_id = ? AND id = ?")
			.get(sessionId, write.id);
		if (entryExists || usageExists) corruption(`Duplicate durable id: ${write.id}`);
		const reference = write.kind === "entry" ? write.parentId : write.entryId;
		if (reference !== null && !knownEntries.has(reference)) {
			const committed = db
				.prepare("SELECT 1 AS present FROM entries WHERE session_id = ? AND id = ?")
				.get(sessionId, reference);
			if (!committed) invalid(`Missing or forward entry reference: ${reference}`);
		}
		if (write.kind === "entry") knownEntries.add(write.id);
	}

	const usage = parseUsage(statsRow.usage_payload);
	let messageCount = statsRow.message_count;
	for (let index = 0; index < transaction.writes.length; index++) {
		const write = transaction.writes[index]!;
		if (write.kind === "entry" && write.type === "message") {
			messageCount++;
			if (!Number.isSafeInteger(messageCount)) invalid("Accumulated message count is unsafe");
		} else if (write.kind === "usage") addUsage(usage, preparedUsage[index]!);
	}
	const usagePayload = JSON.stringify(usage);
	const seqs = transaction.writes.map((_, index) => sequence.next_seq + index);

	for (let index = 0; index < transaction.writes.length; index++) {
		const write = transaction.writes[index]!;
		const seq = seqs[index]!;
		if (write.kind === "entry") {
			db.prepare(
				"INSERT INTO entries (session_id, id, seq, parent_id, timestamp, type, custom_type, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(sessionId, write.id, seq, write.parentId, timestamp, write.type, write.customType, write.payload);
			const entry: Entry = {
				id: write.id,
				parentId: write.parentId,
				seq,
				timestamp,
				type: write.type,
				...(write.customType === null ? {} : { customType: write.customType }),
				...(write.payload === null ? {} : { payload: JSON.parse(write.payload) }),
			};
			projectInsertedEntry(context, entry);
		} else if (write.kind === "usage") {
			db.prepare(
				"INSERT INTO usage_ledger (session_id, id, seq, entry_id, usage, adjustment, details) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run(sessionId, write.id, seq, write.entryId, write.usageJson, write.adjustment ? 1 : 0, write.details);
		} else if (write.op === "set") {
			db.prepare(
				"INSERT INTO registers (session_id, namespace, key, value, seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, namespace, key) DO UPDATE SET value = excluded.value, seq = excluded.seq",
			).run(sessionId, write.namespace, write.key, write.value, seq);
		} else {
			db.prepare("DELETE FROM registers WHERE session_id = ? AND namespace = ? AND key = ?").run(
				sessionId,
				write.namespace,
				write.key,
			);
		}
	}
	if (
		db
			.prepare("UPDATE session_stats SET message_count = ?, usage_payload = ? WHERE session_id = ?")
			.run(messageCount, usagePayload, sessionId).changes !== 1
	)
		markedCorruption("Missing canonical stats row");
	if (
		db
			.prepare("UPDATE session_sequences SET next_seq = ? WHERE session_id = ?")
			.run(sequence.next_seq + transaction.writes.length, sessionId).changes !== 1
	)
		markedCorruption("Missing canonical sequence row");
	return { firstSeq: seqs[0]!, seqs, timestamp };
}

/** Applies one prepared caller transaction in exactly one synchronous SQLite transaction. */
export function executeTransaction(options: TransactionEngineOptions): CommitResult {
	return runImmediate(
		options.db,
		(context) => {
			options.beforeWrites(context);
			return applyPreparedInCurrentTransaction(
				options.db,
				options.sessionId,
				options.transaction,
				context,
				options.projectInsertedEntry,
			);
		},
		options.sessionId,
		options.now,
		(timestamp) => {
			if (!Number.isSafeInteger(timestamp) || timestamp < 0)
				invalid("Timestamp must be a non-negative safe integer");
		},
	);
}

export interface LeaseIdentity {
	readonly sessionId: string;
	readonly ownerId: string;
	readonly fence: number;
}

export interface SessionMetadataRow {
	readonly id: string;
	readonly createdAt: number;
	readonly storageVersion: number;
	readonly parentSessionId?: string;
}

export type NewSessionMetadataRow = Omit<SessionMetadataRow, "createdAt">;

export class SqliteEngineError extends Error {
	readonly code:
		| "duplicate"
		| "missing"
		| "busy"
		| "fence_exhausted"
		| "version_mismatch"
		| "invalid_clock"
		| "invalid_lease"
		| "metadata_mismatch";

	constructor(code: SqliteEngineError["code"], message: string) {
		super(message);
		this.name = "SqliteEngineError";
		this.code = code;
	}
}

function runImmediate<T>(
	db: SqliteDatabase,
	operation: (context: TransactionEngineContext) => T,
	sessionId: string,
	now: () => number,
	validateTimestamp: (timestamp: number) => void = assertClock,
): T {
	const callbackDb: Pick<SqliteDatabase, "prepare"> = Object.freeze({ prepare: (sql: string) => db.prepare(sql) });
	return db.transaction(() => {
		const timestamp = now();
		validateTimestamp(timestamp);
		return operation({ db: callbackDb, sessionId, timestamp });
	});
}

function expiry(now: number, ttlMs: number): number {
	return ttlMs > Number.MAX_SAFE_INTEGER - now ? Number.MAX_SAFE_INTEGER : now + ttlMs;
}

function assertClock(now: number): void {
	if (!Number.isSafeInteger(now) || now < 0 || now === Number.MAX_SAFE_INTEGER)
		throw new SqliteEngineError(
			"invalid_clock",
			"Clock must be a non-negative safe integer below Number.MAX_SAFE_INTEGER",
		);
}

function assertLeaseInput(sessionId: string, ownerId: string, ttlMs?: number, fence?: number): void {
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.includes("\0"))
		throw new SqliteEngineError("invalid_lease", "Session id is invalid");
	if (typeof ownerId !== "string" || ownerId.length === 0 || ownerId.includes("\0"))
		throw new SqliteEngineError("invalid_lease", "Owner id is invalid");
	if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0))
		throw new SqliteEngineError("invalid_lease", "Lease TTL must be a positive safe integer");
	if (fence !== undefined && (!Number.isSafeInteger(fence) || fence < 1))
		throw new SqliteEngineError("invalid_lease", "Lease fence is invalid");
}

function acquireInTransaction(context: TransactionEngineContext, ownerId: string, ttlMs: number): number {
	const current = context.db
		.prepare("SELECT owner_id, fence, expires_at_ms FROM writer_leases WHERE session_id = ?")
		.get<{ owner_id: string; fence: number; expires_at_ms: number }>(context.sessionId);
	if (current && current.expires_at_ms > context.timestamp)
		throw new SqliteEngineError("busy", `Session ${context.sessionId} has an active writer`);
	const fence = current ? current.fence + 1 : 1;
	if (!Number.isSafeInteger(fence)) throw new SqliteEngineError("fence_exhausted", "Writer fence is exhausted");
	if (current) {
		if (
			context.db
				.prepare("UPDATE writer_leases SET owner_id = ?, fence = ?, expires_at_ms = ? WHERE session_id = ?")
				.run(ownerId, fence, expiry(context.timestamp, ttlMs), context.sessionId).changes !== 1
		)
			throw new SqliteEngineError("missing", `Lease disappeared for ${context.sessionId}`);
	} else {
		context.db
			.prepare("INSERT INTO writer_leases (session_id, owner_id, fence, expires_at_ms) VALUES (?, ?, ?, ?)")
			.run(context.sessionId, ownerId, fence, expiry(context.timestamp, ttlMs));
	}
	return fence;
}

export function acquireSqliteLease(
	db: SqliteDatabase,
	sessionId: string,
	ownerId: string,
	now: () => number,
	ttlMs: number,
): number {
	assertLeaseInput(sessionId, ownerId, ttlMs);
	return runImmediate(
		db,
		(context) => {
			if (!context.db.prepare("SELECT 1 AS present FROM sessions WHERE session_id = ?").get(sessionId))
				throw new SqliteEngineError("missing", `Unknown session ${sessionId}`);
			return acquireInTransaction(context, ownerId, ttlMs);
		},
		sessionId,
		now,
	);
}

export function acquireSqliteSession(
	db: SqliteDatabase,
	metadata: SessionMetadataRow,
	ownerId: string,
	now: () => number,
	ttlMs: number,
): number {
	assertLeaseInput(metadata.id, ownerId, ttlMs);
	return runImmediate(
		db,
		(context) => {
			const row = context.db
				.prepare(
					"SELECT created_at, parent_session_id, storage_version, metadata FROM sessions WHERE session_id = ?",
				)
				.get<{
					created_at: number;
					parent_session_id: string | null;
					storage_version: number;
					metadata: string | null;
				}>(metadata.id);
			if (!row) throw new SqliteEngineError("missing", `Unknown session ${metadata.id}`);
			if (
				row.metadata !== null ||
				row.created_at !== metadata.createdAt ||
				row.storage_version !== metadata.storageVersion ||
				row.parent_session_id !== (metadata.parentSessionId ?? null)
			)
				throw new SqliteEngineError("metadata_mismatch", "Metadata does not match the catalog");
			return acquireInTransaction(context, ownerId, ttlMs);
		},
		metadata.id,
		now,
	);
}

export function renewSqliteLease(db: SqliteDatabase, lease: LeaseIdentity, now: () => number, ttlMs: number): boolean {
	assertLeaseInput(lease.sessionId, lease.ownerId, ttlMs, lease.fence);
	return runImmediate(
		db,
		(context) =>
			context.db
				.prepare(
					"UPDATE writer_leases SET expires_at_ms = ? WHERE session_id = ? AND owner_id = ? AND fence = ? AND expires_at_ms > ?",
				)
				.run(expiry(context.timestamp, ttlMs), lease.sessionId, lease.ownerId, lease.fence, context.timestamp)
				.changes === 1,
		lease.sessionId,
		now,
	);
}

export function releaseSqliteLease(db: SqliteDatabase, lease: LeaseIdentity): void {
	assertLeaseInput(lease.sessionId, lease.ownerId, undefined, lease.fence);
	runImmediate(
		db,
		(context) => {
			context.db
				.prepare("DELETE FROM writer_leases WHERE session_id = ? AND owner_id = ? AND fence = ?")
				.run(lease.sessionId, lease.ownerId, lease.fence);
		},
		lease.sessionId,
		() => 0,
	);
}

export function commitSqliteTransaction(
	db: SqliteDatabase,
	lease: LeaseIdentity,
	transaction: PreparedTransaction,
	now: () => number,
	ttlMs: number,
): CommitResult {
	assertLeaseInput(lease.sessionId, lease.ownerId, ttlMs, lease.fence);
	return runImmediate(
		db,
		(context) => {
			if (
				context.db
					.prepare(
						"UPDATE writer_leases SET expires_at_ms = ? WHERE session_id = ? AND owner_id = ? AND fence = ? AND expires_at_ms > ?",
					)
					.run(expiry(context.timestamp, ttlMs), lease.sessionId, lease.ownerId, lease.fence, context.timestamp)
					.changes !== 1
			)
				throw new StorageError("closed", "SQLite writer lease was lost");
			return applyPreparedInCurrentTransaction(db, lease.sessionId, transaction, context, projectSqliteEntry);
		},
		lease.sessionId,
		now,
	);
}

const ZERO_USAGE = JSON.stringify({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function createSqliteSession(
	db: SqliteDatabase,
	metadata: NewSessionMetadataRow,
	ownerId: string,
	now: () => number,
	ttlMs: number,
	initial?: PreparedTransaction,
): { readonly metadata: SessionMetadataRow; readonly fence: number } {
	assertLeaseInput(metadata.id, ownerId, ttlMs);
	const fence = 1;
	return runImmediate(
		db,
		(context) => {
			if (context.db.prepare("SELECT 1 AS present FROM sessions WHERE session_id = ?").get(metadata.id))
				throw new SqliteEngineError("duplicate", `Session ${metadata.id} already exists`);
			if (
				metadata.parentSessionId !== undefined &&
				!context.db.prepare("SELECT 1 AS present FROM sessions WHERE session_id = ?").get(metadata.parentSessionId)
			)
				throw new SqliteEngineError("missing", `Unknown parent session ${metadata.parentSessionId}`);
			context.db
				.prepare(
					"INSERT INTO sessions (session_id, created_at, parent_session_id, storage_version, metadata) VALUES (?, ?, ?, ?, NULL)",
				)
				.run(metadata.id, context.timestamp, metadata.parentSessionId ?? null, metadata.storageVersion);
			context.db.prepare("INSERT INTO session_sequences (session_id, next_seq) VALUES (?, 1)").run(metadata.id);
			context.db
				.prepare("INSERT INTO session_stats (session_id, message_count, usage_payload) VALUES (?, 0, ?)")
				.run(metadata.id, ZERO_USAGE);
			context.db
				.prepare("INSERT INTO writer_leases (session_id, owner_id, fence, expires_at_ms) VALUES (?, ?, 1, ?)")
				.run(metadata.id, ownerId, expiry(context.timestamp, ttlMs));
			if (initial && initial.writes.length > 0) {
				applyPreparedInCurrentTransaction(db, metadata.id, initial, context, projectSqliteEntry);
			}
			return {
				metadata: Object.freeze({ ...metadata, createdAt: context.timestamp }),
				fence,
			};
		},
		metadata.id,
		now,
	);
}

export function deleteSqliteSession(
	db: SqliteDatabase,
	metadata: SessionMetadataRow,
	ownerId: string,
	now: () => number,
	ttlMs: number,
): boolean {
	assertLeaseInput(metadata.id, ownerId, ttlMs);
	return runImmediate(
		db,
		(context) => {
			const row = context.db
				.prepare(
					"SELECT created_at, parent_session_id, storage_version, metadata FROM sessions WHERE session_id = ?",
				)
				.get<{
					created_at: number;
					parent_session_id: string | null;
					storage_version: number;
					metadata: string | null;
				}>(metadata.id);
			if (!row) return false;
			if (
				row.metadata !== null ||
				row.created_at !== metadata.createdAt ||
				row.storage_version !== metadata.storageVersion ||
				row.parent_session_id !== (metadata.parentSessionId ?? null)
			)
				throw new SqliteEngineError("metadata_mismatch", "Metadata does not match the catalog");
			acquireInTransaction(context, ownerId, ttlMs);
			if (context.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(metadata.id).changes !== 1)
				throw new SqliteEngineError("missing", `Session ${metadata.id} disappeared`);
			return true;
		},
		metadata.id,
		now,
	);
}
