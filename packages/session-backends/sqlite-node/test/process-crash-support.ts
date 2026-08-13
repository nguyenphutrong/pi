import type { SqliteDatabase, SqliteDatabaseFactory, SqliteRunResult, SqliteStatement } from "../src/index.ts";

export const SESSION_ID = "018f0000-0000-7000-8000-000000000001";
export const ROOT_ID = "018f0000-0001-7000-8000-000000000002";
export const CHILD_ID = "018f0000-0002-7000-8000-000000000003";
export const USAGE_ID = "018f0000-0003-7000-8000-000000000004";
export const CLOCK = 10_000;
export const TTL = 1_000;
export const CRASH_OWNER = "crash-owner";
export const TAKEOVER_OWNER = "takeover-owner";
export const PROTOCOL_VERSION = 1;
export type CrashMode = "commit" | "create";

export interface ProtocolEvent {
	readonly v: 1;
	readonly event: "armed" | "cut-reached" | "catalog" | "complete";
	readonly cut?: string;
	readonly cuts?: readonly string[];
}

export const baselineTransaction = {
	writes: [
		{
			kind: "entry" as const,
			entry: { id: ROOT_ID, parentId: null, type: "message" as const, payload: { role: "user", content: "root" } },
		},
		{ kind: "register" as const, op: "set" as const, namespace: "test", key: "overwrite", value: "old" },
		{ kind: "register" as const, op: "set" as const, namespace: "test", key: "delete", value: "remove" },
	],
};

export const commitTransaction = {
	writes: [
		{
			kind: "entry" as const,
			entry: {
				id: CHILD_ID,
				parentId: ROOT_ID,
				type: "message" as const,
				payload: { role: "assistant", content: "child" },
			},
		},
		{
			kind: "usage" as const,
			row: {
				id: USAGE_ID,
				entryId: CHILD_ID,
				adjustment: false,
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0, total: 0.5 },
				},
			},
		},
		{ kind: "register" as const, op: "set" as const, namespace: "test", key: "new", value: { committed: true } },
		{ kind: "register" as const, op: "set" as const, namespace: "test", key: "overwrite", value: "new" },
		{ kind: "register" as const, op: "delete" as const, namespace: "test", key: "delete" },
		{ kind: "register" as const, op: "delete" as const, namespace: "test", key: "absent" },
	],
};

export const createTransaction = {
	writes: [
		{ kind: "register" as const, op: "set" as const, namespace: "lane.leaf", key: "main", value: null },
		{
			kind: "register" as const,
			op: "set" as const,
			namespace: "lane.state",
			key: "main",
			value: { currentOperationId: null, pendingNextRun: [] },
		},
	],
};

function normalize(sql: string): string {
	return sql.replace(/\s+/g, " ").trim().toUpperCase();
}

function classify(mode: CrashMode, sql: string, params: readonly unknown[]): string | undefined {
	const normalized = normalize(sql);
	if (mode === "create") {
		if (normalized.startsWith("INSERT INTO SESSIONS ")) return "session-catalog-insert";
		if (normalized.startsWith("INSERT INTO SESSION_SEQUENCES ")) return "session-sequences-insert";
		if (normalized.startsWith("INSERT INTO SESSION_STATS ")) return "session-stats-initial-insert";
		if (normalized.startsWith("INSERT INTO WRITER_LEASES ")) return "writer-lease-insert";
		if (normalized.startsWith("INSERT INTO REGISTERS ")) return `register-set:${String(params[1])}`;
		if (normalized.startsWith("UPDATE SESSION_STATS SET")) return "final-stats-update";
		if (normalized.startsWith("UPDATE SESSION_SEQUENCES SET")) return "final-sequence-update";
		return undefined;
	}
	if (normalized.startsWith("UPDATE WRITER_LEASES SET EXPIRES_AT_MS")) return "lease-renew";
	if (normalized.startsWith("INSERT INTO ENTRIES ")) return "entry-insert";
	if (normalized.startsWith("INSERT INTO BRANCH_ENTRIES ")) return "branch-entry-insert";
	if (normalized.startsWith("UPDATE BRANCH_META SET TIP_ENTRY_ID")) return "branch-meta-update";
	if (normalized.startsWith("INSERT INTO USAGE_LEDGER ")) return "usage-insert";
	if (normalized.startsWith("INSERT INTO REGISTERS ")) return `register-set:${String(params[2])}`;
	if (normalized.startsWith("DELETE FROM REGISTERS ")) return `register-delete:${String(params[2])}`;
	if (normalized.startsWith("UPDATE SESSION_STATS SET")) return "stats-update";
	if (normalized.startsWith("UPDATE SESSION_SEQUENCES SET")) return "sequence-update";
	return undefined;
}

function isMutating(sql: string): boolean {
	return /^(INSERT|UPDATE|DELETE|REPLACE)\b/.test(normalize(sql));
}

export function createCrashFactory(
	inner: SqliteDatabaseFactory,
	mode: CrashMode,
	cut: string | undefined,
	emit: (event: ProtocolEvent) => void,
): { readonly factory: SqliteDatabaseFactory; arm(): void; disarm(): void; catalog(): readonly string[] } {
	let armed = false;
	const catalog: string[] = [];
	const reach = (site: string): void => {
		catalog.push(site);
		if (cut !== site) return;
		emit({ v: PROTOCOL_VERSION, event: "cut-reached", cut: site });
		process.kill(process.pid, "SIGKILL");
	};
	return {
		factory: {
			async open(path: string): Promise<SqliteDatabase> {
				const db = await inner.open(path);
				return {
					exec: (sql) => db.exec(sql),
					prepare(sql: string): SqliteStatement {
						const statement = db.prepare(sql);
						return {
							run(...params: unknown[]): SqliteRunResult {
								const result = statement.run(...params);
								if (armed) {
									const site = classify(mode, sql, params);
									if (site) reach(site);
									else if (isMutating(sql)) throw new Error(`Unclassified armed mutation: ${normalize(sql)}`);
								}
								return result;
							},
							get: <TRow extends object>(...params: unknown[]) => statement.get<TRow>(...params),
							all: <TRow extends object>(...params: unknown[]) => statement.all<TRow>(...params),
						};
					},
					transaction<T>(run: () => T): T {
						const result = db.transaction(() => {
							if (armed) reach("before-first-operation");
							return run();
						});
						if (armed) reach("after-commit");
						return result;
					},
					close: () => db.close(),
				};
			},
		},
		arm() {
			armed = true;
		},
		disarm() {
			armed = false;
		},
		catalog: () => [...catalog],
	};
}
