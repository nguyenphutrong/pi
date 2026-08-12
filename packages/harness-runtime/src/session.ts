import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	assertRegister,
	assertUsageRow,
	createIdGenerator,
	type EntryScan,
	type IdGenerator,
	isUuidV7,
	type JsonValue,
	type Storage,
	StorageError,
	type UsageRow,
	type Write,
} from "@nguyenphutrong/pi-session-storage";
import { classifyAssistantSettlement } from "./assistant-settlement.ts";
import { decodeMessageEntry, encodeMessage } from "./codec.ts";
import {
	type CurrentRegister,
	decodeConfigurationRegister,
	decodeLaneStateRegister,
	decodeRunOperationRegister,
	decodeRunStateRegister,
	encodeLaneConfiguration,
	encodeLaneLastResult,
	encodeRunOperation,
	encodeRunState,
	type LaneConfiguration,
	type LaneState,
	type NormalizedRetryPolicy,
	type RunOperation,
	type RunState,
	type StreamOptions,
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
const LAST_RESULT_NAMESPACE = "lane.lastResult";
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

export interface StartAssistantStepTransition {
	readonly operationId: string;
	readonly triggerEntryId: string;
	readonly expectedOperationStateSeq: number;
	readonly expectedLaneStateSeq: number;
	readonly expectedConfigurationSeq: number;
	readonly streamOptions: StreamOptions;
	readonly retryPolicy: NormalizedRetryPolicy;
}

export interface AcceptPromptTransition {
	readonly messages: readonly Message[];
	readonly expectedConfigurationSeq: number;
	readonly expectedLaneStateSeq: number;
	readonly expectedLeafSeq: number;
	readonly expectedProvider: string;
	readonly expectedModelId: string;
	readonly identityAvailable: boolean;
}

export type AcceptPromptResult =
	| { readonly status: "committed"; readonly attachment: RuntimeAttachment }
	| { readonly status: "stale" | "busy" | "unavailable"; readonly attachment: RuntimeAttachment };

export interface RuntimeTransitionResult {
	readonly committed: boolean;
	readonly attachment: RuntimeAttachment;
}

export interface FinishRunTransition {
	readonly operationId: string;
	readonly expectedOperationStateSeq: number;
	readonly expectedLaneStateSeq: number;
}

export interface FinishedRunResult {
	readonly operationId: string;
	readonly kind: "completed";
	readonly leafId: string;
	readonly finalEntryId: string;
	readonly finalMessage: AssistantMessage;
}

export type FinishRunResult =
	| { readonly status: "committed"; readonly attachment: RuntimeAttachment; readonly result: FinishedRunResult }
	| { readonly status: "obsolete"; readonly attachment: RuntimeAttachment; readonly result?: undefined };

export interface PrepareAssistantEffectTransition {
	readonly operationId: string;
	readonly stepId: string;
	readonly attempt: number;
	readonly expectedOperationStateSeq: number;
	readonly expectedLaneStateSeq: number;
	readonly expectedConfigurationSeq: number;
	readonly expectedLeafSeq: number;
	readonly expectedLeafId: string | null;
	readonly expectedProvider: string;
	readonly expectedModelId: string;
	readonly intendedOutputLimit: number;
	readonly contextWindow: number;
}

export interface SettleAssistantEffectTransition {
	readonly operationId: string;
	readonly stepId: string;
	readonly attempt: number;
	readonly responseEntryId: string;
	readonly usageId: string;
	readonly provider: string;
	readonly modelId: string;
	readonly triggerEntryId: string;
	readonly intendedOutputLimit: number;
	readonly contextWindow: number;
	readonly message: AssistantMessage;
}

export type SettleAssistantEffectResult =
	| { readonly status: "committed" | "materialized" | "obsolete"; readonly attachment: RuntimeAttachment }
	| {
			readonly status: "unsupported";
			readonly classification: "unsupported";
			readonly attachment: RuntimeAttachment;
	  };

export type PrepareAssistantEffectResult =
	| {
			readonly committed: true;
			readonly attachment: RuntimeAttachment;
			readonly responseEntryId: string;
			readonly usageId: string;
	  }
	| {
			readonly committed: false;
			readonly attachment: RuntimeAttachment;
			readonly responseEntryId?: undefined;
			readonly usageId?: undefined;
	  };

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

	startAssistantStep(transition: StartAssistantStepTransition): Promise<RuntimeTransitionResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		const operation = this.#mutationLine.then(async () => {
			const [configurationCandidate, laneStateCandidate, leafCandidate] = await Promise.all([
				this.#storage.getRegister(CONFIG_NAMESPACE, MAIN),
				this.#storage.getRegister(STATE_NAMESPACE, MAIN),
				this.#storage.getRegister(LEAF_NAMESPACE, MAIN),
			]);
			if (!configurationCandidate || !laneStateCandidate)
				throw new SessionError("corruption", "Main lane registers are missing");
			const configuration = decodeConfigurationRegister(configurationCandidate);
			const laneState = decodeLaneStateRegister(laneStateCandidate);
			const mainLeaf = decodeMainLeafRegister(leafCandidate);
			const currentOperationId = laneState.value.currentOperationId;
			let runOperation: CurrentRegister<RunOperation> | undefined;
			let state: CurrentRegister<RunState> | undefined;
			if (currentOperationId !== null) {
				const [metadataCandidate, stateCandidate] = await Promise.all([
					this.#storage.getRegister("op.meta", currentOperationId),
					this.#storage.getRegister("op.state", currentOperationId),
				]);
				if (!metadataCandidate || !stateCandidate)
					throw new SessionError("corruption", "Open operation registers are missing");
				runOperation = decodeRunOperationRegister(metadataCandidate, currentOperationId);
				state = decodeRunStateRegister(stateCandidate, currentOperationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, runOperation, state);
			const phase = state?.value.phase;
			const current =
				configuration.seq === transition.expectedConfigurationSeq &&
				laneState.seq === transition.expectedLaneStateSeq &&
				currentOperationId === transition.operationId &&
				state?.seq === transition.expectedOperationStateSeq &&
				phase?.kind === "checkpoint" &&
				phase.continuation.kind === "need_assistant" &&
				phase.triggerEntryId === transition.triggerEntryId;
			if (!current) {
				return Object.freeze({
					committed: false,
					attachment: Object.freeze({
						laneConfiguration: configuration,
						laneState,
						mainLeaf,
						runOperation,
						runState: state,
						...hydrated,
					}),
				});
			}
			if (!state || !runOperation || phase?.kind !== "checkpoint" || phase.continuation.kind !== "need_assistant")
				throw new SessionError("corruption", "Validated assistant-step trigger changed inside the mutation line");
			const stepId = this.idGenerator.next();
			const nextState: RunState = {
				...state.value,
				phase: {
					kind: "assistant",
					generation: {
						status: "ready",
						context: {
							stepId,
							triggerEntryId: transition.triggerEntryId,
							configuration: structuredClone(configuration.value),
							streamOptions: structuredClone(transition.streamOptions),
							retryPolicy: structuredClone(transition.retryPolicy),
							overflowRecoveryUsed: phase.continuation.overflowRecoveryUsed,
						},
						nextAttempt: 1,
					},
				},
			};
			const committed = await this.#storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: transition.operationId,
						value: encodeRunState(nextState, transition.operationId),
					},
				],
			});
			const runState = Object.freeze({ seq: committed.seqs[0], value: structuredClone(nextState) });
			return Object.freeze({
				committed: true,
				attachment: Object.freeze({
					laneConfiguration: configuration,
					laneState,
					mainLeaf,
					runOperation,
					runState,
					...hydrated,
				}),
			});
		});
		this.#mutationLine = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation.catch((error) => {
			throw storageFailure(error);
		});
	}

	prepareAssistantEffect(transition: PrepareAssistantEffectTransition): Promise<PrepareAssistantEffectResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		if (
			!Number.isSafeInteger(transition.intendedOutputLimit) ||
			transition.intendedOutputLimit <= 0 ||
			!Number.isSafeInteger(transition.contextWindow) ||
			transition.contextWindow <= 0
		)
			return Promise.reject(
				new SessionError("invalid_query", "Assistant effect limits must be positive safe integers"),
			);
		const operation = this.#mutationLine.then(async () => {
			const [configurationCandidate, laneStateCandidate, leafCandidate] = await Promise.all([
				this.#storage.getRegister(CONFIG_NAMESPACE, MAIN),
				this.#storage.getRegister(STATE_NAMESPACE, MAIN),
				this.#storage.getRegister(LEAF_NAMESPACE, MAIN),
			]);
			if (!configurationCandidate || !laneStateCandidate)
				throw new SessionError("corruption", "Main lane registers are missing");
			const configuration = decodeConfigurationRegister(configurationCandidate);
			const laneState = decodeLaneStateRegister(laneStateCandidate);
			const mainLeaf = decodeMainLeafRegister(leafCandidate);
			const currentOperationId = laneState.value.currentOperationId;
			let runOperation: CurrentRegister<RunOperation> | undefined;
			let runState: CurrentRegister<RunState> | undefined;
			if (currentOperationId !== null) {
				const [metadataCandidate, stateCandidate] = await Promise.all([
					this.#storage.getRegister("op.meta", currentOperationId),
					this.#storage.getRegister("op.state", currentOperationId),
				]);
				if (!metadataCandidate || !stateCandidate)
					throw new SessionError("corruption", "Open operation registers are missing");
				runOperation = decodeRunOperationRegister(metadataCandidate, currentOperationId);
				runState = decodeRunStateRegister(stateCandidate, currentOperationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, runOperation, runState);
			const attachment = Object.freeze({
				laneConfiguration: configuration,
				laneState,
				mainLeaf,
				runOperation,
				runState,
				...hydrated,
			});
			const phase = runState?.value.phase;
			const generation = phase?.kind === "assistant" ? phase.generation : undefined;
			const current =
				configuration.seq === transition.expectedConfigurationSeq &&
				laneState.seq === transition.expectedLaneStateSeq &&
				mainLeaf.seq === transition.expectedLeafSeq &&
				mainLeaf.value === transition.expectedLeafId &&
				currentOperationId === transition.operationId &&
				runState?.seq === transition.expectedOperationStateSeq &&
				generation?.status === "ready" &&
				generation.context.stepId === transition.stepId &&
				generation.nextAttempt === transition.attempt &&
				generation.context.configuration.model.provider === transition.expectedProvider &&
				generation.context.configuration.model.modelId === transition.expectedModelId;
			if (!current) return Object.freeze({ committed: false as const, attachment });
			if (!runOperation || !runState || generation?.status !== "ready")
				throw new SessionError("corruption", "Validated assistant effect changed inside the mutation line");

			const responseEntryId = this.idGenerator.next();
			const usageId = this.idGenerator.next();
			const directlyNamed = new Set([
				transition.operationId,
				transition.stepId,
				generation.context.triggerEntryId,
				...(runOperation.value.sourceLeafId === null ? [] : [runOperation.value.sourceLeafId]),
				...runOperation.value.intent.promptEntryIds,
				...(runState.value.latestAssistantEntryId === null ? [] : [runState.value.latestAssistantEntryId]),
			]);
			if (responseEntryId === usageId || directlyNamed.has(responseEntryId) || directlyNamed.has(usageId))
				throw new SessionError("storage", "Generated assistant effect IDs are not unique");
			const ids = [responseEntryId, usageId];
			const [occupiedEntries, occupiedUsageRows, ...occupiedRegisters] = await Promise.all([
				this.#storage.getEntries(ids),
				this.#storage.getUsageRows(ids),
				...ids.flatMap((id) => [
					this.#storage.getRegister("op.meta", id),
					this.#storage.getRegister("op.state", id),
				]),
			]);
			if (occupiedEntries.size > 0 || occupiedUsageRows.size > 0 || occupiedRegisters.some(Boolean))
				throw new SessionError("storage", "Generated assistant effect ID is already occupied");

			const nextState: RunState = {
				...runState.value,
				phase: {
					kind: "assistant",
					generation: {
						status: "effect_pending",
						context: structuredClone(generation.context),
						attempt: transition.attempt,
						responseEntryId,
						usageId,
						intendedOutputLimit: transition.intendedOutputLimit,
						contextWindow: transition.contextWindow,
					},
				},
			};
			const committed = await this.#storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: transition.operationId,
						value: encodeRunState(nextState, transition.operationId),
					},
				],
			});
			return Object.freeze({
				committed: true as const,
				responseEntryId,
				usageId,
				attachment: Object.freeze({
					...attachment,
					runState: Object.freeze({ seq: committed.seqs[0], value: structuredClone(nextState) }),
				}),
			});
		});
		this.#mutationLine = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation.catch((error) => {
			throw storageFailure(error);
		});
	}

	settleAssistantEffect(transition: SettleAssistantEffectTransition): Promise<SettleAssistantEffectResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		const operation = this.#mutationLine.then(async () => {
			const [configurationCandidate, laneStateCandidate, leafCandidate] = await Promise.all([
				this.#storage.getRegister(CONFIG_NAMESPACE, MAIN),
				this.#storage.getRegister(STATE_NAMESPACE, MAIN),
				this.#storage.getRegister(LEAF_NAMESPACE, MAIN),
			]);
			if (!configurationCandidate || !laneStateCandidate)
				throw new SessionError("corruption", "Main lane registers are missing");
			const configuration = decodeConfigurationRegister(configurationCandidate);
			const laneState = decodeLaneStateRegister(laneStateCandidate);
			const mainLeaf = decodeMainLeafRegister(leafCandidate);
			const currentOperationId = laneState.value.currentOperationId;
			let runOperation: CurrentRegister<RunOperation> | undefined;
			let runState: CurrentRegister<RunState> | undefined;
			if (currentOperationId !== null) {
				const [metadataCandidate, stateCandidate] = await Promise.all([
					this.#storage.getRegister("op.meta", currentOperationId),
					this.#storage.getRegister("op.state", currentOperationId),
				]);
				if (!metadataCandidate || !stateCandidate)
					throw new SessionError("corruption", "Open operation registers are missing");
				runOperation = decodeRunOperationRegister(metadataCandidate, currentOperationId);
				runState = decodeRunStateRegister(stateCandidate, currentOperationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, runOperation, runState);
			const attachment = Object.freeze({
				laneConfiguration: configuration,
				laneState,
				mainLeaf,
				runOperation,
				runState,
				...hydrated,
			});
			const phase = runState?.value.phase;
			const generation = phase?.kind === "assistant" ? phase.generation : undefined;
			if (
				currentOperationId !== transition.operationId ||
				!runOperation ||
				!runState ||
				generation?.status !== "effect_pending" ||
				generation.context.stepId !== transition.stepId ||
				generation.attempt !== transition.attempt ||
				generation.responseEntryId !== transition.responseEntryId ||
				generation.usageId !== transition.usageId ||
				generation.context.triggerEntryId !== transition.triggerEntryId ||
				generation.context.configuration.model.provider !== transition.provider ||
				generation.context.configuration.model.modelId !== transition.modelId ||
				generation.intendedOutputLimit !== transition.intendedOutputLimit ||
				generation.contextWindow !== transition.contextWindow
			)
				return Object.freeze({ status: "obsolete" as const, attachment });
			if (mainLeaf.value !== transition.triggerEntryId)
				throw new SessionError("corruption", "Pending assistant effect no longer closes the current leaf");

			const response = hydrated.entries.get(transition.responseEntryId);
			const usage = hydrated.usageRows.get(transition.usageId);
			if (response || usage) {
				if (!response || !usage)
					throw new SessionError("corruption", "Assistant settlement reservations materialized partially");
				if (
					response.parentId !== transition.triggerEntryId ||
					!isDeepStrictEqual(response.message, transition.message) ||
					usage.entryId !== transition.responseEntryId ||
					usage.adjustment ||
					!isDeepStrictEqual(usage.usage, transition.message.usage)
				)
					throw new SessionError(
						"corruption",
						"Materialized assistant settlement does not match the observed effect",
					);
				return Object.freeze({ status: "materialized" as const, attachment });
			}

			const classification = classifyAssistantSettlement(
				transition.message,
				generation.intendedOutputLimit,
				runState.value.control.status,
			);
			if (classification === "corruption")
				throw new SessionError("corruption", "Assistant aborted while durable control is running");
			if (classification === "unsupported")
				return Object.freeze({ status: "unsupported" as const, classification, attachment });

			const nextState: RunState = {
				...runState.value,
				latestAssistantEntryId: transition.responseEntryId,
				phase: {
					kind: "checkpoint",
					continuation: { kind: "may_finish", includeFinalAssistant: true },
					triggerEntryId: transition.responseEntryId,
				},
			};
			const committed = await this.#storage.commit({
				writes: [
					{
						kind: "entry",
						entry: {
							id: transition.responseEntryId,
							parentId: transition.triggerEntryId,
							type: "message",
							payload: encodeMessage(transition.message),
						},
					},
					{ kind: "register", op: "set", namespace: LEAF_NAMESPACE, key: MAIN, value: transition.responseEntryId },
					{
						kind: "usage",
						row: {
							id: transition.usageId,
							entryId: transition.responseEntryId,
							usage: structuredClone(transition.message.usage),
							adjustment: false,
						},
					},
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: transition.operationId,
						value: encodeRunState(nextState, transition.operationId),
					},
				],
			});
			const entries = new Map(hydrated.entries);
			entries.set(
				transition.responseEntryId,
				Object.freeze({
					id: transition.responseEntryId,
					parentId: transition.triggerEntryId,
					seq: committed.seqs[0],
					timestamp: committed.timestamp,
					type: "message" as const,
					message: structuredClone(transition.message),
				}),
			);
			const usageRows = new Map(hydrated.usageRows);
			usageRows.set(
				transition.usageId,
				Object.freeze({
					id: transition.usageId,
					seq: committed.seqs[2],
					entryId: transition.responseEntryId,
					usage: structuredClone(transition.message.usage),
					adjustment: false,
				}),
			);
			return Object.freeze({
				status: "committed" as const,
				attachment: Object.freeze({
					...attachment,
					mainLeaf: Object.freeze({ seq: committed.seqs[1], value: transition.responseEntryId }),
					runState: Object.freeze({ seq: committed.seqs[3], value: structuredClone(nextState) }),
					entries,
					usageRows,
				}),
			});
		});
		this.#mutationLine = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation.catch((error) => {
			throw storageFailure(error);
		});
	}

	finishRun(transition: FinishRunTransition): Promise<FinishRunResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		const operation = this.#mutationLine.then(async () => {
			const [configurationCandidate, laneStateCandidate, leafCandidate] = await Promise.all([
				this.#storage.getRegister(CONFIG_NAMESPACE, MAIN),
				this.#storage.getRegister(STATE_NAMESPACE, MAIN),
				this.#storage.getRegister(LEAF_NAMESPACE, MAIN),
			]);
			if (!configurationCandidate || !laneStateCandidate)
				throw new SessionError("corruption", "Main lane registers are missing");
			const configuration = decodeConfigurationRegister(configurationCandidate);
			const laneState = decodeLaneStateRegister(laneStateCandidate);
			const mainLeaf = decodeMainLeafRegister(leafCandidate);
			const currentOperationId = laneState.value.currentOperationId;
			let runOperation: CurrentRegister<RunOperation> | undefined;
			let runState: CurrentRegister<RunState> | undefined;
			if (currentOperationId !== null) {
				const [metadataCandidate, stateCandidate] = await Promise.all([
					this.#storage.getRegister("op.meta", currentOperationId),
					this.#storage.getRegister("op.state", currentOperationId),
				]);
				if (!metadataCandidate || !stateCandidate)
					throw new SessionError("corruption", "Open operation registers are missing");
				runOperation = decodeRunOperationRegister(metadataCandidate, currentOperationId);
				runState = decodeRunStateRegister(stateCandidate, currentOperationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, runOperation, runState);
			const attachment = Object.freeze({
				laneConfiguration: configuration,
				laneState,
				mainLeaf,
				runOperation,
				runState,
				...hydrated,
			});
			if (
				laneState.seq !== transition.expectedLaneStateSeq ||
				currentOperationId !== transition.operationId ||
				runState?.seq !== transition.expectedOperationStateSeq
			)
				return Object.freeze({ status: "obsolete" as const, attachment });
			if (!runOperation || !runState)
				throw new SessionError("corruption", "Validated finish authority changed inside the mutation line");
			const phase = runState.value.phase;
			if (
				runOperation.value.operationId !== transition.operationId ||
				runOperation.value.lane !== MAIN ||
				runState.value.control.status !== "running" ||
				phase.kind !== "checkpoint" ||
				phase.continuation.kind !== "may_finish" ||
				phase.continuation.includeFinalAssistant !== true ||
				runState.value.inbox.steer.length !== 0 ||
				runState.value.inbox.followUp.length !== 0 ||
				runState.value.inbox.writes.length !== 0 ||
				mainLeaf.value === null ||
				mainLeaf.value !== phase.triggerEntryId ||
				mainLeaf.value !== runState.value.latestAssistantEntryId
			)
				throw new SessionError("corruption", "Run is not at a valid Phase 1 finish boundary");
			const finalEntry = hydrated.entries.get(mainLeaf.value);
			if (!finalEntry || finalEntry.message.role !== "assistant")
				throw new SessionError("corruption", "Final assistant entry is missing or invalid");

			const [toolArgs, preparations] = await Promise.all([
				this.#storage.listRegisters("op.tool_args"),
				this.#storage.listRegisters("op.preparation"),
			]);
			const prefix = `${transition.operationId}:`;
			const validateDefensiveRegisters = (registers: typeof toolArgs, namespace: string) =>
				registers.map((register) => {
					try {
						assertRegister(register);
					} catch (error) {
						throw new SessionError("corruption", "Malformed defensive operation register", error);
					}
					if (register.namespace !== namespace)
						throw new SessionError("corruption", "Defensive operation register has the wrong namespace");
					return register;
				});
			const defensive = [
				...validateDefensiveRegisters(toolArgs, "op.tool_args")
					.filter(({ key }) => key.startsWith(prefix))
					.sort((left, right) => left.key.localeCompare(right.key)),
				...validateDefensiveRegisters(preparations, "op.preparation")
					.filter(({ key }) => key.startsWith(prefix))
					.sort((left, right) => left.key.localeCompare(right.key)),
			];
			const durableResult = encodeLaneLastResult({
				operationId: transition.operationId,
				kind: "run",
				outcome: "completed",
				leafId: mainLeaf.value,
				finalAssistantEntryId: mainLeaf.value,
				runCompletion: "assistant",
			});
			const result: FinishedRunResult = Object.freeze({
				operationId: transition.operationId,
				kind: "completed",
				leafId: mainLeaf.value,
				finalEntryId: mainLeaf.value,
				finalMessage: structuredClone(finalEntry.message),
			});
			const nextLaneState: LaneState = { ...laneState.value, currentOperationId: null };
			const writes: Write[] = [
				{ kind: "register", op: "delete", namespace: "op.meta", key: transition.operationId },
				{ kind: "register", op: "delete", namespace: "op.state", key: transition.operationId },
				...defensive.map(({ namespace, key }) => ({
					kind: "register" as const,
					op: "delete" as const,
					namespace,
					key,
				})),
				{ kind: "register", op: "set", namespace: LAST_RESULT_NAMESPACE, key: MAIN, value: durableResult },
				{
					kind: "register",
					op: "set",
					namespace: STATE_NAMESPACE,
					key: MAIN,
					value: structuredClone(nextLaneState) as unknown as JsonValue,
				},
			];
			const committed = await this.#storage.commit({ writes });
			return Object.freeze({
				status: "committed" as const,
				result,
				attachment: Object.freeze({
					laneConfiguration: configuration,
					laneState: Object.freeze({ seq: committed.seqs.at(-1)!, value: structuredClone(nextLaneState) }),
					mainLeaf,
					entries: hydrated.entries,
					usageRows: hydrated.usageRows,
				}),
			});
		});
		this.#mutationLine = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation.catch((error) => {
			throw storageFailure(error);
		});
	}

	acceptPrompt(transition: AcceptPromptTransition): Promise<AcceptPromptResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		if (transition.messages.length === 0)
			return Promise.reject(new SessionError("invalid_query", "Prompt must contain at least one message"));
		const operation = this.#mutationLine.then(async () => {
			const [configurationCandidate, laneStateCandidate, leafCandidate] = await Promise.all([
				this.#storage.getRegister(CONFIG_NAMESPACE, MAIN),
				this.#storage.getRegister(STATE_NAMESPACE, MAIN),
				this.#storage.getRegister(LEAF_NAMESPACE, MAIN),
			]);
			if (!configurationCandidate || !laneStateCandidate)
				throw new SessionError("corruption", "Main lane registers are missing");
			const configuration = decodeConfigurationRegister(configurationCandidate);
			const laneState = decodeLaneStateRegister(laneStateCandidate);
			const mainLeaf = decodeMainLeafRegister(leafCandidate);
			let currentRunOperation: CurrentRegister<RunOperation> | undefined;
			let currentRunState: CurrentRegister<RunState> | undefined;
			if (laneState.value.currentOperationId !== null) {
				const operationId = laneState.value.currentOperationId;
				const [metadataCandidate, stateCandidate] = await Promise.all([
					this.#storage.getRegister("op.meta", operationId),
					this.#storage.getRegister("op.state", operationId),
				]);
				if (!metadataCandidate || !stateCandidate)
					throw new SessionError("corruption", "Open operation registers are missing");
				currentRunOperation = decodeRunOperationRegister(metadataCandidate, operationId);
				currentRunState = decodeRunStateRegister(stateCandidate, operationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, currentRunOperation, currentRunState);
			const attachment = Object.freeze({
				laneConfiguration: configuration,
				laneState,
				mainLeaf,
				runOperation: currentRunOperation,
				runState: currentRunState,
				...hydrated,
			});
			const expectedIdentity =
				configuration.value.model.provider === transition.expectedProvider &&
				configuration.value.model.modelId === transition.expectedModelId;
			if (
				configuration.seq !== transition.expectedConfigurationSeq ||
				laneState.seq !== transition.expectedLaneStateSeq ||
				mainLeaf.seq !== transition.expectedLeafSeq ||
				!expectedIdentity
			)
				return Object.freeze({ status: "stale" as const, attachment });
			if (laneState.value.currentOperationId !== null) return Object.freeze({ status: "busy" as const, attachment });
			if (!transition.identityAvailable) return Object.freeze({ status: "unavailable" as const, attachment });

			const operationId = this.idGenerator.next();
			const entryIds = transition.messages.map(() => this.idGenerator.next());
			const candidates = [operationId, ...entryIds];
			if (new Set(candidates).size !== candidates.length)
				throw new SessionError("storage", "Generated prompt acceptance IDs are not unique");
			const [occupiedEntries, occupiedUsageRows, ...occupiedRegisters] = await Promise.all([
				this.#storage.getEntries(candidates),
				this.#storage.getUsageRows(candidates),
				...candidates.flatMap((id) => [
					this.#storage.getRegister("op.meta", id),
					this.#storage.getRegister("op.state", id),
				]),
			]);
			if (occupiedEntries.size > 0 || occupiedUsageRows.size > 0 || occupiedRegisters.some(Boolean))
				throw new SessionError("storage", "Generated prompt acceptance ID is already occupied");

			const runOperation: RunOperation = {
				operationId,
				lane: "main",
				sourceLeafId: mainLeaf.value,
				startedAt: Date.now(),
				intent: { kind: "run", promptEntryIds: entryIds },
			};
			const runState: RunState = {
				kind: "run",
				control: { status: "running" },
				settings: {
					compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
					steeringMode: "all",
					followUpMode: "all",
					toolExecution: "sequential",
				},
				phase: {
					kind: "checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId: entryIds.at(-1)!,
				},
				inbox: { steer: [], followUp: [], writes: [] },
				latestAssistantEntryId: null,
			};
			const writes = transition.messages.map((message, index) => ({
				kind: "entry" as const,
				entry: {
					id: entryIds[index],
					parentId: index === 0 ? mainLeaf.value : entryIds[index - 1],
					type: "message" as const,
					payload: encodeMessage(message),
				},
			}));
			const committed = await this.#storage.commit({
				writes: [
					...writes,
					{ kind: "register", op: "set", namespace: LEAF_NAMESPACE, key: MAIN, value: entryIds.at(-1)! },
					{
						kind: "register",
						op: "set",
						namespace: "op.meta",
						key: operationId,
						value: encodeRunOperation(runOperation),
					},
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: encodeRunState(runState, operationId),
					},
					{
						kind: "register",
						op: "set",
						namespace: STATE_NAMESPACE,
						key: MAIN,
						value: { currentOperationId: operationId, pendingNextRun: [] },
					},
				],
			});
			const entries = new Map(hydrated.entries);
			for (let index = 0; index < transition.messages.length; index++)
				entries.set(
					entryIds[index],
					Object.freeze({
						id: entryIds[index],
						parentId: index === 0 ? mainLeaf.value : entryIds[index - 1],
						seq: committed.seqs[index],
						timestamp: committed.timestamp,
						type: "message" as const,
						message: structuredClone(transition.messages[index]),
					}),
				);
			const offset = transition.messages.length;
			return Object.freeze({
				status: "committed" as const,
				attachment: Object.freeze({
					laneConfiguration: configuration,
					laneState: Object.freeze({
						seq: committed.seqs[offset + 3],
						value: { currentOperationId: operationId, pendingNextRun: [] },
					}),
					mainLeaf: Object.freeze({ seq: committed.seqs[offset], value: entryIds.at(-1)! }),
					runOperation: Object.freeze({ seq: committed.seqs[offset + 1], value: structuredClone(runOperation) }),
					runState: Object.freeze({ seq: committed.seqs[offset + 2], value: structuredClone(runState) }),
					entries,
					usageRows: hydrated.usageRows,
				}),
			});
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
