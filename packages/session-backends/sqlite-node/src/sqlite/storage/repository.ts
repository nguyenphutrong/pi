import { createIdGenerator, isUuidV7, type Transaction } from "@nguyenphutrong/pi-session-storage";
import { initializeSqliteSchema, SQLITE_SCHEMA_VERSION } from "../schema.ts";
import type { SqliteDatabase, SqliteDatabaseFactory } from "../types.ts";
import { SqliteFileQueue } from "./file-queue.ts";
import { type SqliteSessionMetadata, SqliteStorageHandle, type SqliteStorageSession } from "./handle.ts";
import { nativeTimerFactory, type TimerFactory } from "./lifecycle.ts";
import { type PreparedTransaction, prepareTransaction } from "./prepared-transaction.ts";
import {
	acquireSqliteSession,
	createSqliteSession,
	deleteSqliteSession,
	repairSqliteBranchProjection,
	SqliteEngineError,
} from "./transaction-engine.ts";

export type SqliteRepositoryErrorCode =
	| "validation"
	| "duplicate"
	| "missing"
	| "local_ownership"
	| "busy"
	| "fence_exhausted"
	| "version_mismatch"
	| "metadata_mismatch"
	| "closed";

export class SqliteRepositoryError extends Error {
	readonly code: SqliteRepositoryErrorCode;
	constructor(code: SqliteRepositoryErrorCode, message: string) {
		super(message);
		this.name = "SqliteRepositoryError";
		this.code = code;
	}
}

export interface SqliteRepositoryOptions {
	readonly factory: SqliteDatabaseFactory;
	readonly path: string;
	readonly now?: () => number;
	readonly ownerId?: () => string;
	readonly leaseTtlMs?: number;
	readonly heartbeatMs?: number;
	readonly timers?: TimerFactory;
}

export interface SqliteCreateOptions {
	readonly id?: string;
	readonly parentSessionId?: string;
	readonly initialTransaction?: Transaction;
}

function plain(value: unknown, names: readonly string[], label: string): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	)
		throw new SqliteRepositoryError("validation", `${label} must be a plain object`);
	if (
		Object.getOwnPropertySymbols(value).length ||
		Object.getOwnPropertyNames(value).length !== Object.keys(value).length
	)
		throw new SqliteRepositoryError("validation", `${label} has unsupported properties`);
	for (const key of Object.getOwnPropertyNames(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!names.includes(key) || !descriptor || !("value" in descriptor))
			throw new SqliteRepositoryError("validation", `${label} has unsupported property ${key}`);
	}
	return value as Record<string, unknown>;
}

function sessionId(value: unknown, label: string): string {
	if (typeof value !== "string" || !isUuidV7(value))
		throw new SqliteRepositoryError("validation", `${label} must be a UUIDv7`);
	return value;
}

export class SqliteStorageRepository {
	readonly #queue = new SqliteFileQueue();
	readonly #now: () => number;
	readonly #ownerId: () => string;
	readonly #ttlMs: number;
	readonly #heartbeatMs: number;
	readonly #timers: TimerFactory;
	readonly #sessionId: () => string;
	readonly #reservations = new Set<string>();
	readonly #active = new Map<string, SqliteStorageHandle>();
	#db: SqliteDatabase | undefined;
	#sealed = false;
	#initError: unknown;
	#closePromise: Promise<void> | undefined;

	constructor(options: SqliteRepositoryOptions) {
		const input = plain(
			options,
			["factory", "path", "now", "ownerId", "leaseTtlMs", "heartbeatMs", "timers"],
			"repository options",
		);
		if (typeof input.path !== "string" || input.path.length === 0)
			throw new SqliteRepositoryError("validation", "path must be non-empty");
		if (
			input.factory === null ||
			typeof input.factory !== "object" ||
			typeof (input.factory as { open?: unknown }).open !== "function"
		)
			throw new SqliteRepositoryError("validation", "factory.open must be a function");
		if (options.now !== undefined && typeof options.now !== "function")
			throw new SqliteRepositoryError("validation", "now must be a function");
		if (options.ownerId !== undefined && typeof options.ownerId !== "function")
			throw new SqliteRepositoryError("validation", "ownerId must be a function");
		if (
			options.timers !== undefined &&
			(typeof options.timers.schedule !== "function" || typeof options.timers.cancel !== "function")
		)
			throw new SqliteRepositoryError("validation", "timers must provide schedule and cancel");
		if (!Number.isSafeInteger(options.leaseTtlMs ?? 30_000) || (options.leaseTtlMs ?? 30_000) <= 0)
			throw new SqliteRepositoryError("validation", "leaseTtlMs must be a positive safe integer");
		if (
			!Number.isSafeInteger(options.heartbeatMs ?? 10_000) ||
			(options.heartbeatMs ?? 10_000) <= 0 ||
			(options.heartbeatMs ?? 10_000) >= (options.leaseTtlMs ?? 30_000)
		)
			throw new SqliteRepositoryError("validation", "heartbeatMs must be positive and less than leaseTtlMs");
		this.#now = options.now ?? Date.now;
		const ownerIds = createIdGenerator();
		this.#ownerId = options.ownerId ?? (() => ownerIds.next());
		const sessionIds = createIdGenerator();
		this.#sessionId = () => sessionIds.next();
		this.#ttlMs = options.leaseTtlMs ?? 30_000;
		this.#heartbeatMs = options.heartbeatMs ?? 10_000;
		this.#timers = options.timers ?? nativeTimerFactory;
		const initialization = this.#queue.enqueue(async () => {
			try {
				this.#db = await options.factory.open(options.path);
				initializeSqliteSchema(this.#db);
			} catch (error) {
				this.#initError = error;
				throw error;
			}
		});
		void initialization.catch(() => undefined);
	}

	create(options: SqliteCreateOptions): Promise<SqliteStorageSession> {
		try {
			this.#admit();
			const input = plain(options, ["id", "parentSessionId", "initialTransaction"], "create options");
			const id = input.id === undefined ? this.#sessionId() : sessionId(input.id, "id");
			const parentSessionId =
				input.parentSessionId === undefined ? undefined : sessionId(input.parentSessionId, "parentSessionId");
			const ownerId = this.#newOwner();
			const initial: PreparedTransaction | undefined =
				input.initialTransaction === undefined
					? undefined
					: prepareTransaction(input.initialTransaction as Transaction);
			this.#reserve(id);
			return this.#queue
				.enqueue(() => {
					const db = this.#database();
					if (this.#sealed) throw new SqliteRepositoryError("closed", "Repository is closed");
					const created = createSqliteSession(
						db,
						{
							id,
							storageVersion: SQLITE_SCHEMA_VERSION,
							...(parentSessionId ? { parentSessionId } : {}),
						},
						ownerId,
						this.#now,
						this.#ttlMs,
						initial,
					);
					return this.#register(created.metadata, ownerId, created.fence);
				})
				.catch((error) => {
					throw this.#mapEngineError(error);
				})
				.finally(() => this.#reservations.delete(id));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	open(metadata: SqliteSessionMetadata): Promise<SqliteStorageSession> {
		try {
			this.#admit();
			const input = plain(metadata, ["id", "createdAt", "storageVersion", "parentSessionId"], "metadata");
			const id = sessionId(input.id, "metadata.id");
			if (
				!Object.hasOwn(input, "createdAt") ||
				!Number.isSafeInteger(input.createdAt) ||
				(input.createdAt as number) < 0
			)
				throw new SqliteRepositoryError("validation", "Metadata timestamp is invalid");
			if (!Object.hasOwn(input, "storageVersion") || input.storageVersion !== SQLITE_SCHEMA_VERSION)
				throw new SqliteRepositoryError("version_mismatch", "Metadata is not current");
			const parentSessionId =
				input.parentSessionId === undefined
					? undefined
					: sessionId(input.parentSessionId, "metadata.parentSessionId");
			const ownerId = this.#newOwner();
			this.#reserve(id);
			return this.#queue
				.enqueue(() => {
					const db = this.#database();
					if (this.#sealed) throw new SqliteRepositoryError("closed", "Repository is closed");
					const exact = {
						id,
						createdAt: input.createdAt as number,
						storageVersion: input.storageVersion as number,
						...(parentSessionId ? { parentSessionId } : {}),
					};
					const fence = acquireSqliteSession(db, exact, ownerId, this.#now, this.#ttlMs);
					return this.#register(exact, ownerId, fence);
				})
				.catch((error) => {
					throw this.#mapEngineError(error);
				})
				.finally(() => this.#reservations.delete(id));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	list(): Promise<SqliteSessionMetadata[]> {
		try {
			this.#admit();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#queue.enqueue(() =>
			this.#database()
				.prepare(
					"SELECT session_id, created_at, parent_session_id, storage_version, metadata FROM sessions ORDER BY created_at, session_id",
				)
				.all<{
					session_id: string;
					created_at: number;
					parent_session_id: string | null;
					storage_version: number;
					metadata: string | null;
				}>()
				.map((row) => {
					if (
						!isUuidV7(row.session_id) ||
						!Number.isSafeInteger(row.created_at) ||
						row.created_at < 0 ||
						(row.parent_session_id !== null && !isUuidV7(row.parent_session_id))
					)
						throw new SqliteRepositoryError("validation", `Invalid canonical session ${row.session_id}`);
					if (row.metadata !== null || row.storage_version !== SQLITE_SCHEMA_VERSION)
						throw new SqliteRepositoryError("version_mismatch", `Unsupported session ${row.session_id}`);
					return Object.freeze({
						id: row.session_id,
						createdAt: row.created_at,
						storageVersion: row.storage_version,
						...(row.parent_session_id ? { parentSessionId: row.parent_session_id } : {}),
					});
				}),
		);
	}

	delete(metadata: SqliteSessionMetadata): Promise<{ deleted: boolean }> {
		try {
			this.#admit();
			const input = plain(metadata, ["id", "createdAt", "storageVersion", "parentSessionId"], "metadata");
			const id = sessionId(input.id, "metadata.id");
			if (!Number.isSafeInteger(input.createdAt) || (input.createdAt as number) < 0)
				throw new SqliteRepositoryError("validation", "Metadata timestamp is invalid");
			if (input.storageVersion !== SQLITE_SCHEMA_VERSION)
				throw new SqliteRepositoryError("version_mismatch", "Metadata is not current");
			const parentSessionId =
				input.parentSessionId === undefined
					? undefined
					: sessionId(input.parentSessionId, "metadata.parentSessionId");
			this.#admit();
			if (this.#reservations.has(id) || this.#active.has(id))
				throw new SqliteRepositoryError("local_ownership", `Session ${id} is locally owned`);
			const ownerId = this.#newOwner();
			return this.#queue
				.enqueue(() => ({
					deleted: deleteSqliteSession(
						this.#database(),
						{
							id,
							createdAt: input.createdAt as number,
							storageVersion: input.storageVersion as number,
							...(parentSessionId ? { parentSessionId } : {}),
						},
						ownerId,
						this.#now,
						this.#ttlMs,
					),
				}))
				.catch((error) => {
					throw this.#mapEngineError(error);
				});
		} catch (error) {
			return Promise.reject(error);
		}
	}

	repairBranchProjection(metadata: SqliteSessionMetadata): Promise<void> {
		try {
			this.#admit();
			const input = plain(metadata, ["id", "createdAt", "storageVersion", "parentSessionId"], "metadata");
			const id = sessionId(input.id, "metadata.id");
			if (!Number.isSafeInteger(input.createdAt) || (input.createdAt as number) < 0)
				throw new SqliteRepositoryError("validation", "Metadata timestamp is invalid");
			if (input.storageVersion !== SQLITE_SCHEMA_VERSION)
				throw new SqliteRepositoryError("version_mismatch", "Metadata is not current");
			const parentSessionId =
				input.parentSessionId === undefined
					? undefined
					: sessionId(input.parentSessionId, "metadata.parentSessionId");
			const ownerId = this.#newOwner();
			this.#reserve(id);
			return this.#queue
				.enqueue(() => {
					if (this.#sealed) throw new SqliteRepositoryError("closed", "Repository is closed");
					repairSqliteBranchProjection(
						this.#database(),
						{
							id,
							createdAt: input.createdAt as number,
							storageVersion: input.storageVersion as number,
							...(parentSessionId ? { parentSessionId } : {}),
						},
						ownerId,
						this.#now,
						this.#ttlMs,
					);
				})
				.catch((error) => {
					throw this.#mapEngineError(error);
				})
				.finally(() => this.#reservations.delete(id));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#sealed = true;
		const tracked = new Set<SqliteStorageHandle>();
		const closes: Promise<unknown>[] = [];
		const closeUntracked = (): void => {
			for (const handle of this.#active.values()) {
				if (tracked.has(handle)) continue;
				tracked.add(handle);
				closes.push(
					handle.close().then(
						() => undefined,
						(error) => error,
					),
				);
			}
		};
		closeUntracked();
		this.#closePromise = (async () => {
			while (this.#reservations.size || this.#active.size) {
				await this.#queue.drain();
				closeUntracked();
			}
			const closeErrors = await Promise.all(closes);
			let dbError: unknown;
			await this.#queue.enqueue(() => {
				try {
					this.#db?.close();
				} catch (error) {
					dbError = error;
				}
			});
			if (this.#initError) throw this.#initError;
			const handleError = closeErrors.find((error) => error !== undefined);
			if (handleError !== undefined) throw handleError;
			if (dbError) throw dbError;
		})();
		return this.#closePromise;
	}

	#register(metadata: SqliteSessionMetadata, ownerId: string, fence: number): SqliteStorageHandle {
		let handle: SqliteStorageHandle;
		handle = new SqliteStorageHandle({
			db: this.#database(),
			queue: this.#queue,
			lease: { sessionId: metadata.id, ownerId, fence },
			metadata,
			now: this.#now,
			ttlMs: this.#ttlMs,
			heartbeatMs: this.#heartbeatMs,
			timers: this.#timers,
			onClosed: () => {
				if (this.#active.get(metadata.id) === handle) this.#active.delete(metadata.id);
			},
		});
		this.#active.set(metadata.id, handle);
		return handle;
	}

	#reserve(id: string): void {
		this.#admit();
		if (this.#reservations.has(id) || this.#active.has(id))
			throw new SqliteRepositoryError("local_ownership", `Session ${id} is locally owned`);
		this.#reservations.add(id);
	}
	#admit(): void {
		if (this.#sealed) throw new SqliteRepositoryError("closed", "Repository is closed");
		if (this.#initError) throw new SqliteRepositoryError("closed", "Repository is closed");
	}
	#database(): SqliteDatabase {
		if (this.#initError) throw this.#initError;
		if (!this.#db) throw new Error("SQLite initialization has not completed");
		return this.#db;
	}
	#newOwner(): string {
		const owner = this.#ownerId();
		if (typeof owner !== "string" || owner.length === 0 || owner.includes("\0"))
			throw new SqliteRepositoryError("validation", "Owner id must be non-empty and contain no NUL");
		return owner;
	}
	#mapEngineError(error: unknown): unknown {
		if (!(error instanceof SqliteEngineError)) return error;
		const code: SqliteRepositoryErrorCode =
			error.code === "invalid_clock" || error.code === "invalid_lease" ? "validation" : error.code;
		return new SqliteRepositoryError(code, error.message);
	}
}
