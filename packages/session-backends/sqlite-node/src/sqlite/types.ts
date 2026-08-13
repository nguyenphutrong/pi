/** Result of a prepared SQLite statement execution. */
export interface SqliteRunResult {
	/** Number of rows changed by the statement. */
	changes: number;
	/** Inserted row id when the backend exposes one. */
	lastInsertRowid?: number;
}

/** Prepared SQLite statement capability used by the SQLite session backend. */
export interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult;
	get<TRow extends object>(...params: unknown[]): TRow | undefined;
	all<TRow extends object>(...params: unknown[]): TRow[];
}

/** SQLite database capability used by the SQLite session backend. */
export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	/** Runs a synchronous write transaction. The callback must not return a promise. */
	transaction<T>(fn: () => T): T;
	close(): void;
}

export interface SqliteDatabaseFactory {
	open(path: string): Promise<SqliteDatabase>;
}
