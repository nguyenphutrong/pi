import {
	assertBranchScan,
	assertEntryScan,
	assertIdList,
	assertQueryText,
	type BranchScan,
	type CommitResult,
	type Entry,
	type EntryScan,
	type EntryStructure,
	isUuidV7,
	type Register,
	type SessionStats,
	StorageError,
	type Transaction,
	type UsageRow,
} from "@nguyenphutrong/pi-session-storage";
import type { SqliteDatabase } from "../types.ts";
import { readBranch, readBranchStructure } from "./branch-reader.ts";
import type { SqliteFileQueue } from "./file-queue.ts";
import type { TimerFactory, TimerHandle } from "./lifecycle.ts";
import {
	readEntries,
	readEntryScan,
	readRegister,
	readRegisters,
	readStats,
	readUsageRows,
} from "./ordinary-reader.ts";
import { prepareTransaction } from "./prepared-transaction.ts";
import {
	commitSqliteTransaction,
	isPersistedSqliteCorruption,
	type LeaseIdentity,
	releaseSqliteLease,
	renewSqliteLease,
	SqliteEngineError,
} from "./transaction-engine.ts";

export interface SqliteHandleMetadata {
	readonly id: string;
	readonly createdAt: number;
	readonly storageVersion: number;
	readonly parentSessionId?: string;
}

interface HandleOptions {
	db: SqliteDatabase;
	queue: SqliteFileQueue;
	lease: LeaseIdentity;
	metadata: SqliteHandleMetadata;
	now: () => number;
	ttlMs: number;
	heartbeatMs: number;
	timers: TimerFactory;
	onClosed: () => void;
}

export class SqliteStorageHandle {
	readonly metadata: SqliteHandleMetadata;
	readonly #options: HandleOptions;
	#sealed = false;
	#terminal: unknown;
	#closePromise: Promise<void> | undefined;
	#timer: TimerHandle | undefined;

	constructor(options: HandleOptions) {
		this.#options = options;
		this.metadata = Object.freeze({ ...options.metadata });
		this.#scheduleHeartbeat();
	}

	commit(transaction: Transaction): Promise<CommitResult> {
		try {
			this.#assertOpen();
			const prepared = prepareTransaction(transaction);
			return this.#options.queue.enqueue(() => {
				if (this.#terminal) throw this.#terminal;
				try {
					return commitSqliteTransaction(
						this.#options.db,
						this.#options.lease,
						prepared,
						this.#options.now,
						this.#options.ttlMs,
					);
				} catch (error) {
					if (!(error instanceof StorageError) || error.code === "closed" || isPersistedSqliteCorruption(error))
						this.#latch(error);
					throw error;
				}
			});
		} catch (error) {
			return Promise.reject(error);
		}
	}

	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		return this.#exactRead(ids, "entry", readEntries);
	}

	getUsageRows(ids: string[]): Promise<ReadonlyMap<string, UsageRow>> {
		return this.#exactRead(ids, "usage", readUsageRows);
	}

	getRegister(namespace: string, key: string): Promise<Register | undefined> {
		try {
			this.#assertOpen();
			assertQueryText(namespace, "namespace");
			assertQueryText(key, "key");
			this.#assertRegisterText(namespace, "namespace", false);
			this.#assertRegisterText(key, "key", true);
			return this.#admitRead(() => readRegister(this.#options.db, this.#options.lease.sessionId, namespace, key));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	listRegisters(namespace: string): Promise<Register[]> {
		try {
			this.#assertOpen();
			assertQueryText(namespace, "namespace");
			this.#assertRegisterText(namespace, "namespace", false);
			return this.#admitRead(() => readRegisters(this.#options.db, this.#options.lease.sessionId, namespace));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	scanBranch(query: BranchScan): Promise<Entry[]> {
		return this.#branchRead(query, readBranch);
	}

	scanBranchStructure(query: BranchScan): Promise<EntryStructure[]> {
		return this.#branchRead(query, readBranchStructure);
	}

	scanEntries(query: EntryScan = {}): Promise<Entry[]> {
		try {
			this.#assertOpen();
			assertEntryScan(query);
			if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0))
				throw new StorageError("invalid_query", "limit must be a positive safe integer");
			for (const name of ["fromSeq", "toSeq"] as const)
				if (query[name] !== undefined && (!Number.isSafeInteger(query[name]) || query[name]! < 0))
					throw new StorageError("invalid_query", `${name} must be non-negative`);
			if (query.customType !== undefined && query.type !== "custom")
				throw new StorageError("invalid_query", "customType requires custom entry type");
			const admitted = structuredClone(query);
			return this.#admitRead(() => readEntryScan(this.#options.db, this.#options.lease.sessionId, admitted));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	getStats(): Promise<SessionStats> {
		try {
			this.#assertOpen();
			return this.#admitRead(() => readStats(this.#options.db, this.#options.lease.sessionId));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#sealed = true;
		if (this.#timer) this.#options.timers.cancel(this.#timer);
		this.#timer = undefined;
		this.#closePromise = this.#options.queue
			.enqueue(() => releaseSqliteLease(this.#options.db, this.#options.lease))
			.catch((error) => {
				throw this.#terminal ?? error;
			})
			.then(() => {
				if (this.#terminal) throw this.#terminal;
			})
			.finally(this.#options.onClosed);
		return this.#closePromise;
	}

	#heartbeat(): void {
		this.#timer = undefined;
		if (this.#sealed) return;
		void this.#options.queue
			.enqueue(() => {
				if (this.#sealed || this.#terminal) return;
				try {
					if (!renewSqliteLease(this.#options.db, this.#options.lease, this.#options.now, this.#options.ttlMs))
						this.#latch(new StorageError("closed", "SQLite writer lease was lost"));
				} catch (error) {
					if (error instanceof SqliteEngineError) this.#latch(error);
				}
			})
			.finally(() => this.#scheduleHeartbeat());
	}

	#scheduleHeartbeat(): void {
		if (this.#sealed || this.#timer) return;
		this.#timer = this.#options.timers.schedule(() => this.#heartbeat(), this.#options.heartbeatMs);
		this.#timer.unref?.();
	}

	#exactRead<T>(
		ids: string[],
		label: string,
		read: (db: SqliteDatabase, sessionId: string, ids: readonly string[]) => ReadonlyMap<string, T>,
	): Promise<ReadonlyMap<string, T>> {
		try {
			this.#assertOpen();
			assertIdList(ids);
			for (const id of ids) if (!isUuidV7(id)) throw new StorageError("invalid_query", `Invalid ${label} id: ${id}`);
			const admitted = [...ids];
			if (admitted.length === 0) return this.#admitRead(() => new Map());
			return this.#admitRead(() => read(this.#options.db, this.#options.lease.sessionId, admitted));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	#branchRead<T>(
		query: BranchScan,
		read: (db: SqliteDatabase, sessionId: string, query: BranchScan) => T[],
	): Promise<T[]> {
		try {
			this.#assertOpen();
			assertBranchScan(query);
			if (!isUuidV7(query.start)) throw new StorageError("invalid_query", `Invalid branch start: ${query.start}`);
			if (query.stopAtId !== undefined && !isUuidV7(query.stopAtId))
				throw new StorageError("invalid_query", `Invalid branch stop id: ${query.stopAtId}`);
			if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0))
				throw new StorageError("invalid_query", "limit must be a positive safe integer");
			if (query.cursor !== undefined && (!Number.isSafeInteger(query.cursor.seq) || query.cursor.seq < 0))
				throw new StorageError("invalid_query", "cursor sequence must be non-negative");
			if (query.customType !== undefined && query.type !== "custom")
				throw new StorageError("invalid_query", "customType requires custom entry type");
			const admitted = structuredClone(query);
			return this.#admitRead(() => structuredClone(read(this.#options.db, this.#options.lease.sessionId, admitted)));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	#admitRead<T>(read: () => T): Promise<T> {
		return this.#options.queue.enqueue(() => {
			if (this.#terminal) throw this.#terminal;
			try {
				return read();
			} catch (error) {
				this.#latch(error);
				throw error;
			}
		});
	}

	#assertRegisterText(value: string, label: string, allowEmpty: boolean): void {
		if ((!allowEmpty && value.length === 0) || value.includes("\u0000"))
			throw new StorageError(
				"invalid_query",
				`${label} must ${allowEmpty ? "contain no NUL" : "be non-empty and contain no NUL"}`,
			);
	}

	#latch(error: unknown): void {
		if (this.#terminal === undefined) this.#terminal = error;
		this.#sealed = true;
		if (this.#timer) this.#options.timers.cancel(this.#timer);
		this.#timer = undefined;
	}

	#assertOpen(): void {
		if (this.#sealed) throw new StorageError("closed", "Storage is closed");
	}
}
