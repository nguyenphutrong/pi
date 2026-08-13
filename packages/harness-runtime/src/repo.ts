import {
	createNodeSqliteFactory,
	SqliteRepositoryError,
	SqliteStorageRepository,
} from "@nguyenphutrong/pi-session-sqlite";
import { createIdGenerator, isUuidV7, MemoryStorageState, type Transaction } from "@nguyenphutrong/pi-session-storage";
import { StoredSession, validateMainLane } from "./session.ts";
import { CURRENT_STORAGE_VERSION, type Session, SessionError, type SessionMetadata } from "./types.ts";

interface CatalogItem {
	metadata: SessionMetadata;
	state: MemoryStorageState;
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

const CREATE_OPTION_FIELDS = new Set(["id", "parentSessionId"]);
const METADATA_FIELDS = new Set(["id", "createdAt", "storageVersion", "parentSessionId"]);
const SQLITE_REPO_OPTION_FIELDS = new Set(["path"]);

function validateCreateOptions(options: unknown): asserts options is { id?: string; parentSessionId?: string } {
	if (!isExactDataObject(options, CREATE_OPTION_FIELDS))
		throw new SessionError("invalid_metadata", "Create options must be a plain object with only supported fields");
	if (options.id !== undefined && (typeof options.id !== "string" || !isUuidV7(options.id)))
		throw new SessionError("invalid_metadata", "Session id must be a UUIDv7");
	if (
		options.parentSessionId !== undefined &&
		(typeof options.parentSessionId !== "string" || !isUuidV7(options.parentSessionId))
	)
		throw new SessionError("invalid_metadata", "Parent session id must be a UUIDv7");
}

function validateMetadata(metadata: unknown): asserts metadata is SessionMetadata {
	if (
		!isExactDataObject(metadata, METADATA_FIELDS) ||
		!Object.hasOwn(metadata, "id") ||
		!Object.hasOwn(metadata, "createdAt") ||
		!Object.hasOwn(metadata, "storageVersion")
	)
		throw new SessionError("invalid_metadata", "Session metadata must be a plain exact object");
	if (typeof metadata.id !== "string" || !isUuidV7(metadata.id))
		throw new SessionError("invalid_metadata", "Session id must be a UUIDv7");
	if (!Number.isSafeInteger(metadata.createdAt) || (metadata.createdAt as number) < 0)
		throw new SessionError("invalid_metadata", "createdAt must be a non-negative safe integer");
	if (!Number.isSafeInteger(metadata.storageVersion) || (metadata.storageVersion as number) < 0)
		throw new SessionError("invalid_metadata", "storageVersion must be a non-negative safe integer");
	if (
		metadata.parentSessionId !== undefined &&
		(typeof metadata.parentSessionId !== "string" || !isUuidV7(metadata.parentSessionId))
	)
		throw new SessionError("invalid_metadata", "Parent session id must be a UUIDv7");
}

function metadataCopy(metadata: SessionMetadata): SessionMetadata {
	return Object.freeze(structuredClone(metadata));
}

function sameMetadata(left: SessionMetadata, right: SessionMetadata): boolean {
	return (
		left.id === right.id &&
		left.createdAt === right.createdAt &&
		left.storageVersion === right.storageVersion &&
		left.parentSessionId === right.parentSessionId
	);
}

function initialMainTransaction(): Transaction {
	return {
		writes: [
			{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: null, pendingNextRun: [] },
			},
		],
	};
}

function validateCurrentVersion(metadata: SessionMetadata): void {
	if (metadata.storageVersion > CURRENT_STORAGE_VERSION)
		throw new SessionError("storage_version_newer", "Session storage version is newer than this runtime");
	if (metadata.storageVersion < CURRENT_STORAGE_VERSION)
		throw new SessionError("storage_version_older", "Session storage migrations are not available");
}

export class MemorySessionRepo {
	readonly #catalog = new Map<string, CatalogItem>();
	readonly #active = new Map<string, symbol>();

	#release(id: string, token: symbol): void {
		if (this.#active.get(id) === token) this.#active.delete(id);
	}

	async create(options: { id?: string; parentSessionId?: string } = {}): Promise<Session> {
		validateCreateOptions(options);
		const id = options.id ?? createIdGenerator().next();
		if (this.#catalog.has(id) || this.#active.has(id))
			throw new SessionError("metadata_mismatch", `Session already exists: ${id}`);
		const token = Symbol(id);
		this.#active.set(id, token);
		const metadata = metadataCopy({
			id,
			createdAt: Date.now(),
			storageVersion: CURRENT_STORAGE_VERSION,
			...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
		});
		const state = new MemoryStorageState();
		const storage = state.createStorage();
		try {
			await storage.commit(initialMainTransaction());
			this.#catalog.set(id, { metadata, state });
			return new StoredSession(metadataCopy(metadata), storage, () => this.#release(id, token));
		} catch (error) {
			try {
				await storage.close();
			} finally {
				this.#release(id, token);
			}
			throw error instanceof SessionError ? error : new SessionError("storage", "Could not create session", error);
		}
	}

	async open(metadata: SessionMetadata): Promise<Session> {
		validateMetadata(metadata);
		const item = this.#catalog.get(metadata.id);
		if (!item) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		validateCurrentVersion(metadata);
		if (!sameMetadata(metadata, item.metadata))
			throw new SessionError("metadata_mismatch", "Session metadata does not match the repository catalog");
		if (this.#active.has(metadata.id)) throw new SessionError("active", `Session is already active: ${metadata.id}`);
		const token = Symbol(metadata.id);
		this.#active.set(metadata.id, token);
		const storage = item.state.createStorage();
		try {
			await validateMainLane(storage);
			return new StoredSession(metadataCopy(item.metadata), storage, () => this.#release(metadata.id, token));
		} catch (error) {
			try {
				await storage.close();
			} finally {
				this.#release(metadata.id, token);
			}
			throw error;
		}
	}

	async list(): Promise<SessionMetadata[]> {
		return [...this.#catalog.values()].map(({ metadata }) => metadataCopy(metadata));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		validateMetadata(metadata);
		const item = this.#catalog.get(metadata.id);
		if (!item) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		if (!sameMetadata(metadata, item.metadata))
			throw new SessionError("metadata_mismatch", "Session metadata does not match the repository catalog");
		if (this.#active.has(metadata.id)) throw new SessionError("active", `Session is active: ${metadata.id}`);
		this.#catalog.delete(metadata.id);
	}
}

type SqliteRepoOperation = "create" | "open" | "list" | "delete" | "close";

function sqliteRepoFailure(error: unknown, operation: SqliteRepoOperation): SessionError {
	if (error instanceof SessionError) return error;
	if (!(error instanceof SqliteRepositoryError))
		return new SessionError("storage", "SQLite session repository operation failed", error);
	if (error.code === "closed") return new SessionError("closed", error.message, error);
	if (error.code === "fence_exhausted")
		return new SessionError("storage", "SQLite session repository operation failed", error);
	if (operation === "list") return new SessionError("corruption", error.message, error);
	switch (error.code) {
		case "validation":
			if (operation === "create" || operation === "open" || operation === "delete")
				return new SessionError("invalid_metadata", error.message, error);
			break;
		case "version_mismatch":
		case "metadata_mismatch":
			if (operation === "open" || operation === "delete")
				return new SessionError("metadata_mismatch", error.message, error);
			break;
		case "duplicate":
			if (operation === "create") return new SessionError("metadata_mismatch", error.message, error);
			break;
		case "missing":
			if (operation === "create" || operation === "open" || operation === "delete")
				return new SessionError("not_found", error.message, error);
			break;
		case "local_ownership":
			if (operation === "create") return new SessionError("metadata_mismatch", error.message, error);
			if (operation === "open" || operation === "delete") return new SessionError("active", error.message, error);
			break;
		case "busy":
			if (operation === "open" || operation === "delete") return new SessionError("active", error.message, error);
			break;
	}
	return new SessionError("storage", "SQLite session repository operation failed", error);
}

export class SqliteSessionRepo {
	readonly #repository: SqliteStorageRepository;
	#closePromise: Promise<void> | undefined;

	constructor(options: { readonly path: string }) {
		if (
			!isExactDataObject(options, SQLITE_REPO_OPTION_FIELDS) ||
			!Object.hasOwn(options, "path") ||
			typeof options.path !== "string" ||
			options.path.length === 0
		)
			throw new SessionError("invalid_metadata", "SQLite repository options must contain exactly one nonempty path");
		this.#repository = new SqliteStorageRepository({ factory: createNodeSqliteFactory(), path: options.path });
	}

	async create(options: { id?: string; parentSessionId?: string } = {}): Promise<Session> {
		let storage: Awaited<ReturnType<SqliteStorageRepository["create"]>> | undefined;
		try {
			validateCreateOptions(options);
			storage = await this.#repository.create({ ...options, initialTransaction: initialMainTransaction() });
			return new StoredSession(metadataCopy(storage.metadata), storage, () => undefined);
		} catch (error) {
			if (storage) {
				try {
					await storage.close();
				} catch {
					// Preserve the acquisition or session construction failure.
				}
			}
			throw sqliteRepoFailure(error, "create");
		}
	}

	async open(metadata: SessionMetadata): Promise<Session> {
		let storage: Awaited<ReturnType<SqliteStorageRepository["open"]>> | undefined;
		try {
			validateMetadata(metadata);
			validateCurrentVersion(metadata);
			storage = await this.#repository.open(metadata);
			await validateMainLane(storage);
			return new StoredSession(metadataCopy(storage.metadata), storage, () => undefined);
		} catch (error) {
			if (storage) {
				try {
					await storage.close();
				} catch {
					// Preserve the acquisition or validation failure.
				}
			}
			throw sqliteRepoFailure(error, "open");
		}
	}

	async list(): Promise<SessionMetadata[]> {
		try {
			return (await this.#repository.list()).map((metadata) => {
				try {
					validateMetadata(metadata);
					return metadataCopy(metadata);
				} catch (error) {
					throw new SessionError("corruption", "SQLite repository returned invalid metadata", error);
				}
			});
		} catch (error) {
			throw sqliteRepoFailure(error, "list");
		}
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		try {
			validateMetadata(metadata);
			validateCurrentVersion(metadata);
			if (!(await this.#repository.delete(metadata)).deleted)
				throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		} catch (error) {
			throw sqliteRepoFailure(error, "delete");
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closePromise = this.#repository.close().catch((error) => {
			throw sqliteRepoFailure(error, "close");
		});
		return this.#closePromise;
	}
}
