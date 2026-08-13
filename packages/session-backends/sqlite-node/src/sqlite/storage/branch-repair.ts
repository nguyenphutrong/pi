import type { Entry, EntryStructure } from "@nguyenphutrong/pi-session-storage";
import { assertSegmentIdentity, resolveParentBranch } from "./branch-chain.ts";
import { projectSqliteEntry } from "./branch-projection.ts";
import { type CanonicalEntryRow, decodeCanonicalEntryRow } from "./ordinary-reader.ts";
import { throwPersistedCorruption } from "./persisted-corruption.ts";
import type { TransactionEngineContext } from "./transaction-engine.ts";

function structure(entry: Entry): EntryStructure {
	return {
		id: entry.id,
		parentId: entry.parentId,
		seq: entry.seq,
		timestamp: entry.timestamp,
		type: entry.type,
		...(entry.customType === undefined ? {} : { customType: entry.customType }),
	};
}

interface BranchMetaInventoryRow {
	session_id: unknown;
	branch_id: unknown;
	tip_entry_id: unknown;
	tip_seq: unknown;
	base_branch_id: unknown;
	base_seq: unknown;
}

interface BranchEntryInventoryRow {
	session_id: unknown;
	branch_id: unknown;
	entry_seq: unknown;
	entry_id: unknown;
	entry_type: unknown;
}

function validateRebuiltProjection(context: TransactionEngineContext, entries: readonly Entry[]): void {
	const metadata = context.db
		.prepare(
			"SELECT session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq FROM branch_meta WHERE session_id = ? ORDER BY branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq",
		)
		.all<BranchMetaInventoryRow>(context.sessionId);
	const memberships = context.db
		.prepare(
			"SELECT session_id, branch_id, entry_seq, entry_id, entry_type FROM branch_entries WHERE session_id = ? ORDER BY branch_id, entry_seq, entry_id, entry_type",
		)
		.all<BranchEntryInventoryRow>(context.sessionId);
	const canonical = new Map(entries.map((entry) => [entry.id, entry]));
	const branches = new Map<string, BranchMetaInventoryRow>();
	for (const row of metadata) {
		if (row.session_id !== context.sessionId || typeof row.branch_id !== "string" || branches.has(row.branch_id))
			throwPersistedCorruption("Impossible rebuilt branch metadata inventory");
		branches.set(row.branch_id, row);
		assertSegmentIdentity(context, row.branch_id);
	}
	const membershipKeys = new Set<string>();
	const membershipIds = new Set<string>();
	for (const row of memberships) {
		if (
			row.session_id !== context.sessionId ||
			typeof row.branch_id !== "string" ||
			typeof row.entry_id !== "string" ||
			!branches.has(row.branch_id)
		)
			throwPersistedCorruption("Orphan or foreign rebuilt branch membership");
		const key = `${row.branch_id}\0${row.entry_id}`;
		if (membershipKeys.has(key)) throwPersistedCorruption("Duplicate rebuilt branch membership");
		membershipKeys.add(key);
		membershipIds.add(row.entry_id);
		const entry = canonical.get(row.entry_id);
		if (!entry || row.entry_seq !== entry.seq || row.entry_type !== entry.type)
			throwPersistedCorruption("Rebuilt branch membership disagrees with canonical entry");
	}
	for (const [branchId, row] of branches) {
		if (typeof row.tip_entry_id !== "string") throwPersistedCorruption("Invalid rebuilt branch tip");
		const tip = canonical.get(row.tip_entry_id);
		if (!tip || row.tip_seq !== tip.seq || !membershipKeys.has(`${branchId}\0${tip.id}`))
			throwPersistedCorruption("Rebuilt branch tip disagrees with canonical membership");
		if (
			(row.base_branch_id !== null &&
				(typeof row.base_branch_id !== "string" || !branches.has(row.base_branch_id))) ||
			(row.base_branch_id === null) !== (row.base_seq === null)
		)
			throwPersistedCorruption("Rebuilt branch base is not inventoried");
	}
	if (entries.some((entry) => !membershipIds.has(entry.id)))
		throwPersistedCorruption("Rebuilt branch projection does not cover every canonical entry");
	for (const entry of entries) {
		const closure = resolveParentBranch(context, structure(entry)).entries;
		if (closure.at(-1)?.entry.id !== entry.id)
			throwPersistedCorruption("Rebuilt branch closure does not contain its canonical tip");
	}
}

/** Replaces one session's derived branch cache from canonical entries only. */
export function rebuildBranchProjection(context: TransactionEngineContext, nextSeq: number): void {
	const rows = context.db
		.prepare(
			"SELECT id, parent_id, seq, timestamp, type, custom_type, payload FROM entries WHERE session_id = ? ORDER BY seq",
		)
		.all<CanonicalEntryRow>(context.sessionId);
	const entries = rows.map(decodeCanonicalEntryRow);
	const seen = new Set<string>();
	let previousSeq = 0;
	for (const entry of entries) {
		if (
			!Number.isSafeInteger(entry.seq) ||
			entry.seq < 1 ||
			entry.seq >= nextSeq ||
			entry.seq <= previousSeq ||
			seen.has(entry.id)
		)
			throwPersistedCorruption("Canonical entry inventory has an invalid sequence or duplicate");
		if (entry.parentId !== null && !seen.has(entry.parentId))
			throwPersistedCorruption("Canonical entry inventory has a missing or forward parent");
		seen.add(entry.id);
		previousSeq = entry.seq;
	}

	context.db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run(context.sessionId);
	context.db.prepare("DELETE FROM branch_meta WHERE session_id = ?").run(context.sessionId);
	for (const entry of entries) projectSqliteEntry(context, entry);
	validateRebuiltProjection(context, entries);
}
