import {
	assertEntry,
	assertRegister,
	assertUsage,
	assertUsageRow,
	type Entry,
	type EntryScan,
	type JsonValue,
	type Register,
	type SessionStats,
	type UsageRow,
} from "@nguyenphutrong/pi-session-storage";
import type { SqliteDatabase } from "../types.ts";
import { throwPersistedCorruption } from "./persisted-corruption.ts";

const EXACT_LOOKUP_CHUNK_SIZE = 900;

export const READ_REGISTERS_SQL =
	"SELECT namespace, key, value, seq FROM registers WHERE session_id = ? AND namespace = ?";

interface EntryRow {
	id: unknown;
	parent_id: unknown;
	seq: unknown;
	timestamp: unknown;
	type: unknown;
	custom_type: unknown;
	payload: unknown;
}

interface UsageRowRecord {
	id: unknown;
	seq: unknown;
	entry_id: unknown;
	usage: unknown;
	adjustment: unknown;
	details: unknown;
}

interface RegisterRow {
	namespace: unknown;
	key: unknown;
	value: unknown;
	seq: unknown;
}

function assertCanonicalSession(db: SqliteDatabase, sessionId: string): void {
	if (!db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId))
		throwPersistedCorruption("Missing canonical session row");
}

function json(text: unknown, label: string): JsonValue {
	if (typeof text !== "string") throwPersistedCorruption(`${label} is not JSON text`);
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return throwPersistedCorruption(`${label} contains malformed JSON`);
	}
}

function decodeEntry(row: EntryRow): Entry {
	const entry = {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
		type: row.type,
		...(row.custom_type === null ? {} : { customType: row.custom_type }),
		...(row.payload === null ? {} : { payload: json(row.payload, "Entry payload") }),
	};
	try {
		assertEntry(entry);
	} catch {
		return throwPersistedCorruption("Invalid canonical entry row");
	}
	return entry;
}

function decodeUsageRow(row: UsageRowRecord): UsageRow {
	const usageRow = {
		id: row.id,
		seq: row.seq,
		usage: json(row.usage, "Usage payload"),
		adjustment: row.adjustment === 0 ? false : row.adjustment === 1 ? true : row.adjustment,
		...(row.entry_id === null ? {} : { entryId: row.entry_id }),
		...(row.details === null ? {} : { details: json(row.details, "Usage details") }),
	};
	try {
		assertUsageRow(usageRow);
	} catch {
		return throwPersistedCorruption("Invalid canonical usage row");
	}
	return usageRow;
}

function decodeRegister(row: RegisterRow): Register {
	const register = { namespace: row.namespace, key: row.key, value: json(row.value, "Register value"), seq: row.seq };
	try {
		assertRegister(register);
	} catch {
		return throwPersistedCorruption("Invalid canonical register row");
	}
	return register;
}

export function readEntries(db: SqliteDatabase, sessionId: string, ids: readonly string[]): ReadonlyMap<string, Entry> {
	assertCanonicalSession(db, sessionId);
	const found = new Map<string, Entry>();
	for (let offset = 0; offset < ids.length; offset += EXACT_LOOKUP_CHUNK_SIZE) {
		const chunk = ids.slice(offset, offset + EXACT_LOOKUP_CHUNK_SIZE);
		const rows = db
			.prepare(
				`SELECT id, parent_id, seq, timestamp, type, custom_type, payload FROM entries WHERE session_id = ? AND id IN (${chunk.map(() => "?").join(", ")})`,
			)
			.all<EntryRow>(sessionId, ...chunk);
		for (const row of rows) {
			const entry = decodeEntry(row);
			if (!chunk.includes(entry.id) || found.has(entry.id))
				throwPersistedCorruption("Impossible exact entry result");
			found.set(entry.id, entry);
		}
	}
	assertCanonicalSession(db, sessionId);
	return new Map(ids.flatMap((id) => (found.has(id) ? [[id, found.get(id)!] as const] : [])));
}

export function readUsageRows(
	db: SqliteDatabase,
	sessionId: string,
	ids: readonly string[],
): ReadonlyMap<string, UsageRow> {
	assertCanonicalSession(db, sessionId);
	const found = new Map<string, UsageRow>();
	for (let offset = 0; offset < ids.length; offset += EXACT_LOOKUP_CHUNK_SIZE) {
		const chunk = ids.slice(offset, offset + EXACT_LOOKUP_CHUNK_SIZE);
		const rows = db
			.prepare(
				`SELECT id, seq, entry_id, usage, adjustment, details FROM usage_ledger WHERE session_id = ? AND id IN (${chunk.map(() => "?").join(", ")})`,
			)
			.all<UsageRowRecord>(sessionId, ...chunk);
		for (const row of rows) {
			const usageRow = decodeUsageRow(row);
			if (!chunk.includes(usageRow.id) || found.has(usageRow.id))
				throwPersistedCorruption("Impossible exact usage result");
			found.set(usageRow.id, usageRow);
		}
	}
	assertCanonicalSession(db, sessionId);
	return new Map(ids.flatMap((id) => (found.has(id) ? [[id, found.get(id)!] as const] : [])));
}

export function readRegister(
	db: SqliteDatabase,
	sessionId: string,
	namespace: string,
	key: string,
): Register | undefined {
	assertCanonicalSession(db, sessionId);
	const row = db
		.prepare("SELECT namespace, key, value, seq FROM registers WHERE session_id = ? AND namespace = ? AND key = ?")
		.get<RegisterRow>(sessionId, namespace, key);
	return row === undefined ? undefined : decodeRegister(row);
}

export function readRegisters(db: SqliteDatabase, sessionId: string, namespace: string): Register[] {
	assertCanonicalSession(db, sessionId);
	const registers = db.prepare(READ_REGISTERS_SQL).all<RegisterRow>(sessionId, namespace).map(decodeRegister);
	registers.sort((left, right) => left.seq - right.seq);
	return registers;
}

export function readEntryScan(db: SqliteDatabase, sessionId: string, query: EntryScan): Entry[] {
	assertCanonicalSession(db, sessionId);
	const predicates = ["session_id = ?"];
	const params: unknown[] = [sessionId];
	if (query.type !== undefined) {
		predicates.push("type = ?");
		params.push(query.type);
	}
	if (query.customType !== undefined) {
		predicates.push("custom_type = ?");
		params.push(query.customType);
	}
	if (query.fromSeq !== undefined) {
		predicates.push("seq >= ?");
		params.push(query.fromSeq);
	}
	if (query.toSeq !== undefined) {
		predicates.push("seq <= ?");
		params.push(query.toSeq);
	}
	if (query.limit !== undefined) params.push(query.limit);
	return db
		.prepare(
			`SELECT id, parent_id, seq, timestamp, type, custom_type, payload FROM entries INDEXED BY ix_entry_seq WHERE ${predicates.join(" AND ")} ORDER BY seq ${query.order === "desc" ? "DESC" : "ASC"}${query.limit === undefined ? "" : " LIMIT ?"}`,
		)
		.all<EntryRow>(...params)
		.map(decodeEntry);
}

export function readStats(db: SqliteDatabase, sessionId: string): SessionStats {
	assertCanonicalSession(db, sessionId);
	const row = db
		.prepare("SELECT message_count, usage_payload FROM session_stats WHERE session_id = ?")
		.get<{ message_count: unknown; usage_payload: unknown }>(sessionId);
	if (!row) throwPersistedCorruption("Missing canonical stats row");
	if (!Number.isSafeInteger(row.message_count) || (row.message_count as number) < 0)
		throwPersistedCorruption("Invalid canonical message count");
	const usage = json(row.usage_payload, "Stats usage payload");
	try {
		assertUsage(usage);
	} catch {
		return throwPersistedCorruption("Invalid canonical stats usage");
	}
	return { messageCount: row.message_count as number, usage };
}
