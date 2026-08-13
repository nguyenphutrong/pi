import { assertEntry, type BranchScan, type Entry, type EntryStructure } from "@nguyenphutrong/pi-session-storage";
import type { SqliteDatabase } from "../types.ts";
import { type OwnedBranchEntry, resolveParentBranch } from "./branch-chain.ts";
import { throwPersistedCorruption } from "./persisted-corruption.ts";

export const READ_BRANCH_PAYLOAD_SQL =
	"SELECT b.branch_id, b.entry_id, b.entry_seq, b.entry_type, e.id, e.parent_id, e.seq, e.timestamp, e.type, e.custom_type, e.payload FROM branch_entries b INDEXED BY ix_be_seq CROSS JOIN entries e ON e.session_id = b.session_id AND e.id = b.entry_id WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_seq >= ? AND b.entry_seq <= ? ORDER BY b.entry_seq ASC, b.entry_id ASC";

export const READ_TYPED_BRANCH_PAYLOAD_SQL =
	"SELECT b.branch_id, b.entry_id, b.entry_seq, b.entry_type, e.id, e.parent_id, e.seq, e.timestamp, e.type, e.custom_type, e.payload FROM branch_entries b INDEXED BY ix_be_type CROSS JOIN entries e ON e.session_id = b.session_id AND e.id = b.entry_id WHERE b.session_id = ? AND b.branch_id = ? AND b.entry_type = ? AND b.entry_seq >= ? AND b.entry_seq <= ? ORDER BY b.entry_seq ASC, b.entry_id ASC";

interface StructureRow {
	id: unknown;
	parent_id: unknown;
	seq: unknown;
	timestamp: unknown;
	type: unknown;
	custom_type: unknown;
}

interface PayloadRow extends StructureRow {
	branch_id: unknown;
	entry_id: unknown;
	entry_seq: unknown;
	entry_type: unknown;
	payload: unknown;
}

interface OwnerRange {
	ownerBranchId: string;
	fromSeq: number;
	toSeq: number;
}

function corruption(message: string): never {
	return throwPersistedCorruption(message);
}

function assertCanonicalSession(db: SqliteDatabase, sessionId: string): void {
	if (!db.prepare("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId))
		corruption("Missing canonical session row");
}

function structure(row: StructureRow): EntryStructure {
	const candidate = {
		id: row.id,
		parentId: row.parent_id,
		seq: row.seq,
		timestamp: row.timestamp,
		type: row.type,
		...(row.custom_type === null ? {} : { customType: row.custom_type }),
		...(row.type === "custom" ? {} : { payload: null }),
	};
	try {
		assertEntry(candidate);
	} catch {
		return corruption("Invalid canonical entry structure");
	}
	return {
		id: candidate.id,
		parentId: candidate.parentId,
		seq: candidate.seq,
		timestamp: candidate.timestamp,
		type: candidate.type,
		...(candidate.customType === undefined ? {} : { customType: candidate.customType }),
	};
}

function sameStructure(left: EntryStructure, right: EntryStructure): boolean {
	return (
		left.id === right.id &&
		left.parentId === right.parentId &&
		left.seq === right.seq &&
		left.timestamp === right.timestamp &&
		left.type === right.type &&
		left.customType === right.customType
	);
}

function plan(
	db: SqliteDatabase,
	sessionId: string,
	query: BranchScan,
): {
	closure: readonly OwnedBranchEntry[];
	selected: readonly OwnedBranchEntry[];
} {
	assertCanonicalSession(db, sessionId);
	const row = db
		.prepare("SELECT id, parent_id, seq, timestamp, type, custom_type FROM entries WHERE session_id = ? AND id = ?")
		.get<StructureRow>(sessionId, query.start);
	if (!row) corruption("Missing branch start");
	const start = structure(row);
	const closure = resolveParentBranch({ db, sessionId }, start).entries;
	let ordered = query.order === "oldestFirst" ? [...closure] : [...closure].reverse();
	const stop = ordered.findIndex(({ entry }) => entry.id === query.stopAtId || entry.type === query.stopAtType);
	if (stop >= 0) ordered = ordered.slice(0, stop + 1);
	let selected = ordered.filter(
		({ entry }) =>
			(query.type === undefined || entry.type === query.type) &&
			(query.customType === undefined || entry.customType === query.customType) &&
			(query.cursor === undefined ||
				(query.order === "oldestFirst" ? entry.seq > query.cursor.seq : entry.seq < query.cursor.seq)),
	);
	if (query.limit !== undefined) selected = selected.slice(0, query.limit);
	return { closure, selected };
}

function ranges(selected: readonly OwnedBranchEntry[]): OwnerRange[] {
	const sorted = [...selected].sort((left, right) => left.entry.seq - right.entry.seq);
	const result: OwnerRange[] = [];
	for (const item of sorted) {
		const previous = result.at(-1);
		if (previous?.ownerBranchId === item.ownerBranchId) previous.toSeq = item.entry.seq;
		else result.push({ ownerBranchId: item.ownerBranchId, fromSeq: item.entry.seq, toSeq: item.entry.seq });
	}
	return result;
}

export function readBranchStructure(db: SqliteDatabase, sessionId: string, query: BranchScan): EntryStructure[] {
	const result = plan(db, sessionId, query).selected.map(({ entry }) => entry);
	assertCanonicalSession(db, sessionId);
	return structuredClone(result);
}

export function readBranch(db: SqliteDatabase, sessionId: string, query: BranchScan): Entry[] {
	const { closure, selected } = plan(db, sessionId, query);
	if (selected.length === 0) {
		assertCanonicalSession(db, sessionId);
		return [];
	}
	const canonical = new Map(closure.map((item) => [item.entry.id, item]));
	const found = new Map<string, Entry>();
	for (const range of ranges(selected)) {
		const rows =
			query.type === undefined
				? db
						.prepare(READ_BRANCH_PAYLOAD_SQL)
						.all<PayloadRow>(sessionId, range.ownerBranchId, range.fromSeq, range.toSeq)
				: db
						.prepare(READ_TYPED_BRANCH_PAYLOAD_SQL)
						.all<PayloadRow>(sessionId, range.ownerBranchId, query.type, range.fromSeq, range.toSeq);
		for (const row of rows) {
			const expected = typeof row.entry_id === "string" ? canonical.get(row.entry_id) : undefined;
			if (
				!expected ||
				expected.ownerBranchId !== range.ownerBranchId ||
				row.branch_id !== range.ownerBranchId ||
				row.entry_seq !== expected.entry.seq ||
				row.entry_type !== expected.entry.type ||
				found.has(expected.entry.id)
			)
				corruption("Foreign or duplicate branch payload row");
			const canonicalStructure = structure(row);
			if (row.id !== row.entry_id || !sameStructure(canonicalStructure, expected.entry))
				corruption("Branch payload row disagrees with canonical structure");
			let payload: unknown;
			if (row.payload !== null) {
				if (typeof row.payload !== "string") corruption("Entry payload is not JSON text");
				try {
					payload = JSON.parse(row.payload);
				} catch {
					corruption("Entry payload contains malformed JSON");
				}
			}
			const entry = { ...canonicalStructure, ...(row.payload === null ? {} : { payload }) };
			try {
				assertEntry(entry);
			} catch {
				corruption("Invalid canonical branch entry");
			}
			found.set(entry.id, entry);
		}
	}
	const result = selected.map(({ entry }) => found.get(entry.id) ?? corruption("Missing selected branch payload row"));
	assertCanonicalSession(db, sessionId);
	return structuredClone(result);
}
