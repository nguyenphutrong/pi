import type { Message } from "@earendil-works/pi-ai";
import type { EntryCursor, IdGenerator, JsonValue, SessionStats } from "@nguyenphutrong/pi-session-storage";

export const CURRENT_STORAGE_VERSION = 1;

export interface SessionMetadata {
	readonly id: string;
	readonly createdAt: number;
	readonly storageVersion: number;
	readonly parentSessionId?: string;
}

export interface EntryBase {
	readonly id: string;
	readonly parentId: string | null;
	readonly seq: number;
	readonly timestamp: number;
}

export interface MessageEntry extends EntryBase {
	readonly type: "message";
	readonly message: Message;
}

export interface CustomEntry extends EntryBase {
	readonly type: "custom";
	readonly customType: string;
	readonly data?: JsonValue;
}

export type Entry = MessageEntry | CustomEntry;
export type ProjectableCustomEntry = Omit<CustomEntry, "seq" | "timestamp">;
export type EntryProjector = (entry: ProjectableCustomEntry) => Message[] | undefined | Promise<Message[] | undefined>;

export interface EntryQuery {
	type?: Entry["type"];
	customType?: string;
	order?: "newestFirst" | "oldestFirst";
	limit?: number;
	cursor?: EntryCursor;
}

export interface BranchBounds {
	start?: string;
	stopAtType?: Entry["type"];
	stopAtId?: string;
}

export interface SessionTree {
	getLeafId(): Promise<string | null>;
	getEntry(id: string): Promise<Entry | undefined>;
	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>>;
	getStats(): Promise<SessionStats>;
	findEntries(query?: EntryQuery): Promise<Entry[]>;
	findEntry(query?: EntryQuery): Promise<Entry | undefined>;
	findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry[]>;
	findEntryOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry | undefined>;
	appendMessage(message: Message): Promise<string>;
	appendCustomEntry(customType: string, data?: JsonValue): Promise<string>;
}

export interface Session extends SessionTree {
	readonly metadata: SessionMetadata;
	readonly idGenerator: IdGenerator;
	close(): Promise<void>;
	projectBuiltinContext(): Promise<Message[]>;
}

export type SessionErrorCode =
	| "not_found"
	| "active"
	| "metadata_mismatch"
	| "storage_version_newer"
	| "storage_version_older"
	| "invalid_metadata"
	| "invalid_message"
	| "invalid_query"
	| "corruption"
	| "closed"
	| "storage";

export class SessionError extends Error {
	readonly code: SessionErrorCode;

	constructor(code: SessionErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionError";
		this.code = code;
	}
}
