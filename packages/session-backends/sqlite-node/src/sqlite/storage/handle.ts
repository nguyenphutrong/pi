import { type CommitResult, StorageError, type Transaction } from "@nguyenphutrong/pi-session-storage";
import type { SqliteDatabase } from "../types.ts";
import type { SqliteFileQueue } from "./file-queue.ts";
import type { TimerFactory, TimerHandle } from "./lifecycle.ts";
import { hasPreparedEntries, prepareTransaction } from "./prepared-transaction.ts";
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
			if (hasPreparedEntries(prepared))
				throw new StorageError("invalid_transaction", "Entry writes require branch projection");
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
