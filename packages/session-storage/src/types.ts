import type { Usage } from "@earendil-works/pi-ai";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type EntryType = "message" | "compaction" | "branch_summary" | "custom";
export type EntryOrder = "newestFirst" | "oldestFirst";

export interface Entry {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: EntryType;
	customType?: string;
	payload?: JsonValue;
}

export type NewEntry = Omit<Entry, "seq" | "timestamp">;

export interface UsageRow {
	id: string;
	seq: number;
	usage: Usage;
	entryId?: string;
	adjustment: boolean;
	details?: JsonValue;
}

export type NewUsageRow = Omit<UsageRow, "seq">;

export interface Register {
	namespace: string;
	key: string;
	value: JsonValue;
	seq: number;
}

export type Write =
	| { kind: "entry"; entry: NewEntry }
	| { kind: "usage"; row: NewUsageRow }
	| { kind: "register"; op: "set"; namespace: string; key: string; value: JsonValue }
	| { kind: "register"; op: "delete"; namespace: string; key: string };

export interface Transaction {
	writes: Write[];
}

export interface CommitResult {
	firstSeq: number;
	seqs: number[];
	timestamp: number;
}

export interface EntryCursor {
	seq: number;
}

export interface EntryScan {
	type?: EntryType;
	customType?: string;
	fromSeq?: number;
	toSeq?: number;
	order?: "asc" | "desc";
	limit?: number;
}

export interface BranchScan {
	start: string;
	stopAtType?: EntryType;
	stopAtId?: string;
	type?: EntryType;
	customType?: string;
	order?: EntryOrder;
	limit?: number;
	cursor?: EntryCursor;
}

export type EntryStructure = Pick<Entry, "id" | "parentId" | "seq" | "timestamp" | "type" | "customType">;

export interface SessionStats {
	messageCount: number;
	usage: Usage;
}

export interface Storage {
	commit(tx: Transaction): Promise<CommitResult>;
	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>>;
	getRegister(namespace: string, key: string): Promise<Register | undefined>;
	listRegisters(namespace: string): Promise<Register[]>;
	scanBranch(query: BranchScan): Promise<Entry[]>;
	scanBranchStructure(query: BranchScan): Promise<EntryStructure[]>;
	scanEntries(query?: EntryScan): Promise<Entry[]>;
	getStats(): Promise<SessionStats>;
	close(): Promise<void>;
}

export type StorageErrorCode =
	| "closed"
	| "invalid_id"
	| "invalid_payload"
	| "invalid_transaction"
	| "invalid_query"
	| "corruption";

export class StorageError extends Error {
	readonly code: StorageErrorCode;

	constructor(code: StorageErrorCode, message: string) {
		super(message);
		this.name = "StorageError";
		this.code = code;
	}
}
