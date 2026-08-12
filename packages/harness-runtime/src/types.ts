import type { Message } from "@earendil-works/pi-ai";
import type { EntryCursor, IdGenerator, SessionStats } from "@nguyenphutrong/pi-session-storage";

export const CURRENT_STORAGE_VERSION = 1;

export interface SessionMetadata {
	readonly id: string;
	readonly createdAt: number;
	readonly storageVersion: number;
	readonly parentSessionId?: string;
}

export interface MessageEntry {
	readonly id: string;
	readonly parentId: string | null;
	readonly seq: number;
	readonly timestamp: number;
	readonly type: "message";
	readonly message: Message;
}

export interface EntryQuery {
	type?: "message";
	order?: "newestFirst" | "oldestFirst";
	limit?: number;
	cursor?: EntryCursor;
}

export interface BranchBounds {
	start?: string;
	stopAtType?: "message";
	stopAtId?: string;
}

export interface SessionTree {
	getLeafId(): Promise<string | null>;
	getEntry(id: string): Promise<MessageEntry | undefined>;
	getEntries(ids: string[]): Promise<ReadonlyMap<string, MessageEntry>>;
	getStats(): Promise<SessionStats>;
	findEntries(query?: EntryQuery): Promise<MessageEntry[]>;
	findEntry(query?: EntryQuery): Promise<MessageEntry | undefined>;
	findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<MessageEntry[]>;
	findEntryOnBranch(query?: EntryQuery & BranchBounds): Promise<MessageEntry | undefined>;
	appendMessage(message: Message): Promise<string>;
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
