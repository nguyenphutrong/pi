import { assertEntry, type Entry } from "@nguyenphutrong/pi-session-storage";
import {
	assertSegmentIdentity,
	branchEntryIdentity,
	type OwnedBranchEntry,
	resolveParentBranch,
} from "./branch-chain.ts";
import { throwPersistedCorruption } from "./persisted-corruption.ts";
import type { TransactionEngineContext } from "./transaction-engine.ts";

export const EXACT_TIP_SQL =
	"SELECT branch_id, tip_seq FROM branch_meta INDEXED BY ix_bm_tip WHERE session_id = ? AND tip_entry_id = ?";

export const COPY_MEMBERSHIP_SQL =
	"SELECT entry_id, entry_seq, entry_type FROM branch_entries INDEXED BY ix_be_seq WHERE session_id = ? AND branch_id = ? AND entry_seq > ? AND entry_seq <= ? ORDER BY entry_seq, entry_id";

function insertMembership(context: TransactionEngineContext, branchId: string, entry: Entry): void {
	const [id, seq, type] = branchEntryIdentity(entry);
	if (
		context.db
			.prepare(
				"INSERT INTO branch_entries (session_id, branch_id, entry_seq, entry_id, entry_type) VALUES (?, ?, ?, ?, ?)",
			)
			.run(context.sessionId, branchId, seq, id, type).changes !== 1
	)
		throwPersistedCorruption("Branch membership insert did not affect one row");
}

function copyEntries(context: TransactionEngineContext, branchId: string, entries: readonly OwnedBranchEntry[]): void {
	for (const item of entries) {
		const source = context.db
			.prepare(COPY_MEMBERSHIP_SQL)
			.all<{ entry_id: unknown; entry_seq: unknown; entry_type: unknown }>(
				context.sessionId,
				item.ownerBranchId,
				item.entry.seq - 1,
				item.entry.seq,
			);
		if (
			source.length !== 1 ||
			source[0]!.entry_id !== item.entry.id ||
			source[0]!.entry_seq !== item.entry.seq ||
			source[0]!.entry_type !== item.entry.type
		)
			throwPersistedCorruption("Copied branch membership is not one-to-one");
		insertMembership(context, branchId, item.entry);
	}
}

export function projectSqliteEntry(context: TransactionEngineContext, entry: Entry): void {
	const branchId = `segment:${entry.id}`;
	if (entry.parentId === null) {
		context.db
			.prepare(
				"INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq) VALUES (?, ?, ?, ?, NULL, NULL)",
			)
			.run(context.sessionId, branchId, entry.id, entry.seq);
		insertMembership(context, branchId, entry);
		return;
	}

	const parentRow = context.db
		.prepare(
			"SELECT id, parent_id, seq, timestamp, type, custom_type, payload FROM entries WHERE session_id = ? AND id = ?",
		)
		.get<{
			id: string;
			parent_id: string | null;
			seq: number;
			timestamp: number;
			type: Entry["type"];
			custom_type: string | null;
			payload: string | null;
		}>(context.sessionId, entry.parentId);
	if (!parentRow) throwPersistedCorruption("Inserted entry parent disappeared during projection");
	let payload: unknown;
	try {
		payload = parentRow.payload === null ? undefined : JSON.parse(parentRow.payload);
	} catch {
		throwPersistedCorruption("Parent entry payload contains malformed JSON");
	}
	const parentValue = {
		id: parentRow.id,
		parentId: parentRow.parent_id,
		seq: parentRow.seq,
		timestamp: parentRow.timestamp,
		type: parentRow.type,
		...(parentRow.custom_type === null ? {} : { customType: parentRow.custom_type }),
		...(parentRow.payload === null ? {} : { payload }),
	};
	try {
		assertEntry(parentValue);
	} catch {
		throwPersistedCorruption("Invalid parent entry envelope");
	}
	const parent: Entry = parentValue;
	const exactTip = context.db
		.prepare(EXACT_TIP_SQL)
		.get<{ branch_id: unknown; tip_seq: unknown }>(context.sessionId, entry.parentId);
	if (exactTip) {
		if (
			!Number.isSafeInteger(exactTip.tip_seq) ||
			(exactTip.tip_seq as number) < 1 ||
			exactTip.tip_seq !== parent.seq
		)
			throwPersistedCorruption("Invalid exact branch tip metadata");
		const exactBranchId = exactTip.branch_id;
		assertSegmentIdentity(context, exactBranchId);
		insertMembership(context, exactBranchId, entry);
		if (
			context.db
				.prepare(
					"UPDATE branch_meta SET tip_entry_id = ?, tip_seq = ? WHERE session_id = ? AND branch_id = ? AND tip_entry_id = ? AND tip_seq = ?",
				)
				.run(entry.id, entry.seq, context.sessionId, exactBranchId, entry.parentId, exactTip.tip_seq).changes !== 1
		)
			throwPersistedCorruption("Exact branch tip update did not affect one row");
		return;
	}

	const selected = resolveParentBranch(context, parent);
	let compactionIndex = -1;
	for (let index = selected.entries.length - 1; index >= 0; index--) {
		if (selected.entries[index]!.entry.type === "compaction") {
			compactionIndex = index;
			break;
		}
	}
	const compaction = compactionIndex < 0 ? undefined : selected.entries[compactionIndex]!;
	context.db
		.prepare(
			"INSERT INTO branch_meta (session_id, branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(
			context.sessionId,
			branchId,
			entry.id,
			entry.seq,
			compaction?.ownerBranchId ?? null,
			compaction?.entry.seq ?? null,
		);
	copyEntries(context, branchId, selected.entries.slice(compactionIndex + 1));
	insertMembership(context, branchId, entry);
}
