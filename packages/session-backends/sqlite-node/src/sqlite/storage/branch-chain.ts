import { assertEntry, type Entry, type EntryType, isUuidV7 } from "@nguyenphutrong/pi-session-storage";
import { throwPersistedCorruption } from "./persisted-corruption.ts";
import type { TransactionEngineContext } from "./transaction-engine.ts";

export const MATERIALIZE_SEGMENT_SQL =
	"SELECT b.branch_id, b.entry_id, b.entry_seq, b.entry_type, e.seq AS canonical_seq, e.parent_id, e.timestamp, e.type, e.custom_type, e.payload FROM branch_entries b INDEXED BY ix_be_seq CROSS JOIN entries e ON e.session_id = b.session_id AND e.id = b.entry_id WHERE b.session_id = ? AND b.branch_id = ? ORDER BY b.entry_seq, b.entry_id";

export const PARENT_CANDIDATES_SQL =
	"SELECT branch_id FROM branch_entries INDEXED BY ix_be_entry WHERE session_id = ? AND entry_id = ? ORDER BY branch_id ASC";

export const SEGMENT_IDENTITY_SQL =
	"SELECT entry_id FROM branch_entries WHERE session_id = ? AND branch_id = ? AND entry_id = ?";

interface BranchMetaRow {
	branch_id: unknown;
	tip_entry_id: unknown;
	tip_seq: unknown;
	base_branch_id: unknown;
	base_seq: unknown;
}

interface BranchEntryRow {
	branch_id: unknown;
	entry_id: unknown;
	entry_seq: unknown;
	entry_type: unknown;
	canonical_seq: unknown;
	parent_id: unknown;
	timestamp: unknown;
	type: unknown;
	custom_type: unknown;
	payload: unknown;
}

export interface OwnedBranchEntry {
	readonly entry: Entry;
	readonly ownerBranchId: string;
}

export interface MaterializedBranch {
	readonly branchId: string;
	readonly tipSeq: number;
	readonly entries: readonly OwnedBranchEntry[];
}

function corruption(message: string): never {
	return throwPersistedCorruption(message);
}

export function assertSegmentIdentity(
	context: TransactionEngineContext,
	branchId: unknown,
): asserts branchId is string {
	if (typeof branchId !== "string" || !branchId.startsWith("segment:") || !isUuidV7(branchId.slice(8)))
		corruption("Invalid branch identity");
	const creationEntryId = branchId.slice(8);
	const membership = context.db
		.prepare(SEGMENT_IDENTITY_SQL)
		.get<{ entry_id: unknown }>(context.sessionId, branchId, creationEntryId);
	if (!membership || membership.entry_id !== creationEntryId)
		corruption("Branch segment does not contain its creation entry");
}

function decode(row: BranchEntryRow): Entry {
	if (
		!Number.isSafeInteger(row.canonical_seq) ||
		(row.canonical_seq as number) < 1 ||
		row.entry_seq !== row.canonical_seq
	)
		corruption("Branch membership sequence disagrees with its entry");
	let payload: unknown;
	if (row.payload !== null) {
		if (typeof row.payload !== "string") corruption("Branch entry payload is not JSON text");
		try {
			payload = JSON.parse(row.payload);
		} catch {
			return corruption("Branch entry payload contains malformed JSON");
		}
	}
	const entry = {
		id: row.entry_id,
		parentId: row.parent_id,
		seq: row.canonical_seq,
		timestamp: row.timestamp,
		type: row.type,
		...(row.custom_type === null ? {} : { customType: row.custom_type }),
		...(row.payload === null ? {} : { payload }),
	};
	try {
		assertEntry(entry);
	} catch {
		return corruption("Invalid joined branch entry envelope");
	}
	if (row.entry_type !== entry.type) corruption("Branch entry type disagrees with its entry");
	return entry;
}

function meta(context: TransactionEngineContext, branchId: string): BranchMetaRow {
	const row = context.db
		.prepare(
			"SELECT branch_id, tip_entry_id, tip_seq, base_branch_id, base_seq FROM branch_meta WHERE session_id = ? AND branch_id = ?",
		)
		.get<BranchMetaRow>(context.sessionId, branchId);
	if (!row) corruption("Missing branch metadata");
	return row;
}

function sameStructure(left: Entry, right: Entry): boolean {
	return (
		left.id === right.id &&
		left.parentId === right.parentId &&
		left.seq === right.seq &&
		left.timestamp === right.timestamp &&
		left.type === right.type &&
		left.customType === right.customType
	);
}

function materialize(context: TransactionEngineContext, branchId: string, parent: Entry): MaterializedBranch {
	const result: OwnedBranchEntry[] = [];
	const seenBranches = new Set<string>();
	const seenEntries = new Set<string>();
	let currentBranch = branchId;
	let upper = parent.seq;
	let selectedTipSeq = 0;
	while (true) {
		assertSegmentIdentity(context, currentBranch);
		if (seenBranches.has(currentBranch)) corruption("Branch base chain contains a cycle or repeat");
		seenBranches.add(currentBranch);
		const metadata = meta(context, currentBranch);
		if (
			metadata.branch_id !== currentBranch ||
			typeof metadata.tip_entry_id !== "string" ||
			!Number.isSafeInteger(metadata.tip_seq) ||
			(metadata.tip_seq as number) < 1 ||
			(metadata.base_branch_id !== null && typeof metadata.base_branch_id !== "string") ||
			(metadata.base_seq !== null &&
				(!Number.isSafeInteger(metadata.base_seq) || (metadata.base_seq as number) < 1)) ||
			(metadata.base_branch_id === null) !== (metadata.base_seq === null)
		)
			corruption("Invalid branch metadata");
		if (selectedTipSeq === 0) selectedTipSeq = metadata.tip_seq as number;
		if (upper > (metadata.tip_seq as number)) corruption("Branch interval exceeds its tip");
		const rows = context.db.prepare(MATERIALIZE_SEGMENT_SQL).all<BranchEntryRow>(context.sessionId, currentBranch);
		if (rows.length === 0) corruption("Branch segment has no rows");
		const decoded = rows.map((row) => {
			if (row.branch_id !== currentBranch) corruption("Foreign branch membership row");
			return decode(row);
		});
		const baseSeq = metadata.base_seq as number | null;
		let previousSeq = baseSeq ?? 0;
		const localIds = new Set<string>();
		for (const entry of decoded) {
			if (entry.seq <= previousSeq || entry.seq > (metadata.tip_seq as number) || localIds.has(entry.id))
				corruption("Duplicate, inactive, or unordered branch membership");
			previousSeq = entry.seq;
			localIds.add(entry.id);
		}
		const tip = decoded.at(-1)!;
		if (tip.id !== metadata.tip_entry_id || tip.seq !== metadata.tip_seq)
			corruption("Branch tip metadata disagrees with membership");
		const lower = baseSeq ?? 0;
		const interval = decoded.filter((entry) => entry.seq > lower && entry.seq <= upper);
		if (upper > lower && (interval.length === 0 || interval.at(-1)!.seq !== upper))
			corruption("Branch interval has a missing upper junction");
		for (let index = interval.length - 1; index >= 0; index--) {
			const entry = interval[index]!;
			if (seenEntries.has(entry.id)) corruption("Branch chain contains a duplicate entry");
			seenEntries.add(entry.id);
			result.unshift({ entry, ownerBranchId: currentBranch });
		}
		if (metadata.base_branch_id === null) {
			if (lower !== 0) corruption("Root branch has an invalid base");
			break;
		}
		if ((metadata.base_seq as number) >= upper) corruption("Branch base bounds do not strictly decrease");
		upper = metadata.base_seq as number;
		currentBranch = metadata.base_branch_id as string;
	}
	if (result.length === 0 || result.at(-1)!.entry.id !== parent.id || result.at(-1)!.entry.seq !== parent.seq)
		corruption("Branch does not end at the requested parent");
	for (let index = 0; index < result.length; index++) {
		const entry = result[index]!.entry;
		if (index === 0) {
			if (entry.parentId !== null) corruption("Canonical branch root has a parent");
		} else {
			const previous = result[index - 1]!.entry;
			if (entry.parentId !== previous.id || entry.seq <= previous.seq)
				corruption("Canonical branch has a gap or invalid parent link");
		}
	}
	return { branchId, tipSeq: selectedTipSeq, entries: result };
}

export function resolveParentBranch(context: TransactionEngineContext, parent: Entry): MaterializedBranch {
	const candidates = context.db
		.prepare(PARENT_CANDIDATES_SQL)
		.all<{ branch_id: unknown }>(context.sessionId, parent.id);
	if (candidates.length === 0) corruption("Committed parent has no branch projection");
	const materialized = candidates.map((candidate) => {
		return materialize(context, candidate.branch_id as string, parent);
	});
	const canonical = materialized[0]!;
	for (const candidate of materialized.slice(1)) {
		if (
			candidate.entries.length !== canonical.entries.length ||
			candidate.entries.some((item, index) => !sameStructure(item.entry, canonical.entries[index]!.entry))
		)
			corruption("Physical parent candidates disagree");
	}
	return materialized.sort((left, right) => {
		const byTip = right.tipSeq - left.tipSeq;
		if (byTip !== 0) return byTip;
		return left.branchId < right.branchId ? -1 : left.branchId > right.branchId ? 1 : 0;
	})[0]!;
}

export function branchEntryIdentity(entry: Entry): readonly [string, number, EntryType] {
	return [entry.id, entry.seq, entry.type];
}
