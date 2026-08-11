import type { Message } from "@earendil-works/pi-ai";
import {
	assertRegister,
	createIdGenerator,
	type EntryScan,
	type IdGenerator,
	isUuidV7,
	type Storage,
	StorageError,
} from "@earendil-works/pi-session-storage";
import { decodeMessageEntry, encodeMessage } from "./codec.ts";
import {
	type BranchBounds,
	type EntryQuery,
	type MessageEntry,
	type Session,
	SessionError,
	type SessionMetadata,
} from "./types.ts";

const LEAF_NAMESPACE = "lane.leaf";
const STATE_NAMESPACE = "lane.state";
const MAIN = "main";

function storageFailure(error: unknown): SessionError {
	if (error instanceof SessionError) return error;
	if (error instanceof StorageError && error.code === "closed")
		return new SessionError("closed", error.message, error);
	if (error instanceof StorageError && (error.code === "invalid_query" || error.code === "invalid_id"))
		return new SessionError("invalid_query", error.message, error);
	return new SessionError(
		error instanceof StorageError && error.code === "corruption" ? "corruption" : "storage",
		"Session storage operation failed",
		error,
	);
}

function isExactDataObject(value: unknown, allowedFields: ReadonlySet<string>): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !allowedFields.has(key)) return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) return false;
	}
	return true;
}

const GLOBAL_QUERY_FIELDS = new Set(["type", "order", "limit", "cursor"]);
const BRANCH_QUERY_FIELDS = new Set([...GLOBAL_QUERY_FIELDS, "start", "stopAtType", "stopAtId"]);
const CURSOR_FIELDS = new Set(["seq"]);

function validateQuery(query: unknown, branch: boolean): asserts query is EntryQuery & Partial<BranchBounds> {
	if (!isExactDataObject(query, branch ? BRANCH_QUERY_FIELDS : GLOBAL_QUERY_FIELDS))
		throw new SessionError("invalid_query", "Query must be a plain object with only supported fields");
	if (query.type !== undefined && query.type !== "message")
		throw new SessionError("invalid_query", 'type must be "message"');
	if (query.order !== undefined && query.order !== "newestFirst" && query.order !== "oldestFirst")
		throw new SessionError("invalid_query", "order must be newestFirst or oldestFirst");
	if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || (query.limit as number) <= 0))
		throw new SessionError("invalid_query", "limit must be a positive safe integer");
	if (query.cursor !== undefined) {
		if (
			!isExactDataObject(query.cursor, CURSOR_FIELDS) ||
			!Object.hasOwn(query.cursor, "seq") ||
			!Number.isSafeInteger(query.cursor.seq) ||
			(query.cursor.seq as number) < 0
		)
			throw new SessionError("invalid_query", "cursor must contain exactly one non-negative safe integer seq");
	}
	if (!branch) return;
	if (query.start !== undefined && (typeof query.start !== "string" || !isUuidV7(query.start)))
		throw new SessionError("invalid_query", "start must be a UUIDv7");
	if (query.stopAtType !== undefined && query.stopAtType !== "message")
		throw new SessionError("invalid_query", 'stopAtType must be "message"');
	if (query.stopAtId !== undefined && (typeof query.stopAtId !== "string" || !isUuidV7(query.stopAtId)))
		throw new SessionError("invalid_query", "stopAtId must be a UUIDv7");
}

function decodeMainLeafRegister(candidate: unknown): string | null {
	assertRegister(candidate);
	if (candidate.namespace !== LEAF_NAMESPACE || candidate.key !== MAIN)
		throw new SessionError("corruption", "Main leaf register has the wrong identity");
	if (candidate.value !== null && (typeof candidate.value !== "string" || !isUuidV7(candidate.value)))
		throw new SessionError("corruption", "Main leaf must be null or a UUIDv7 entry id");
	return candidate.value;
}

function decodeIdleMainStateRegister(candidate: unknown): void {
	assertRegister(candidate);
	if (candidate.namespace !== STATE_NAMESPACE || candidate.key !== MAIN)
		throw new SessionError("corruption", "Main lane state register has the wrong identity");
	const value = candidate.value;
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== 2 ||
		!Object.hasOwn(value, "currentOperationId") ||
		!Object.hasOwn(value, "pendingNextRun") ||
		value.currentOperationId !== null ||
		!Array.isArray(value.pendingNextRun) ||
		value.pendingNextRun.length !== 0
	)
		throw new SessionError("corruption", "Main lane must be idle and empty");
}

export async function validateMainLane(storage: Storage): Promise<void> {
	try {
		const [leafRegisters, stateRegisters] = await Promise.all([
			storage.listRegisters(LEAF_NAMESPACE),
			storage.listRegisters(STATE_NAMESPACE),
		]);
		if (leafRegisters.length !== 1)
			throw new SessionError("corruption", "Exactly one main leaf register is required");
		if (stateRegisters.length !== 1)
			throw new SessionError("corruption", "Exactly one main lane state register is required");
		const leaf = decodeMainLeafRegister(leafRegisters[0]);
		if (typeof leaf === "string") {
			const entry = (await storage.getEntries([leaf])).get(leaf);
			if (!entry) throw new SessionError("corruption", "Main leaf references a missing entry");
			decodeMessageEntry(entry);
		}
		decodeIdleMainStateRegister(stateRegisters[0]);
	} catch (error) {
		throw storageFailure(error);
	}
}

export class MemorySession implements Session {
	readonly metadata: SessionMetadata;
	readonly idGenerator: IdGenerator;
	readonly #storage: Storage;
	readonly #release: () => void;
	#sealed = false;
	#mutationLine: Promise<void> = Promise.resolve();
	#closePromise: Promise<void> | undefined;

	constructor(metadata: SessionMetadata, storage: Storage, release: () => void) {
		this.metadata = metadata;
		this.#storage = storage;
		this.#release = release;
		this.idGenerator = createIdGenerator();
	}

	#assertOpen(): void {
		if (this.#sealed) throw new SessionError("closed", "Session is closed");
	}

	async getLeafId(): Promise<string | null> {
		this.#assertOpen();
		try {
			return decodeMainLeafRegister(await this.#storage.getRegister(LEAF_NAMESPACE, MAIN));
		} catch (error) {
			throw storageFailure(error);
		}
	}

	async getEntry(id: string): Promise<MessageEntry | undefined> {
		this.#assertOpen();
		return (await this.getEntries([id])).get(id);
	}

	async getEntries(ids: string[]): Promise<ReadonlyMap<string, MessageEntry>> {
		this.#assertOpen();
		try {
			const stored = await this.#storage.getEntries(ids);
			const result = new Map<string, MessageEntry>();
			for (const [id, entry] of stored) result.set(id, decodeMessageEntry(entry));
			return result;
		} catch (error) {
			throw storageFailure(error);
		}
	}

	async getStats() {
		this.#assertOpen();
		try {
			return Object.freeze(await this.#storage.getStats());
		} catch (error) {
			throw storageFailure(error);
		}
	}

	async findEntries(query: EntryQuery = {}): Promise<MessageEntry[]> {
		this.#assertOpen();
		validateQuery(query, false);
		const scan: EntryScan = { type: "message", order: query.order === "oldestFirst" ? "asc" : "desc" };
		if (query.limit !== undefined) scan.limit = query.limit;
		if (query.cursor !== undefined) {
			if (query.order === "oldestFirst") {
				if (query.cursor.seq === Number.MAX_SAFE_INTEGER) return [];
				scan.fromSeq = query.cursor.seq + 1;
			} else if (query.cursor.seq > 0) scan.toSeq = query.cursor.seq - 1;
			else return [];
		}
		try {
			return (await this.#storage.scanEntries(scan)).map(decodeMessageEntry);
		} catch (error) {
			throw storageFailure(error);
		}
	}

	async findEntry(query: EntryQuery = {}): Promise<MessageEntry | undefined> {
		this.#assertOpen();
		validateQuery(query, false);
		return (await this.findEntries({ ...query, limit: 1 }))[0];
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds = {}): Promise<MessageEntry[]> {
		this.#assertOpen();
		validateQuery(query, true);
		const start = query.start ?? (await this.getLeafId());
		if (start === null) return [];
		try {
			return (
				await this.#storage.scanBranch({
					start,
					type: "message",
					order: query.order ?? "newestFirst",
					...(query.stopAtType === undefined ? {} : { stopAtType: query.stopAtType }),
					...(query.stopAtId === undefined ? {} : { stopAtId: query.stopAtId }),
					...(query.limit === undefined ? {} : { limit: query.limit }),
					...(query.cursor === undefined ? {} : { cursor: query.cursor }),
				})
			).map(decodeMessageEntry);
		} catch (error) {
			throw storageFailure(error);
		}
	}

	async findEntryOnBranch(query: EntryQuery & BranchBounds = {}): Promise<MessageEntry | undefined> {
		this.#assertOpen();
		validateQuery(query, true);
		return (await this.findEntriesOnBranch({ ...query, limit: 1 }))[0];
	}

	appendMessage(message: Message): Promise<string> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		let payload: ReturnType<typeof encodeMessage>;
		let id: string;
		try {
			payload = encodeMessage(message);
			id = this.idGenerator.next();
		} catch (error) {
			return Promise.reject(storageFailure(error));
		}
		const operation = this.#mutationLine.then(async () => {
			const [leaf, state] = await Promise.all([
				this.#storage.getRegister(LEAF_NAMESPACE, MAIN),
				this.#storage.getRegister(STATE_NAMESPACE, MAIN),
			]);
			const leafId = decodeMainLeafRegister(leaf);
			decodeIdleMainStateRegister(state);
			await this.#storage.commit({
				writes: [
					{ kind: "entry", entry: { id, parentId: leafId, type: "message", payload } },
					{ kind: "register", op: "set", namespace: LEAF_NAMESPACE, key: MAIN, value: id },
				],
			});
		});
		this.#mutationLine = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation
			.then(() => id)
			.catch((error) => {
				throw storageFailure(error);
			});
	}

	async projectBuiltinContext(): Promise<Message[]> {
		this.#assertOpen();
		const entries = await this.findEntriesOnBranch({ order: "oldestFirst" });
		return entries.flatMap(({ message }) =>
			message.role === "assistant" && ["error", "aborted", "deferred"].includes(message.stopReason)
				? []
				: [structuredClone(message)],
		);
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#sealed = true;
		this.#closePromise = this.#mutationLine.then(() => this.#storage.close()).finally(this.#release);
		return this.#closePromise;
	}
}
