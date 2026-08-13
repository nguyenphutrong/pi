import {
	assertUsage,
	type CommitResult,
	type Entry,
	StorageError,
	type UsageRow,
} from "@nguyenphutrong/pi-session-storage";
import type { SqliteDatabase } from "../types.ts";
import type { PreparedTransaction } from "./prepared-transaction.ts";

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
		return corruption("Canonical session stats contain invalid usage");
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

/** Applies one prepared caller transaction in exactly one synchronous SQLite transaction. */
export function executeTransaction(options: TransactionEngineOptions): CommitResult {
	const { db, sessionId, transaction } = options;
	const callbackDb: Pick<SqliteDatabase, "prepare"> = Object.freeze({
		prepare: (sql: string) => db.prepare(sql),
	});
	return db.transaction(() => {
		const timestamp = options.now();
		if (!Number.isSafeInteger(timestamp) || timestamp < 0) invalid("Timestamp must be a non-negative safe integer");
		const context: TransactionEngineContext = { db: callbackDb, sessionId, timestamp };
		options.beforeWrites(context);

		if (!db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId))
			corruption("Missing canonical session row");
		const sequence = db
			.prepare("SELECT next_seq FROM session_sequences WHERE session_id = ?")
			.get<{ next_seq: number }>(sessionId);
		const statsRow = db
			.prepare("SELECT message_count, usage_payload FROM session_stats WHERE session_id = ?")
			.get<StatsRow>(sessionId);
		if (!sequence) corruption("Missing canonical sequence row");
		if (!statsRow) corruption("Missing canonical stats row");
		if (!Number.isSafeInteger(sequence.next_seq) || sequence.next_seq < 1)
			corruption("Invalid canonical sequence row");
		if (!Number.isSafeInteger(statsRow.message_count) || statsRow.message_count < 0)
			corruption("Invalid canonical stats row");
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
				options.projectInsertedEntry(context, entry);
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
			corruption("Missing canonical stats row");
		if (
			db
				.prepare("UPDATE session_sequences SET next_seq = ? WHERE session_id = ?")
				.run(sequence.next_seq + transaction.writes.length, sessionId).changes !== 1
		)
			corruption("Missing canonical sequence row");
		return { firstSeq: seqs[0]!, seqs, timestamp };
	});
}
