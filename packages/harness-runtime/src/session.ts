import type { Message } from "@earendil-works/pi-ai";
import {
	assertRegister,
	assertUsageRow,
	createIdGenerator,
	type EntryScan,
	type IdGenerator,
	isUuidV7,
	type Storage,
	StorageError,
	type UsageRow,
} from "@earendil-works/pi-session-storage";
import { decodeMessageEntry, encodeMessage } from "./codec.ts";
import {
	type CurrentRegister,
	decodeConfigurationRegister,
	decodeLaneStateRegister,
	decodeRunOperationRegister,
	decodeRunStateRegister,
	encodeLaneConfiguration,
	type LaneConfiguration,
	type LaneState,
	type RunOperation,
	type RunState,
} from "./durable.ts";
import {
	type BranchBounds,
	type EntryQuery,
	type MessageEntry,
	type Session,
	SessionError,
	type SessionMetadata,
} from "./types.ts";

const LEAF_NAMESPACE = "lane.leaf";
const CONFIG_NAMESPACE = "lane.config";
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

function decodeMainLeafRegister(candidate: unknown): CurrentRegister<string | null> {
	try {
		assertRegister(candidate);
	} catch (error) {
		throw new SessionError("corruption", "Malformed main leaf register", error);
	}
	if (candidate.namespace !== LEAF_NAMESPACE || candidate.key !== MAIN)
		throw new SessionError("corruption", "Main leaf register has the wrong identity");
	if (candidate.value !== null && (typeof candidate.value !== "string" || !isUuidV7(candidate.value)))
		throw new SessionError("corruption", "Main leaf must be null or a UUIDv7 entry id");
	return Object.freeze({ seq: candidate.seq, value: candidate.value });
}

function decodeIdleMainStateRegister(candidate: unknown): void {
	if (decodeLaneStateRegister(candidate).value.currentOperationId !== null)
		throw new SessionError("corruption", "Main lane must be idle");
}

interface CurrentStateHydration {
	readonly entries: ReadonlyMap<string, MessageEntry>;
	readonly usageRows: ReadonlyMap<string, UsageRow>;
}

async function hydrateCurrentState(
	storage: Storage,
	mainLeaf: CurrentRegister<string | null>,
	runOperation?: CurrentRegister<RunOperation>,
	runState?: CurrentRegister<RunState>,
): Promise<CurrentStateHydration> {
	const entryIds = new Set<string>();
	const usageIds = new Set<string>();
	if (mainLeaf.value !== null) entryIds.add(mainLeaf.value);

	let triggerEntryId: string | undefined;
	let responseEntryId: string | undefined;
	let usageId: string | undefined;
	if (runOperation && runState) {
		if (runOperation.value.sourceLeafId !== null) entryIds.add(runOperation.value.sourceLeafId);
		for (const id of runOperation.value.intent.promptEntryIds) entryIds.add(id);
		if (runState.value.phase.kind === "checkpoint") triggerEntryId = runState.value.phase.triggerEntryId;
		else {
			triggerEntryId = runState.value.phase.generation.context.triggerEntryId;
			if (runState.value.phase.generation.status === "effect_pending") {
				responseEntryId = runState.value.phase.generation.responseEntryId;
				usageId = runState.value.phase.generation.usageId;
				entryIds.add(responseEntryId);
				entryIds.add(usageId);
				usageIds.add(responseEntryId);
				usageIds.add(usageId);
			}
		}
		entryIds.add(triggerEntryId);
		if (runState.value.latestAssistantEntryId !== null) entryIds.add(runState.value.latestAssistantEntryId);
	}

	const [storedEntries, storedUsageRows] = await Promise.all([
		storage.getEntries([...entryIds]),
		storage.getUsageRows([...usageIds]),
	]);
	const entries = new Map<string, MessageEntry>();
	for (const [id, candidate] of storedEntries) {
		const entry = decodeMessageEntry(candidate);
		if (entry.id !== id || !entryIds.has(id))
			throw new SessionError("corruption", "Current-state entry lookup returned the wrong identity");
		entries.set(id, entry);
	}
	const usageRows = new Map<string, UsageRow>();
	for (const [id, candidate] of storedUsageRows) {
		try {
			assertUsageRow(candidate);
		} catch (error) {
			throw new SessionError("corruption", "Malformed current-state usage row", error);
		}
		if (candidate.id !== id || !usageIds.has(id))
			throw new SessionError("corruption", "Current-state usage lookup returned the wrong identity");
		usageRows.set(id, Object.freeze(structuredClone(candidate)));
	}

	const requireEntry = (id: string, name: string): MessageEntry => {
		const entry = entries.get(id);
		if (!entry) throw new SessionError("corruption", `${name} references a missing message entry`);
		return entry;
	};
	if (mainLeaf.value !== null) requireEntry(mainLeaf.value, "Main leaf");
	if (runOperation && runState && triggerEntryId) {
		const operation = runOperation.value;
		const state = runState.value;
		if (operation.intent.promptEntryIds.length === 0)
			throw new SessionError("corruption", "A Phase 1 run must contain a prompt entry");
		let expectedParent = operation.sourceLeafId;
		if (expectedParent !== null) requireEntry(expectedParent, "Operation source leaf");
		for (const id of operation.intent.promptEntryIds) {
			const prompt = requireEntry(id, "Run prompt");
			if (prompt.parentId !== expectedParent)
				throw new SessionError("corruption", "Run prompt entries do not extend the operation source in order");
			expectedParent = id;
		}
		const trigger = requireEntry(triggerEntryId, "Current trigger");
		if (state.latestAssistantEntryId !== null) {
			const latest = requireEntry(state.latestAssistantEntryId, "Latest assistant");
			if (latest.message.role !== "assistant")
				throw new SessionError("corruption", "Latest assistant entry must contain an assistant message");
		}
		if (state.phase.kind === "checkpoint" && state.phase.continuation.kind === "may_finish") {
			if (
				mainLeaf.value !== triggerEntryId ||
				trigger.message.role !== "assistant" ||
				trigger.parentId !== expectedParent
			)
				throw new SessionError("corruption", "Finished Phase 1 generation has an invalid assistant closure");
		} else if (mainLeaf.value !== triggerEntryId || triggerEntryId !== expectedParent) {
			throw new SessionError(
				"corruption",
				"Open Phase 1 generation trigger must be the newest prompt and lane leaf",
			);
		}
	}
	if (responseEntryId && usageId) {
		if (entries.has(usageId))
			throw new SessionError("corruption", "Generation usage reservation id is occupied by an entry");
		if (usageRows.has(responseEntryId))
			throw new SessionError("corruption", "Generation response reservation id is occupied by a usage row");
		const response = entries.get(responseEntryId);
		const usage = usageRows.get(usageId);
		if ((response === undefined) !== (usage === undefined))
			throw new SessionError("corruption", "Generation response and usage reservations must materialize together");
		if (response && (response.message.role !== "assistant" || response.parentId !== triggerEntryId))
			throw new SessionError("corruption", "Materialized response reservation has an invalid assistant closure");
		if (usage && (usage.id !== usageId || usage.adjustment || usage.entryId !== responseEntryId))
			throw new SessionError("corruption", "Materialized usage reservation does not match its response");
	}
	return Object.freeze({ entries, usageRows });
}

export async function validateMainLane(storage: Storage): Promise<void> {
	try {
		const [leafRegisters, configRegisters, stateRegisters] = await Promise.all([
			storage.listRegisters(LEAF_NAMESPACE),
			storage.listRegisters(CONFIG_NAMESPACE),
			storage.listRegisters(STATE_NAMESPACE),
		]);
		if (leafRegisters.length !== 1)
			throw new SessionError("corruption", "Exactly one main leaf register is required");
		if (stateRegisters.length !== 1)
			throw new SessionError("corruption", "Exactly one main lane state register is required");
		const leaf = decodeMainLeafRegister(leafRegisters[0]);
		if (configRegisters.length > 1) throw new SessionError("corruption", "At most one main configuration is allowed");
		if (configRegisters[0]) decodeConfigurationRegister(configRegisters[0]);
		const laneState = decodeLaneStateRegister(stateRegisters[0]);
		let runOperation: CurrentRegister<RunOperation> | undefined;
		let runState: CurrentRegister<RunState> | undefined;
		if (laneState.value.currentOperationId !== null) {
			if (!configRegisters[0]) throw new SessionError("corruption", "An open operation requires lane configuration");
			const operationId = laneState.value.currentOperationId;
			const [metadata, state] = await Promise.all([
				storage.getRegister("op.meta", operationId),
				storage.getRegister("op.state", operationId),
			]);
			if (!metadata || !state) throw new SessionError("corruption", "Open operation registers are missing");
			runOperation = decodeRunOperationRegister(metadata, operationId);
			runState = decodeRunStateRegister(state, operationId);
		}
		await hydrateCurrentState(storage, leaf, runOperation, runState);
	} catch (error) {
		throw storageFailure(error);
	}
}

export interface RuntimeAttachment {
	readonly laneConfiguration: CurrentRegister<LaneConfiguration>;
	readonly laneState: CurrentRegister<LaneState>;
	readonly mainLeaf: CurrentRegister<string | null>;
	readonly runOperation?: CurrentRegister<RunOperation>;
	readonly runState?: CurrentRegister<RunState>;
	readonly entries: ReadonlyMap<string, MessageEntry>;
	readonly usageRows: ReadonlyMap<string, UsageRow>;
}

export class MemorySession implements Session {
	readonly metadata: SessionMetadata;
	readonly idGenerator: IdGenerator;
	readonly #storage: Storage;
	readonly #release: () => void;
	#sealed = false;
	#mutationLine: Promise<void> = Promise.resolve();
	#closePromise: Promise<void> | undefined;
	#runtimeAttached = false;

	constructor(metadata: SessionMetadata, storage: Storage, release: () => void) {
		this.metadata = metadata;
		this.#storage = storage;
		this.#release = release;
		this.idGenerator = createIdGenerator();
	}

	#assertOpen(): void {
		if (this.#sealed) throw new SessionError("closed", "Session is closed");
	}

	attachRuntime(seed: LaneConfiguration): Promise<RuntimeAttachment> {
		this.#assertOpen();
		let encodedSeed: ReturnType<typeof encodeLaneConfiguration>;
		try {
			encodedSeed = encodeLaneConfiguration(seed);
		} catch (error) {
			return Promise.reject(error);
		}
		if (this.#runtimeAttached) return Promise.reject(new SessionError("active", "A runtime is already attached"));
		this.#runtimeAttached = true;
		const operation = this.#mutationLine.then(async () => {
			const [configuration, state, leaf] = await Promise.all([
				this.#storage.getRegister(CONFIG_NAMESPACE, MAIN),
				this.#storage.getRegister(STATE_NAMESPACE, MAIN),
				this.#storage.getRegister(LEAF_NAMESPACE, MAIN),
			]);
			if (!state) throw new SessionError("corruption", "Main lane state is missing");
			const mainLeaf = decodeMainLeafRegister(leaf);
			const laneState = decodeLaneStateRegister(state);
			let laneConfiguration: CurrentRegister<LaneConfiguration>;
			if (configuration) laneConfiguration = decodeConfigurationRegister(configuration);
			else {
				if (laneState.value.currentOperationId !== null)
					throw new SessionError("corruption", "An open operation requires lane configuration");
				const committed = await this.#storage.commit({
					writes: [{ kind: "register", op: "set", namespace: CONFIG_NAMESPACE, key: MAIN, value: encodedSeed }],
				});
				laneConfiguration = Object.freeze({
					seq: committed.seqs[0],
					value: decodeConfigurationRegister({
						namespace: CONFIG_NAMESPACE,
						key: MAIN,
						seq: committed.seqs[0],
						value: encodedSeed,
					}).value,
				});
			}
			let runOperation: CurrentRegister<RunOperation> | undefined;
			let runState: CurrentRegister<RunState> | undefined;
			if (laneState.value.currentOperationId !== null) {
				const operationId = laneState.value.currentOperationId;
				const [metadata, currentState] = await Promise.all([
					this.#storage.getRegister("op.meta", operationId),
					this.#storage.getRegister("op.state", operationId),
				]);
				if (!metadata || !currentState)
					throw new SessionError("corruption", "Open operation registers are missing");
				runOperation = decodeRunOperationRegister(metadata, operationId);
				runState = decodeRunStateRegister(currentState, operationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, runOperation, runState);
			return Object.freeze({ laneConfiguration, laneState, mainLeaf, runOperation, runState, ...hydrated });
		});
		this.#mutationLine = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation.catch((error) => {
			throw storageFailure(error);
		});
	}

	async getLeafId(): Promise<string | null> {
		this.#assertOpen();
		try {
			return decodeMainLeafRegister(await this.#storage.getRegister(LEAF_NAMESPACE, MAIN)).value;
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
			const leafId = decodeMainLeafRegister(leaf).value;
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
