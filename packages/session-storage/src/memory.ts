import type { Usage } from "@earendil-works/pi-ai";
import { isUuidV7 } from "./id.ts";
import {
	type BranchScan,
	type CommitResult,
	type Entry,
	type EntryScan,
	type EntryStructure,
	type Register,
	type SessionStats,
	type Storage,
	StorageError,
	type Transaction,
	type UsageRow,
} from "./types.ts";
import { assertBranchScan, assertEntryScan, assertIdList, assertQueryText, assertTransaction } from "./validation.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fail(
	code: "invalid_id" | "invalid_payload" | "invalid_transaction" | "invalid_query" | "corruption",
	message: string,
): never {
	throw new StorageError(code, message);
}

function assertText(
	value: string,
	label: string,
	code: "invalid_query" | "invalid_transaction" = "invalid_transaction",
	allowEmpty = false,
): void {
	if ((!allowEmpty && value.length === 0) || value.includes("\u0000"))
		fail(code, `${label} must ${allowEmpty ? "contain no NUL" : "be non-empty and contain no NUL"}`);
}

function assertLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
		fail("invalid_query", "limit must be a positive safe integer");
}

function registerId(namespace: string, key: string): string {
	return `${namespace}\u0000${key}`;
}

class MemoryStorageCore {
	private entries = new Map<string, Entry>();
	private registers = new Map<string, Register>();
	private usage = new Map<string, UsageRow>();
	private stats: SessionStats = { messageCount: 0, usage: structuredClone(ZERO_USAGE) };
	private nextSeq = 1;
	private queue: Promise<void> = Promise.resolve();

	commit(tx: Transaction): Promise<CommitResult> {
		let admitted: Transaction;
		try {
			assertTransaction(tx);
			admitted = structuredClone(tx);
		} catch (error) {
			return Promise.reject(
				error instanceof StorageError
					? error
					: new StorageError("invalid_transaction", "Transaction could not be admitted"),
			);
		}
		const result = this.queue.then(() => this.applyCommit(admitted));
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		assertIdList(ids, "entry");
		const result = new Map<string, Entry>();
		for (const id of ids) {
			if (!isUuidV7(id)) fail("invalid_query", `Invalid entry id: ${id}`);
			const entry = this.entries.get(id);
			if (entry) result.set(id, structuredClone(entry));
		}
		return result;
	}

	async getUsageRows(ids: string[]): Promise<ReadonlyMap<string, UsageRow>> {
		assertIdList(ids, "usage");
		const result = new Map<string, UsageRow>();
		for (const id of ids) {
			if (!isUuidV7(id)) fail("invalid_query", `Invalid usage id: ${id}`);
			const row = this.usage.get(id);
			if (row) result.set(id, structuredClone(row));
		}
		return result;
	}

	async getRegister(namespace: string, key: string): Promise<Register | undefined> {
		assertQueryText(namespace, "namespace");
		assertQueryText(key, "key");
		assertText(namespace, "namespace", "invalid_query");
		assertText(key, "key", "invalid_query", true);
		const register = this.registers.get(registerId(namespace, key));
		return register && structuredClone(register);
	}

	async listRegisters(namespace: string): Promise<Register[]> {
		assertQueryText(namespace, "namespace");
		assertText(namespace, "namespace", "invalid_query");
		return [...this.registers.values()]
			.filter((item) => item.namespace === namespace)
			.sort((a, b) => a.seq - b.seq)
			.map((item) => structuredClone(item));
	}

	async scanBranch(query: BranchScan): Promise<Entry[]> {
		assertBranchScan(query);
		return this.branch(query).map((entry) => structuredClone(entry));
	}

	async scanBranchStructure(query: BranchScan): Promise<EntryStructure[]> {
		assertBranchScan(query);
		return this.branch(query).map(({ id, parentId, seq, timestamp, type, customType }) => ({
			id,
			parentId,
			seq,
			timestamp,
			type,
			...(customType === undefined ? {} : { customType }),
		}));
	}

	async scanEntries(query: EntryScan = {}): Promise<Entry[]> {
		assertEntryScan(query);
		assertLimit(query.limit);
		if (query.fromSeq !== undefined && (!Number.isSafeInteger(query.fromSeq) || query.fromSeq < 0))
			fail("invalid_query", "fromSeq must be non-negative");
		if (query.toSeq !== undefined && (!Number.isSafeInteger(query.toSeq) || query.toSeq < 0))
			fail("invalid_query", "toSeq must be non-negative");
		if (query.customType !== undefined && query.type !== "custom")
			fail("invalid_query", "customType requires custom entry type");
		let entries = [...this.entries.values()].filter(
			(entry) =>
				(query.type === undefined || entry.type === query.type) &&
				(query.customType === undefined || entry.customType === query.customType) &&
				(query.fromSeq === undefined || entry.seq >= query.fromSeq) &&
				(query.toSeq === undefined || entry.seq <= query.toSeq),
		);
		entries.sort((a, b) => (query.order === "desc" ? b.seq - a.seq : a.seq - b.seq));
		if (query.limit !== undefined) entries = entries.slice(0, query.limit);
		return entries.map((entry) => structuredClone(entry));
	}

	async getStats(): Promise<SessionStats> {
		return structuredClone(this.stats);
	}

	drain(): Promise<void> {
		return this.queue;
	}

	private applyCommit(tx: Transaction): CommitResult {
		if (tx.writes.length === 0) fail("invalid_transaction", "Transaction must contain at least one write");
		const entries = new Map(this.entries);
		const registers = new Map(this.registers);
		const usageRows = new Map(this.usage);
		const stats = structuredClone(this.stats);
		const timestamp = Date.now();
		const seqs = tx.writes.map((_, index) => this.nextSeq + index);
		for (let index = 0; index < tx.writes.length; index++) {
			const write = tx.writes[index];
			const seq = seqs[index];
			if (write.kind === "entry") {
				const entry = write.entry;
				if (!isUuidV7(entry.id)) fail("invalid_id", `Invalid entry id: ${entry.id}`);
				if (entries.has(entry.id) || usageRows.has(entry.id))
					fail("corruption", `Duplicate durable id: ${entry.id}`);
				if (entry.parentId !== null && (!isUuidV7(entry.parentId) || !entries.has(entry.parentId)))
					fail("invalid_transaction", `Missing or invalid parent: ${entry.parentId}`);
				if (entry.type === "custom") {
					if (entry.customType === undefined) fail("invalid_transaction", "Custom entry requires customType");
					assertText(entry.customType, "customType");
				} else if (entry.customType !== undefined || entry.payload === undefined)
					fail("invalid_transaction", "Invalid entry envelope");
				entries.set(entry.id, { ...structuredClone(entry), seq, timestamp });
				if (entry.type === "message") stats.messageCount++;
			} else if (write.kind === "usage") {
				const row = write.row;
				if (!isUuidV7(row.id)) fail("invalid_id", `Invalid usage id: ${row.id}`);
				if (entries.has(row.id) || usageRows.has(row.id)) fail("corruption", `Duplicate durable id: ${row.id}`);
				if (row.entryId !== undefined && (!isUuidV7(row.entryId) || !entries.has(row.entryId)))
					fail("invalid_transaction", `Missing or invalid usage entry: ${row.entryId}`);
				usageRows.set(row.id, { ...structuredClone(row), seq });
				this.addUsage(stats.usage, row.usage);
			} else {
				assertText(write.namespace, "namespace");
				assertText(write.key, "key", "invalid_transaction", true);
				const id = registerId(write.namespace, write.key);
				if (write.op === "set")
					registers.set(id, {
						namespace: write.namespace,
						key: write.key,
						value: structuredClone(write.value),
						seq,
					});
				else registers.delete(id);
			}
		}
		this.entries = entries;
		this.registers = registers;
		this.usage = usageRows;
		this.stats = stats;
		this.nextSeq += tx.writes.length;
		return { firstSeq: seqs[0], seqs, timestamp };
	}

	private addUsage(total: Usage, usage: Usage): void {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
		if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
	}

	private branch(query: BranchScan): Entry[] {
		assertLimit(query.limit);
		if (!isUuidV7(query.start)) fail("invalid_query", `Invalid branch start: ${query.start}`);
		if (query.stopAtId !== undefined && !isUuidV7(query.stopAtId))
			fail("invalid_query", `Invalid branch stop id: ${query.stopAtId}`);
		if (query.customType !== undefined && query.type !== "custom")
			fail("invalid_query", "customType requires custom entry type");
		if (query.cursor !== undefined && (!Number.isSafeInteger(query.cursor.seq) || query.cursor.seq < 0))
			fail("invalid_query", "cursor sequence must be non-negative");
		const path: Entry[] = [];
		let current = this.entries.get(query.start);
		if (!current) fail("corruption", `Missing branch start: ${query.start}`);
		while (current) {
			path.push(current);
			if (current.parentId === null) break;
			const parent = this.entries.get(current.parentId);
			if (!parent) fail("corruption", `Missing parent: ${current.parentId}`);
			current = parent;
		}
		if (query.order === "oldestFirst") path.reverse();
		const stopIndex = path.findIndex((entry) => entry.id === query.stopAtId || entry.type === query.stopAtType);
		let result = (stopIndex === -1 ? path : path.slice(0, stopIndex + 1)).filter(
			(entry) =>
				(query.type === undefined || entry.type === query.type) &&
				(query.customType === undefined || entry.customType === query.customType) &&
				(query.cursor === undefined ||
					(query.order === "oldestFirst" ? entry.seq > query.cursor.seq : entry.seq < query.cursor.seq)),
		);
		if (query.limit !== undefined) result = result.slice(0, query.limit);
		return result;
	}
}

const memoryStorageCores = new WeakMap<MemoryStorageState, MemoryStorageCore>();

/** Repository-owned durable state shared by disposable MemoryStorage handles. */
export class MemoryStorageState {
	constructor() {
		memoryStorageCores.set(this, new MemoryStorageCore());
	}

	createStorage(): MemoryStorage {
		return new MemoryStorage(this);
	}
}

export class MemoryStorage implements Storage {
	readonly #core: MemoryStorageCore;
	#sealed = false;
	#closePromise: Promise<void> | undefined;

	constructor(state: MemoryStorageState = new MemoryStorageState()) {
		const core = memoryStorageCores.get(state);
		if (!core) throw new TypeError("Invalid MemoryStorageState");
		this.#core = core;
	}

	commit(tx: Transaction): Promise<CommitResult> {
		try {
			this.assertOpen();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#core.commit(tx);
	}

	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		return this.call(() => this.#core.getEntries(ids));
	}

	getUsageRows(ids: string[]): Promise<ReadonlyMap<string, UsageRow>> {
		return this.call(() => this.#core.getUsageRows(ids));
	}

	getRegister(namespace: string, key: string): Promise<Register | undefined> {
		return this.call(() => this.#core.getRegister(namespace, key));
	}

	listRegisters(namespace: string): Promise<Register[]> {
		return this.call(() => this.#core.listRegisters(namespace));
	}

	scanBranch(query: BranchScan): Promise<Entry[]> {
		return this.call(() => this.#core.scanBranch(query));
	}

	scanBranchStructure(query: BranchScan): Promise<EntryStructure[]> {
		return this.call(() => this.#core.scanBranchStructure(query));
	}

	scanEntries(query: EntryScan = {}): Promise<Entry[]> {
		return this.call(() => this.#core.scanEntries(query));
	}

	getStats(): Promise<SessionStats> {
		return this.call(() => this.#core.getStats());
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#sealed = true;
		this.#closePromise = this.#core.drain();
		return this.#closePromise;
	}

	private call<T>(operation: () => Promise<T>): Promise<T> {
		try {
			this.assertOpen();
			return operation();
		} catch (error) {
			return Promise.reject(error);
		}
	}

	private assertOpen(): void {
		if (this.#sealed) throw new StorageError("closed", "Storage is closed");
	}
}
