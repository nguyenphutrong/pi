import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
	assertJsonValue,
	assertRegister,
	assertUsageRow,
	createFollowerId,
	createIdGenerator,
	type EntryScan,
	type IdGenerator,
	isUuidV7,
	type JsonValue,
	type Register,
	type Storage,
	StorageError,
	type UsageRow,
	type Write,
} from "@nguyenphutrong/pi-session-storage";
import { classifyAssistantSettlement } from "./assistant-settlement.ts";
import {
	decodeMessageEntry,
	decodePendingMessageEntry,
	encodeMessage,
	encodePendingMessageEntry,
	type PendingMessageEntry,
} from "./codec.ts";
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
	readonly pendingEntries: ReadonlyMap<string, PendingMessageEntry>;
	readonly usageRows: ReadonlyMap<string, UsageRow>;
	readonly toolArguments: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>;
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
	readonly #values: Map<K, V>;

	constructor(values?: Iterable<readonly [K, V]>) {
		this.#values = new Map(values);
		Object.freeze(this);
	}

	get size(): number {
		return this.#values.size;
	}

	get(key: K): V | undefined {
		return this.#values.get(key);
	}

	has(key: K): boolean {
		return this.#values.has(key);
	}

	entries(): MapIterator<[K, V]> {
		return this.#values.entries();
	}

	keys(): MapIterator<K> {
		return this.#values.keys();
	}

	values(): MapIterator<V> {
		return this.#values.values();
	}

	forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
		for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
	}

	[Symbol.iterator](): MapIterator<[K, V]> {
		return this.#values[Symbol.iterator]();
	}

	get [Symbol.toStringTag](): string {
		return "Map";
	}
}

async function hydrateCurrentState(
	storage: Storage,
	mainLeaf: CurrentRegister<string | null>,
	laneState: CurrentRegister<LaneState>,
	runOperation?: CurrentRegister<RunOperation>,
	runState?: CurrentRegister<RunState>,
): Promise<CurrentStateHydration> {
	const entryIds = new Set<string>();
	const usageIds = new Set<string>();
	if (mainLeaf.value !== null) entryIds.add(mainLeaf.value);
	for (const id of laneState.value.pendingNextRun) entryIds.add(id);

	let triggerEntryId: string | undefined;
	let responseEntryId: string | undefined;
	let usageId: string | undefined;
	let toolBatch: Extract<RunState["phase"], { kind: "tools" }>["batch"] | undefined;
	if (runOperation && runState) {
		if (runOperation.value.sourceLeafId !== null) entryIds.add(runOperation.value.sourceLeafId);
		for (const id of runOperation.value.intent.promptEntryIds) entryIds.add(id);
		if (runState.value.phase.kind === "checkpoint") triggerEntryId = runState.value.phase.triggerEntryId;
		else if (runState.value.phase.kind === "assistant") {
			triggerEntryId = runState.value.phase.generation.context.triggerEntryId;
			if (runState.value.phase.generation.status === "effect_pending") {
				responseEntryId = runState.value.phase.generation.responseEntryId;
				usageId = runState.value.phase.generation.usageId;
				entryIds.add(responseEntryId);
				entryIds.add(usageId);
				usageIds.add(responseEntryId);
				usageIds.add(usageId);
			}
		} else if (runState.value.phase.kind === "tools") {
			toolBatch = runState.value.phase.batch;
			triggerEntryId = toolBatch.assistantEntryId;
			entryIds.add(toolBatch.assistantEntryId);
			for (const call of toolBatch.calls) {
				entryIds.add(call.resultEntryId);
				usageIds.add(call.resultEntryId);
				if (call.status === "completed") entryIds.add(call.resultEntryId);
			}
		} else {
			triggerEntryId = runState.value.phase.provenance.entryId;
		}
		entryIds.add(triggerEntryId);
		if (runState.value.latestAssistantEntryId !== null) entryIds.add(runState.value.latestAssistantEntryId);
	}

	const pendingRegisters = await Promise.all(
		laneState.value.pendingNextRun.map((id) => storage.getRegister("pending.entry", id)),
	);
	const [storedEntries, storedUsageRows] = await Promise.all([
		storage.getEntries([...entryIds]),
		storage.getUsageRows([...usageIds]),
	]);
	const toolArgumentRegisters =
		runOperation && toolBatch
			? await Promise.all(
					toolBatch.calls.map((call) =>
						storage.getRegister(
							"op.tool_args",
							`${runOperation.value.operationId}:${toolBatch.turnId}:${call.sourceIndex}`,
						),
					),
				)
			: [];
	const entries = new Map<string, MessageEntry>();
	for (const [id, candidate] of storedEntries) {
		const entry = decodeMessageEntry(candidate);
		if (entry.id !== id || !entryIds.has(id))
			throw new SessionError("corruption", "Current-state entry lookup returned the wrong identity");
		entries.set(id, entry);
	}
	const pendingEntries = new Map<string, PendingMessageEntry>();
	for (let index = 0; index < laneState.value.pendingNextRun.length; index++) {
		const id = laneState.value.pendingNextRun[index];
		const register = pendingRegisters[index];
		if (!register) throw new SessionError("corruption", "pendingNextRun references a missing pending entry");
		try {
			assertRegister(register);
		} catch (error) {
			throw new SessionError("corruption", "Malformed pending entry register", error);
		}
		if (register.namespace !== "pending.entry" || register.key !== id)
			throw new SessionError("corruption", "Pending entry register has the wrong identity");
		if (storedEntries.has(id)) throw new SessionError("corruption", "Pending entry is also materialized");
		pendingEntries.set(id, decodePendingMessageEntry(register.value));
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
	const toolArguments = new Map<string, Readonly<Record<string, JsonValue>>>();

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
		for (let index = 0; index < operation.intent.promptEntryIds.length; index++) {
			const id = operation.intent.promptEntryIds[index];
			const prompt = requireEntry(id, "Run prompt");
			if (index > 0 && prompt.parentId !== expectedParent)
				throw new SessionError("corruption", "Run prompt entries do not extend the operation source in order");
			expectedParent = id;
		}
		const trigger = requireEntry(triggerEntryId, "Current trigger");
		if (state.latestAssistantEntryId !== null) {
			const latest = requireEntry(state.latestAssistantEntryId, "Latest assistant");
			if (latest.message.role !== "assistant")
				throw new SessionError("corruption", "Latest assistant entry must contain an assistant message");
		}
		if (state.phase.kind === "failure_drain") {
			const expectedError = {
				code: "provider_interrupted",
				message: "Provider outcome unknown after interruption",
			};
			const expectedUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const syntheticMessageFields = new Set([
				"role",
				"content",
				"api",
				"provider",
				"model",
				"usage",
				"stopReason",
				"errorMessage",
				"timestamp",
			]);
			if (
				mainLeaf.value !== triggerEntryId ||
				state.latestAssistantEntryId !== triggerEntryId ||
				!isDeepStrictEqual(state.phase.error, expectedError) ||
				trigger.message.role !== "assistant" ||
				!isExactDataObject(trigger.message, syntheticMessageFields) ||
				trigger.message.content.length !== 0 ||
				trigger.message.api !== "harness" ||
				!isDeepStrictEqual(trigger.message.usage, expectedUsage) ||
				trigger.message.stopReason !== "error" ||
				trigger.message.errorMessage !== expectedError.message
			)
				throw new SessionError("corruption", "Failure drain has an invalid assistant closure");
		} else if (state.phase.kind === "tools") {
			const batch = state.phase.batch;
			const assistant = requireEntry(batch.assistantEntryId, "Tool batch assistant");
			const sourceCalls =
				assistant.message.role === "assistant"
					? assistant.message.content.filter((content) => content.type === "toolCall")
					: [];
			if (
				state.latestAssistantEntryId !== batch.assistantEntryId ||
				assistant.message.role !== "assistant" ||
				batch.calls.length !== sourceCalls.length
			)
				throw new SessionError("corruption", "Tool batch has an invalid assistant closure");
			let expectedToolParent = batch.assistantEntryId;
			let unfinishedSeen = false;
			for (const call of batch.calls) {
				const source = sourceCalls[call.sourceIndex];
				if (!source) throw new SessionError("corruption", "Tool batch source mapping is incomplete");
				const result = entries.get(call.resultEntryId);
				const resultUsage = usageRows.get(call.resultEntryId);
				if (call.status === "planned") {
					unfinishedSeen = true;
					if (result || resultUsage || toolArgumentRegisters[call.sourceIndex])
						throw new SessionError("corruption", "Planned tool result reservation is already materialized");
				} else if (call.status === "effect_pending") {
					unfinishedSeen = true;
					const args = toolArgumentRegisters[call.sourceIndex];
					if (result || resultUsage || !args)
						throw new SessionError(
							"corruption",
							"Pending tool call has invalid arguments or result reservations",
						);
					try {
						assertRegister(args);
						assertJsonValue(args.value);
					} catch (error) {
						throw new SessionError("corruption", "Pending tool arguments register is malformed", error);
					}
					if (
						args.namespace !== "op.tool_args" ||
						args.key !== `${operation.operationId}:${batch.turnId}:${call.sourceIndex}` ||
						args.value === null ||
						typeof args.value !== "object" ||
						Array.isArray(args.value)
					)
						throw new SessionError("corruption", "Pending tool arguments register has invalid identity or value");
					toolArguments.set(args.key, Object.freeze(structuredClone(args.value)));
				} else if (call.status === "completed") {
					if (
						unfinishedSeen ||
						!result ||
						result.parentId !== expectedToolParent ||
						result.message.role !== "toolResult" ||
						result.message.toolCallId !== source.id ||
						result.message.toolName !== source.name
					)
						throw new SessionError("corruption", "Completed tool result does not match its source call");
					expectedToolParent = call.resultEntryId;
				}
			}
			if (mainLeaf.value !== expectedToolParent)
				throw new SessionError("corruption", "Tool batch lane leaf does not close its completed result prefix");
		} else if (
			(state.phase.kind === "checkpoint" || state.phase.kind === "assistant") &&
			state.latestAssistantEntryId !== null
		) {
			if (mainLeaf.value !== triggerEntryId)
				throw new SessionError("corruption", "Assistant trigger must close the current lane leaf");
			if (
				state.phase.kind === "checkpoint" &&
				state.phase.continuation.kind === "may_finish" &&
				state.phase.continuation.includeFinalAssistant
			) {
				if (trigger.message.role !== "assistant")
					throw new SessionError("corruption", "Finished generation has an invalid assistant closure");
				if (
					trigger.message.stopReason === "aborted" &&
					(state.control.status !== "cancel_requested" ||
						typeof trigger.message.errorMessage !== "string" ||
						state.latestAssistantEntryId !== triggerEntryId ||
						mainLeaf.value !== triggerEntryId)
				)
					throw new SessionError("corruption", "Aborted generation has an invalid assistant closure");
			} else if (state.latestAssistantEntryId === triggerEntryId || trigger.message.role !== "toolResult")
				throw new SessionError("corruption", "Post-tool trigger must contain a tool result after its assistant");
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
	return Object.freeze({ entries, pendingEntries: new ImmutableMap(pendingEntries), usageRows, toolArguments });
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
		await hydrateCurrentState(storage, leaf, laneState, runOperation, runState);
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
	readonly pendingEntries: ReadonlyMap<string, PendingMessageEntry>;
	readonly usageRows: ReadonlyMap<string, UsageRow>;
	readonly toolArguments: ReadonlyMap<string, Readonly<Record<string, JsonValue>>>;
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
	readonly expectedPendingNextRun: readonly string[];
	readonly expectedLeafSeq: number;
	readonly expectedProvider: string;
	readonly expectedModelId: string;
	readonly identityAvailable: boolean;
}

export type AcceptPromptResult =
	| { readonly status: "committed"; readonly attachment: RuntimeAttachment }
	| { readonly status: "stale" | "busy" | "unavailable"; readonly attachment: RuntimeAttachment };

export type CancelQueuedOutcome = "cancelled" | "already_consumed" | "not_found";

export interface QueueMutationResult {
	readonly attachment: RuntimeAttachment;
	readonly entryId?: string;
	readonly outcome?: CancelQueuedOutcome;
}

export interface RuntimeTransitionResult {
	readonly committed: boolean;
	readonly attachment: RuntimeAttachment;
}

export interface FinishRunTransition {
	readonly operationId: string;
	readonly expectedOperationStateSeq: number;
}

export interface RecoverAssistantEffectTransition {
	readonly operationId: string;
	readonly stepId: string;
	readonly attempt: number;
	readonly responseEntryId: string;
	readonly usageId: string;
	readonly expectedOperationStateSeq: number;
	readonly expectedLaneStateSeq: number;
}

export interface ReleaseAssistantRetryTransition {
	readonly operationId: string;
	readonly stepId: string;
	readonly nextAttempt: number;
	readonly notBefore: number;
	readonly expectedOperationStateSeq: number;
	readonly expectedLaneStateSeq: number;
}

export type RecoveryTransitionResult = {
	readonly status: "committed" | "obsolete";
	readonly attachment: RuntimeAttachment;
};

export type FinishedRunResult = {
	readonly operationId: string;
	readonly kind: "completed";
	readonly leafId: string;
} & (
	| { readonly finalEntryId: string; readonly finalMessage: AssistantMessage }
	| { readonly finalEntryId?: never; readonly finalMessage?: never }
);

export interface FailedRunResult {
	readonly operationId: string;
	readonly kind: "failed";
	readonly leafId: string;
	readonly finalEntryId: string;
	readonly error: { readonly code: string; readonly message: string };
}

export type FinishRunResult =
	| {
			readonly status: "committed";
			readonly attachment: RuntimeAttachment;
			readonly result: FinishedRunResult | FailedRunResult | AbortedRunResult;
	  }
	| { readonly status: "obsolete"; readonly attachment: RuntimeAttachment; readonly result?: undefined };

export interface AbortedRunResult {
	readonly operationId: string;
	readonly kind: "aborted";
	readonly leafId: string;
	readonly finalEntryId?: string;
	readonly finalMessage?: AssistantMessage;
}

export type AbortRequestResult =
	| {
			readonly status: "committed" | "already_requested";
			readonly operationId: string;
			readonly attachment: RuntimeAttachment;
	  }
	| { readonly status: "no_active"; readonly attachment: RuntimeAttachment };

export type EffectStartResult = {
	readonly status: "started" | "not_started" | "obsolete";
	readonly attachment: RuntimeAttachment;
};

export interface AssistantEffectStartTransition {
	readonly operationId: string;
	readonly stepId: string;
	readonly attempt: number;
	readonly responseEntryId: string;
	readonly usageId: string;
}

export interface ToolEffectStartTransition {
	readonly operationId: string;
	readonly assistantEntryId: string;
	readonly turnId: string;
	readonly sourceIndex: number;
	readonly resultEntryId: string;
	readonly replay: "never" | "safe";
}

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

export type ClearToolCallOutcome =
	| {
			readonly kind: "prepared";
			readonly toolCall: ToolCall;
			readonly args: { readonly [key: string]: JsonValue };
			readonly replay: "never" | "safe";
	  }
	| {
			readonly kind: "immediate";
			readonly toolCall: ToolCall;
			readonly result: {
				readonly content: ToolResultMessage["content"];
				readonly details: JsonValue;
				readonly addedToolNames?: string[];
			};
			readonly isError: true;
			readonly terminate: boolean;
	  };

export interface ClearToolCallTransition {
	readonly operationId: string;
	readonly assistantEntryId: string;
	readonly turnId: string;
	readonly sourceIndex: number;
	readonly resultEntryId: string;
	readonly expectedOperationStateSeq: number;
	readonly expectedLaneStateSeq: number;
	readonly expectedLeafSeq: number;
	readonly expectedLeafId: string | null;
	readonly outcome: ClearToolCallOutcome;
}

export type ClearToolCallResult = {
	readonly status: "committed" | "obsolete";
	readonly attachment: RuntimeAttachment;
};

export interface SettleToolCallTransition {
	readonly operationId: string;
	readonly assistantEntryId: string;
	readonly turnId: string;
	readonly sourceIndex: number;
	readonly resultEntryId: string;
	readonly replay: "never" | "safe";
	readonly toolCall: ToolCall;
	readonly args: { readonly [key: string]: JsonValue };
	readonly content: ToolResultMessage["content"];
	readonly details: JsonValue;
	readonly usage?: Usage;
	readonly addedToolNames?: string[];
	readonly isError: boolean;
	readonly terminate: boolean;
}

export type SettleToolCallResult = {
	readonly status: "committed" | "obsolete";
	readonly attachment: RuntimeAttachment;
};

const PREPARED_CLEARANCE_FIELDS = new Set(["kind", "toolCall", "args", "replay"]);
const IMMEDIATE_CLEARANCE_FIELDS = new Set(["kind", "toolCall", "result", "isError", "terminate"]);
const TOOL_CALL_FIELDS = new Set(["type", "id", "name", "arguments", "thoughtSignature", "namespace"]);
const IMMEDIATE_RESULT_FIELDS = new Set(["content", "details", "addedToolNames"]);

function validateClearToolCallOutcome(outcome: unknown): asserts outcome is ClearToolCallOutcome {
	try {
		assertJsonValue(outcome);
	} catch (error) {
		throw new SessionError("invalid_query", "Tool clearance outcome must be detached JSON data", error);
	}
	if (
		!isExactDataObject(
			outcome,
			isExactDataObject(outcome, PREPARED_CLEARANCE_FIELDS) && outcome.kind === "prepared"
				? PREPARED_CLEARANCE_FIELDS
				: IMMEDIATE_CLEARANCE_FIELDS,
		)
	)
		throw new SessionError("invalid_query", "Tool clearance outcome has unsupported fields");
	if (!isExactDataObject(outcome.toolCall, TOOL_CALL_FIELDS))
		throw new SessionError("invalid_query", "Tool clearance source must be a plain tool call");
	const toolCall = outcome.toolCall;
	if (
		toolCall.type !== "toolCall" ||
		typeof toolCall.id !== "string" ||
		typeof toolCall.name !== "string" ||
		toolCall.arguments === null ||
		typeof toolCall.arguments !== "object" ||
		Array.isArray(toolCall.arguments) ||
		!isExactDataObject(toolCall.arguments, new Set(Object.keys(toolCall.arguments))) ||
		(toolCall.thoughtSignature !== undefined && typeof toolCall.thoughtSignature !== "string") ||
		(toolCall.namespace !== undefined && typeof toolCall.namespace !== "string")
	)
		throw new SessionError("invalid_query", "Tool clearance source is invalid");
	if (outcome.kind === "prepared") {
		if (
			!Object.hasOwn(outcome, "args") ||
			outcome.args === null ||
			typeof outcome.args !== "object" ||
			Array.isArray(outcome.args) ||
			!isExactDataObject(outcome.args, new Set(Object.keys(outcome.args))) ||
			(outcome.replay !== "never" && outcome.replay !== "safe")
		)
			throw new SessionError("invalid_query", "Prepared tool clearance data is invalid");
		return;
	}
	if (
		outcome.kind !== "immediate" ||
		outcome.isError !== true ||
		typeof outcome.terminate !== "boolean" ||
		!isExactDataObject(outcome.result, IMMEDIATE_RESULT_FIELDS) ||
		!Array.isArray(outcome.result.content) ||
		!Object.hasOwn(outcome.result, "details") ||
		(outcome.result.addedToolNames !== undefined &&
			(!Array.isArray(outcome.result.addedToolNames) ||
				!outcome.result.addedToolNames.every((name) => typeof name === "string")))
	)
		throw new SessionError("invalid_query", "Immediate tool clearance data is invalid");
}

const SETTLE_TOOL_FIELDS = new Set([
	"operationId",
	"assistantEntryId",
	"turnId",
	"sourceIndex",
	"resultEntryId",
	"replay",
	"toolCall",
	"args",
	"content",
	"details",
	"usage",
	"addedToolNames",
	"isError",
	"terminate",
]);

function validateSettleToolCallTransition(transition: unknown): asserts transition is SettleToolCallTransition {
	try {
		assertJsonValue(transition);
	} catch (error) {
		throw new SessionError("invalid_query", "Tool settlement must be detached JSON data", error);
	}
	if (!isExactDataObject(transition, SETTLE_TOOL_FIELDS))
		throw new SessionError("invalid_query", "Tool settlement has unsupported fields");
	for (const field of ["operationId", "assistantEntryId", "turnId", "resultEntryId"] as const)
		if (typeof transition[field] !== "string" || !isUuidV7(transition[field]))
			throw new SessionError("invalid_query", `Tool settlement ${field} must be a UUIDv7`);
	if (!Number.isSafeInteger(transition.sourceIndex) || (transition.sourceIndex as number) < 0)
		throw new SessionError("invalid_query", "Tool settlement sourceIndex is invalid");
	if (transition.replay !== "never" && transition.replay !== "safe")
		throw new SessionError("invalid_query", "Tool settlement replay is invalid");
	validateClearToolCallOutcome({
		kind: "prepared",
		toolCall: transition.toolCall,
		args: transition.args,
		replay: transition.replay,
	});
	if (
		!Array.isArray(transition.content) ||
		!Object.hasOwn(transition, "details") ||
		typeof transition.isError !== "boolean" ||
		typeof transition.terminate !== "boolean" ||
		(transition.addedToolNames !== undefined &&
			(!Array.isArray(transition.addedToolNames) ||
				!transition.addedToolNames.every((name) => typeof name === "string")))
	)
		throw new SessionError("invalid_query", "Tool settlement result is invalid");
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

export class StoredSession implements Session {
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
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, runState);
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

	refreshRuntimeAttachment(): Promise<RuntimeAttachment> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		const operation = this.#mutationLine.then(async () => {
			const [configurationCandidate, laneStateCandidate, leafCandidate] = await Promise.all([
				this.#storage.getRegister(CONFIG_NAMESPACE, MAIN),
				this.#storage.getRegister(STATE_NAMESPACE, MAIN),
				this.#storage.getRegister(LEAF_NAMESPACE, MAIN),
			]);
			if (!configurationCandidate || !laneStateCandidate)
				throw new SessionError("corruption", "Main lane registers are missing");
			const laneConfiguration = decodeConfigurationRegister(configurationCandidate);
			const laneState = decodeLaneStateRegister(laneStateCandidate);
			const mainLeaf = decodeMainLeafRegister(leafCandidate);
			let runOperation: CurrentRegister<RunOperation> | undefined;
			let runState: CurrentRegister<RunState> | undefined;
			if (laneState.value.currentOperationId !== null) {
				const operationId = laneState.value.currentOperationId;
				const [metadataCandidate, stateCandidate] = await Promise.all([
					this.#storage.getRegister("op.meta", operationId),
					this.#storage.getRegister("op.state", operationId),
				]);
				if (!metadataCandidate || !stateCandidate)
					throw new SessionError("corruption", "Open operation registers are missing");
				runOperation = decodeRunOperationRegister(metadataCandidate, operationId);
				runState = decodeRunStateRegister(stateCandidate, operationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, runState);
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

	nextRun(message: Message): Promise<QueueMutationResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		let payload: JsonValue;
		try {
			payload = encodePendingMessageEntry(message);
		} catch (error) {
			return Promise.reject(error);
		}
		const operation = this.#mutationLine.then(async () => {
			const attachment = await this.#loadRuntimeAttachment();
			const entryId = this.idGenerator.next();
			const [entries, usage, meta, state, pending] = await Promise.all([
				this.#storage.getEntries([entryId]),
				this.#storage.getUsageRows([entryId]),
				this.#storage.getRegister("op.meta", entryId),
				this.#storage.getRegister("op.state", entryId),
				this.#storage.getRegister("pending.entry", entryId),
			]);
			if (entries.size > 0 || usage.size > 0 || meta || state || pending)
				throw new SessionError("storage", "Generated next-run entry ID is already occupied");
			const nextLaneState: LaneState = {
				...attachment.laneState.value,
				pendingNextRun: [...attachment.laneState.value.pendingNextRun, entryId],
			};
			const committed = await this.#storage.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "pending.entry", key: entryId, value: payload },
					{
						kind: "register",
						op: "set",
						namespace: STATE_NAMESPACE,
						key: MAIN,
						value: nextLaneState as unknown as JsonValue,
					},
				],
			});
			const pendingEntries = new Map(attachment.pendingEntries);
			pendingEntries.set(entryId, decodePendingMessageEntry(payload));
			return Object.freeze({
				entryId,
				attachment: Object.freeze({
					...attachment,
					laneState: Object.freeze({ seq: committed.seqs[1], value: structuredClone(nextLaneState) }),
					pendingEntries: new ImmutableMap(pendingEntries),
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

	cancelQueued(entryId: string): Promise<QueueMutationResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		if (!isUuidV7(entryId))
			return Promise.reject(new SessionError("invalid_query", "Queued entry id must be a UUIDv7"));
		const operation = this.#mutationLine.then(async () => {
			const attachment = await this.#loadRuntimeAttachment();
			if (!attachment.laneState.value.pendingNextRun.includes(entryId)) {
				const entry = await this.#storage.getEntries([entryId]);
				return Object.freeze({
					attachment,
					outcome: entry.has(entryId) ? ("already_consumed" as const) : ("not_found" as const),
				});
			}
			const nextLaneState: LaneState = {
				...attachment.laneState.value,
				pendingNextRun: attachment.laneState.value.pendingNextRun.filter((id) => id !== entryId),
			};
			const committed = await this.#storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: STATE_NAMESPACE,
						key: MAIN,
						value: nextLaneState as unknown as JsonValue,
					},
					{ kind: "register", op: "delete", namespace: "pending.entry", key: entryId },
				],
			});
			const pendingEntries = new Map(attachment.pendingEntries);
			pendingEntries.delete(entryId);
			return Object.freeze({
				outcome: "cancelled" as const,
				attachment: Object.freeze({
					...attachment,
					laneState: Object.freeze({ seq: committed.seqs[0], value: structuredClone(nextLaneState) }),
					pendingEntries: new ImmutableMap(pendingEntries),
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

	requestAbort(onCommitted: (attachment: RuntimeAttachment) => void): Promise<AbortRequestResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		const operation = this.#mutationLine.then(async () => {
			const attachment = await this.#loadRuntimeAttachment();
			const operationId = attachment.laneState.value.currentOperationId;
			if (operationId === null || !attachment.runState)
				return Object.freeze({ status: "no_active" as const, attachment });
			if (attachment.runState.value.control.status === "cancel_requested")
				return Object.freeze({ status: "already_requested" as const, operationId, attachment });
			const nextState: RunState = {
				...attachment.runState.value,
				control: { status: "cancel_requested", requestedAt: Date.now(), drainedSteer: [], drainedFollowUp: [] },
			};
			const committed = await this.#storage.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: encodeRunState(nextState, operationId),
					},
				],
			});
			const nextAttachment = Object.freeze({
				...attachment,
				runState: Object.freeze({ seq: committed.seqs[0], value: structuredClone(nextState) }),
			});
			onCommitted(nextAttachment);
			return Object.freeze({ status: "committed" as const, operationId, attachment: nextAttachment });
		});
		this.#mutationLine = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation.catch((error) => {
			throw storageFailure(error);
		});
	}

	async #loadRuntimeAttachment(): Promise<RuntimeAttachment> {
		const [configurationCandidate, laneStateCandidate, leafCandidate] = await Promise.all([
			this.#storage.getRegister(CONFIG_NAMESPACE, MAIN),
			this.#storage.getRegister(STATE_NAMESPACE, MAIN),
			this.#storage.getRegister(LEAF_NAMESPACE, MAIN),
		]);
		if (!configurationCandidate || !laneStateCandidate)
			throw new SessionError("corruption", "Main lane registers are missing");
		const laneConfiguration = decodeConfigurationRegister(configurationCandidate);
		const laneState = decodeLaneStateRegister(laneStateCandidate);
		const mainLeaf = decodeMainLeafRegister(leafCandidate);
		let runOperation: CurrentRegister<RunOperation> | undefined;
		let runState: CurrentRegister<RunState> | undefined;
		if (laneState.value.currentOperationId !== null) {
			const operationId = laneState.value.currentOperationId;
			const [meta, state] = await Promise.all([
				this.#storage.getRegister("op.meta", operationId),
				this.#storage.getRegister("op.state", operationId),
			]);
			if (!meta || !state) throw new SessionError("corruption", "Open operation registers are missing");
			runOperation = decodeRunOperationRegister(meta, operationId);
			runState = decodeRunStateRegister(state, operationId);
		}
		return Object.freeze({
			laneConfiguration,
			laneState,
			mainLeaf,
			runOperation,
			runState,
			...(await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, runState)),
		});
	}

	startAssistantEffect(transition: AssistantEffectStartTransition, start: () => void): Promise<EffectStartResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		const operation = this.#mutationLine.then(async () => {
			const attachment = await this.#loadRuntimeAttachment();
			const phase = attachment.runState?.value.phase;
			const generation = phase?.kind === "assistant" ? phase.generation : undefined;
			if (
				attachment.runOperation?.value.operationId !== transition.operationId ||
				generation?.status !== "effect_pending" ||
				generation.context.stepId !== transition.stepId ||
				generation.attempt !== transition.attempt ||
				generation.responseEntryId !== transition.responseEntryId ||
				generation.usageId !== transition.usageId
			)
				return Object.freeze({ status: "obsolete" as const, attachment });
			if (attachment.runState?.value.control.status !== "running")
				return Object.freeze({ status: "not_started" as const, attachment });
			start();
			return Object.freeze({ status: "started" as const, attachment });
		});
		this.#mutationLine = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	startToolEffect(transition: ToolEffectStartTransition, start: () => void): Promise<EffectStartResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		const operation = this.#mutationLine.then(async () => {
			const attachment = await this.#loadRuntimeAttachment();
			const phase = attachment.runState?.value.phase;
			const batch = phase?.kind === "tools" ? phase.batch : undefined;
			const call = batch?.calls[transition.sourceIndex];
			const firstUnfinished = batch?.calls.findIndex((candidate) => candidate.status !== "completed");
			if (
				attachment.runOperation?.value.operationId !== transition.operationId ||
				batch?.assistantEntryId !== transition.assistantEntryId ||
				batch.turnId !== transition.turnId ||
				firstUnfinished !== transition.sourceIndex ||
				call?.status !== "effect_pending" ||
				call.resultEntryId !== transition.resultEntryId ||
				call.replay !== transition.replay
			)
				return Object.freeze({ status: "obsolete" as const, attachment });
			if (attachment.runState?.value.control.status !== "running")
				return Object.freeze({ status: "not_started" as const, attachment });
			start();
			return Object.freeze({ status: "started" as const, attachment });
		});
		this.#mutationLine = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
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
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, state);
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
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, runState);
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

	recoverAssistantEffect(transition: RecoverAssistantEffectTransition): Promise<RecoveryTransitionResult> {
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
				const [meta, state] = await Promise.all([
					this.#storage.getRegister("op.meta", currentOperationId),
					this.#storage.getRegister("op.state", currentOperationId),
				]);
				if (!meta || !state) throw new SessionError("corruption", "Open operation registers are missing");
				runOperation = decodeRunOperationRegister(meta, currentOperationId);
				runState = decodeRunStateRegister(state, currentOperationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, runState);
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
				laneState.seq !== transition.expectedLaneStateSeq ||
				runState?.seq !== transition.expectedOperationStateSeq ||
				currentOperationId !== transition.operationId ||
				!runOperation ||
				!runState ||
				generation?.status !== "effect_pending" ||
				generation.context.stepId !== transition.stepId ||
				generation.attempt !== transition.attempt ||
				generation.responseEntryId !== transition.responseEntryId ||
				generation.usageId !== transition.usageId
			)
				return Object.freeze({ status: "obsolete" as const, attachment });
			if (mainLeaf.value !== generation.context.triggerEntryId)
				throw new SessionError("corruption", "Pending recovery no longer closes the current leaf");
			const capturedNow = Date.now();
			let nextState: RunState;
			if (
				runState.value.control.status === "running" &&
				generation.attempt < generation.context.retryPolicy.maxAttempts
			) {
				const exponent = generation.attempt - 1;
				const multiplier = exponent >= 53 ? Number.MAX_SAFE_INTEGER : 2 ** exponent;
				const delay = Math.min(Number.MAX_SAFE_INTEGER, generation.context.retryPolicy.baseDelayMs * multiplier);
				const notBefore = Math.min(Number.MAX_SAFE_INTEGER, capturedNow + delay);
				nextState = {
					...runState.value,
					phase: {
						kind: "assistant",
						generation: {
							status: "retry_wait",
							context: structuredClone(generation.context),
							nextAttempt: generation.attempt + 1,
							notBefore,
							errorMessage: "Provider outcome unknown after interruption",
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
					status: "committed" as const,
					attachment: Object.freeze({
						...attachment,
						runState: Object.freeze({ seq: committed.seqs[0], value: structuredClone(nextState) }),
					}),
				});
			}
			const cancelled = runState.value.control.status === "cancel_requested";
			const error = { code: "provider_interrupted", message: "Provider outcome unknown after interruption" };
			const usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "harness",
				provider: generation.context.configuration.model.provider,
				model: generation.context.configuration.model.modelId,
				usage,
				stopReason: cancelled ? "aborted" : "error",
				errorMessage: cancelled ? "Operation aborted" : error.message,
				timestamp: capturedNow,
			};
			nextState = {
				...runState.value,
				latestAssistantEntryId: transition.responseEntryId,
				phase: cancelled
					? {
							kind: "checkpoint",
							continuation: { kind: "may_finish", includeFinalAssistant: true },
							triggerEntryId: transition.responseEntryId,
						}
					: {
							kind: "failure_drain",
							error,
							provenance: { kind: "response", entryId: transition.responseEntryId },
						},
			};
			const committed = await this.#storage.commit({
				writes: [
					{
						kind: "entry",
						entry: {
							id: transition.responseEntryId,
							parentId: generation.context.triggerEntryId,
							type: "message",
							payload: encodeMessage(message),
						},
					},
					{ kind: "register", op: "set", namespace: LEAF_NAMESPACE, key: MAIN, value: transition.responseEntryId },
					{
						kind: "usage",
						row: { id: transition.usageId, entryId: transition.responseEntryId, usage, adjustment: false },
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
					parentId: generation.context.triggerEntryId,
					seq: committed.seqs[0],
					timestamp: committed.timestamp,
					type: "message" as const,
					message: structuredClone(message),
				}),
			);
			const usageRows = new Map(hydrated.usageRows);
			usageRows.set(
				transition.usageId,
				Object.freeze({
					id: transition.usageId,
					seq: committed.seqs[2],
					entryId: transition.responseEntryId,
					usage: structuredClone(usage),
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

	releaseAssistantRetry(transition: ReleaseAssistantRetryTransition): Promise<RecoveryTransitionResult> {
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
				const [meta, state] = await Promise.all([
					this.#storage.getRegister("op.meta", currentOperationId),
					this.#storage.getRegister("op.state", currentOperationId),
				]);
				if (!meta || !state) throw new SessionError("corruption", "Open operation registers are missing");
				runOperation = decodeRunOperationRegister(meta, currentOperationId);
				runState = decodeRunStateRegister(state, currentOperationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, runState);
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
				laneState.seq !== transition.expectedLaneStateSeq ||
				runState?.seq !== transition.expectedOperationStateSeq ||
				currentOperationId !== transition.operationId ||
				generation?.status !== "retry_wait" ||
				generation.context.stepId !== transition.stepId ||
				generation.nextAttempt !== transition.nextAttempt ||
				generation.notBefore !== transition.notBefore
			)
				return Object.freeze({ status: "obsolete" as const, attachment });
			const nextState: RunState = {
				...runState.value,
				phase: {
					kind: "assistant",
					generation: {
						status: "ready",
						context: structuredClone(generation.context),
						nextAttempt: generation.nextAttempt,
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
				status: "committed" as const,
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
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, runState);
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

			const settledMessage: AssistantMessage =
				runState.value.control.status === "cancel_requested"
					? {
							...structuredClone(transition.message),
							stopReason: "aborted",
							errorMessage: transition.message.errorMessage ?? "Operation aborted",
						}
					: transition.message;
			const response = hydrated.entries.get(transition.responseEntryId);
			const usage = hydrated.usageRows.get(transition.usageId);
			if (response || usage) {
				if (!response || !usage)
					throw new SessionError("corruption", "Assistant settlement reservations materialized partially");
				if (
					response.parentId !== transition.triggerEntryId ||
					!isDeepStrictEqual(response.message, settledMessage) ||
					usage.entryId !== transition.responseEntryId ||
					usage.adjustment ||
					!isDeepStrictEqual(usage.usage, settledMessage.usage)
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

			const toolCalls = settledMessage.content.filter((content) => content.type === "toolCall");
			const resultEntryIds =
				classification === "commit_tools" && runState.value.control.status === "running"
					? toolCalls.map(() => createFollowerId(transition.responseEntryId, this.idGenerator))
					: [];
			if (classification === "commit_tools") {
				const directlyKnown = new Set([
					transition.operationId,
					transition.stepId,
					transition.responseEntryId,
					transition.usageId,
					transition.triggerEntryId,
					...(runOperation.value.sourceLeafId === null ? [] : [runOperation.value.sourceLeafId]),
					...runOperation.value.intent.promptEntryIds,
					...(runState.value.latestAssistantEntryId === null ? [] : [runState.value.latestAssistantEntryId]),
				]);
				if (
					new Set(resultEntryIds).size !== resultEntryIds.length ||
					resultEntryIds.some((id) => directlyKnown.has(id))
				)
					throw new SessionError("storage", "Generated tool result IDs are not unique");
				const [occupiedEntries, occupiedUsageRows, ...occupiedRegisters] = await Promise.all([
					this.#storage.getEntries(resultEntryIds),
					this.#storage.getUsageRows(resultEntryIds),
					...resultEntryIds.flatMap((id) => [
						this.#storage.getRegister("op.meta", id),
						this.#storage.getRegister("op.state", id),
					]),
				]);
				if (occupiedEntries.size > 0 || occupiedUsageRows.size > 0 || occupiedRegisters.some(Boolean))
					throw new SessionError("storage", "Generated tool result ID is already occupied");
			}

			const nextState: RunState = {
				...runState.value,
				latestAssistantEntryId: transition.responseEntryId,
				phase:
					classification === "commit_tools" && runState.value.control.status === "running"
						? {
								kind: "tools",
								batch: {
									assistantEntryId: transition.responseEntryId,
									configuration: structuredClone(generation.context.configuration),
									turnId: generation.context.stepId,
									calls: resultEntryIds.map((resultEntryId, sourceIndex) => ({
										status: "planned" as const,
										sourceIndex,
										resultEntryId,
									})),
								},
							}
						: {
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
							payload: encodeMessage(settledMessage),
						},
					},
					{ kind: "register", op: "set", namespace: LEAF_NAMESPACE, key: MAIN, value: transition.responseEntryId },
					{
						kind: "usage",
						row: {
							id: transition.usageId,
							entryId: transition.responseEntryId,
							usage: structuredClone(settledMessage.usage),
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
					message: structuredClone(settledMessage),
				}),
			);
			const usageRows = new Map(hydrated.usageRows);
			usageRows.set(
				transition.usageId,
				Object.freeze({
					id: transition.usageId,
					seq: committed.seqs[2],
					entryId: transition.responseEntryId,
					usage: structuredClone(settledMessage.usage),
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

	settleToolCall(transition: SettleToolCallTransition): Promise<SettleToolCallResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		try {
			validateSettleToolCallTransition(transition);
		} catch (error) {
			return Promise.reject(error);
		}
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
				const [meta, state] = await Promise.all([
					this.#storage.getRegister("op.meta", currentOperationId),
					this.#storage.getRegister("op.state", currentOperationId),
				]);
				if (!meta || !state) throw new SessionError("corruption", "Open operation registers are missing");
				runOperation = decodeRunOperationRegister(meta, currentOperationId);
				runState = decodeRunStateRegister(state, currentOperationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, runState);
			const attachment = Object.freeze({
				laneConfiguration: configuration,
				laneState,
				mainLeaf,
				runOperation,
				runState,
				...hydrated,
			});
			const phase = runState?.value.phase;
			const batch = phase?.kind === "tools" ? phase.batch : undefined;
			const call = batch?.calls[transition.sourceIndex];
			const firstUnfinished = batch?.calls.findIndex((candidate) => candidate.status !== "completed");
			if (
				currentOperationId !== transition.operationId ||
				!runOperation ||
				!runState ||
				batch?.assistantEntryId !== transition.assistantEntryId ||
				batch.turnId !== transition.turnId ||
				firstUnfinished !== transition.sourceIndex ||
				call?.status !== "effect_pending" ||
				call.sourceIndex !== transition.sourceIndex ||
				call.resultEntryId !== transition.resultEntryId ||
				call.replay !== transition.replay
			)
				return Object.freeze({ status: "obsolete" as const, attachment });

			const assistant = hydrated.entries.get(batch.assistantEntryId);
			const sourceCalls =
				assistant?.message.role === "assistant"
					? assistant.message.content.filter((content) => content.type === "toolCall")
					: [];
			const source = sourceCalls[transition.sourceIndex];
			if (!source || !isDeepStrictEqual(source, transition.toolCall))
				throw new SessionError("corruption", "Tool settlement source identity does not match the assistant entry");
			const argsKey = `${transition.operationId}:${transition.turnId}:${transition.sourceIndex}`;
			const retainedArgs = hydrated.toolArguments.get(argsKey);
			if (!retainedArgs || !isDeepStrictEqual(retainedArgs, transition.args))
				throw new SessionError("corruption", "Tool settlement arguments do not match the retained preparation");
			const priorParent =
				transition.sourceIndex === 0
					? transition.assistantEntryId
					: batch.calls[transition.sourceIndex - 1]?.status === "completed"
						? batch.calls[transition.sourceIndex - 1].resultEntryId
						: undefined;
			if (priorParent === undefined || mainLeaf.value !== priorParent)
				throw new SessionError("corruption", "Tool result parent does not close the completed prefix");
			if (hydrated.entries.has(transition.resultEntryId) || hydrated.usageRows.has(transition.resultEntryId))
				throw new SessionError("corruption", "Tool result reservation is already materialized");

			let usageId: string | undefined;
			if (transition.usage !== undefined) {
				usageId = this.idGenerator.next();
				const directlyKnown = new Set([
					transition.operationId,
					transition.assistantEntryId,
					transition.turnId,
					transition.resultEntryId,
					source.id,
					...batch.calls.map((candidate) => candidate.resultEntryId),
					...runOperation.value.intent.promptEntryIds,
					...(runOperation.value.sourceLeafId === null ? [] : [runOperation.value.sourceLeafId]),
					...(runState.value.latestAssistantEntryId === null ? [] : [runState.value.latestAssistantEntryId]),
				]);
				if (directlyKnown.has(usageId)) throw new SessionError("storage", "Generated tool usage ID is not unique");
				const [entries, usageRows, meta, state] = await Promise.all([
					this.#storage.getEntries([usageId]),
					this.#storage.getUsageRows([usageId]),
					this.#storage.getRegister("op.meta", usageId),
					this.#storage.getRegister("op.state", usageId),
				]);
				if (entries.size > 0 || usageRows.size > 0 || meta || state)
					throw new SessionError("storage", "Generated tool usage ID is already occupied");
			}

			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId: source.id,
				toolName: source.name,
				content: structuredClone(transition.content),
				details: structuredClone(transition.details),
				...(transition.addedToolNames?.length
					? { addedToolNames: structuredClone(transition.addedToolNames) }
					: {}),
				...(transition.usage === undefined ? {} : { usage: structuredClone(transition.usage) }),
				isError: transition.isError,
				timestamp: Date.now(),
			};
			const completedCalls = batch.calls.map((candidate, index) =>
				index === transition.sourceIndex
					? {
							status: "completed" as const,
							sourceIndex: candidate.sourceIndex,
							resultEntryId: candidate.resultEntryId,
							terminate: transition.terminate,
						}
					: candidate,
			);
			const final = transition.sourceIndex === batch.calls.length - 1;
			const cancelled = runState.value.control.status === "cancel_requested";
			const nextState: RunState = {
				...runState.value,
				phase: final
					? {
							kind: "checkpoint",
							continuation:
								cancelled ||
								completedCalls.every((candidate) => candidate.status === "completed" && candidate.terminate)
									? { kind: "may_finish", includeFinalAssistant: false }
									: { kind: "need_assistant", overflowRecoveryUsed: false },
							triggerEntryId: transition.resultEntryId,
						}
					: { kind: "tools", batch: { ...batch, calls: completedCalls } },
			};
			let cleanup: Register[] = [];
			if (final) {
				const listed = await this.#storage.listRegisters("op.tool_args");
				for (const register of listed) {
					try {
						assertRegister(register);
					} catch (error) {
						throw new SessionError("corruption", "Malformed tool argument cleanup register", error);
					}
					if (register.namespace !== "op.tool_args")
						throw new SessionError("corruption", "Tool argument cleanup register has the wrong namespace");
				}
				const prefix = `${transition.operationId}:${transition.turnId}:`;
				cleanup = listed.filter(({ key }) => key.startsWith(prefix));
				const seen = new Set<number>();
				for (const register of cleanup) {
					const suffix = register.key.slice(prefix.length);
					const index = Number(suffix);
					if (
						!Number.isSafeInteger(index) ||
						index < 0 ||
						index >= batch.calls.length ||
						String(index) !== suffix ||
						seen.has(index)
					)
						throw new SessionError("corruption", "Tool argument cleanup key has an invalid source index");
					seen.add(index);
				}
				cleanup.sort((left, right) => left.key.localeCompare(right.key));
			}
			const writes: Write[] = [
				{
					kind: "entry",
					entry: {
						id: transition.resultEntryId,
						parentId: priorParent,
						type: "message",
						payload: encodeMessage(message),
					},
				},
				{ kind: "register", op: "set", namespace: LEAF_NAMESPACE, key: MAIN, value: transition.resultEntryId },
				...(usageId === undefined || transition.usage === undefined
					? []
					: [
							{
								kind: "usage" as const,
								row: {
									id: usageId,
									entryId: transition.resultEntryId,
									usage: structuredClone(transition.usage),
									adjustment: false,
								},
							},
						]),
				...cleanup.map(({ key }) => ({
					kind: "register" as const,
					op: "delete" as const,
					namespace: "op.tool_args" as const,
					key,
				})),
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: transition.operationId,
					value: encodeRunState(nextState, transition.operationId),
				},
			];
			const committed = await this.#storage.commit({ writes });
			const entries = new Map(hydrated.entries);
			entries.set(
				transition.resultEntryId,
				Object.freeze({
					id: transition.resultEntryId,
					parentId: priorParent,
					seq: committed.seqs[0],
					timestamp: committed.timestamp,
					type: "message" as const,
					message: structuredClone(message),
				}),
			);
			const usageRows = new Map(hydrated.usageRows);
			const toolArguments = new Map(hydrated.toolArguments);
			toolArguments.delete(argsKey);
			if (final) for (const register of cleanup) toolArguments.delete(register.key);
			if (usageId !== undefined && transition.usage !== undefined)
				usageRows.set(
					usageId,
					Object.freeze({
						id: usageId,
						seq: committed.seqs[2],
						entryId: transition.resultEntryId,
						usage: structuredClone(transition.usage),
						adjustment: false,
					}),
				);
			return Object.freeze({
				status: "committed" as const,
				attachment: Object.freeze({
					...attachment,
					mainLeaf: Object.freeze({ seq: committed.seqs[1], value: transition.resultEntryId }),
					runState: Object.freeze({ seq: committed.seqs.at(-1)!, value: structuredClone(nextState) }),
					entries,
					usageRows,
					toolArguments,
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

	clearToolCall(transition: ClearToolCallTransition): Promise<ClearToolCallResult> {
		if (this.#sealed) return Promise.reject(new SessionError("closed", "Session is closed"));
		try {
			validateClearToolCallOutcome(transition.outcome);
		} catch (error) {
			return Promise.reject(error);
		}
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
				const [meta, state] = await Promise.all([
					this.#storage.getRegister("op.meta", currentOperationId),
					this.#storage.getRegister("op.state", currentOperationId),
				]);
				if (!meta || !state) throw new SessionError("corruption", "Open operation registers are missing");
				runOperation = decodeRunOperationRegister(meta, currentOperationId);
				runState = decodeRunStateRegister(state, currentOperationId);
			}
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, runState);
			const attachment = Object.freeze({
				laneConfiguration: configuration,
				laneState,
				mainLeaf,
				runOperation,
				runState,
				...hydrated,
			});
			const phase = runState?.value.phase;
			const batch = phase?.kind === "tools" ? phase.batch : undefined;
			const call = batch?.calls[transition.sourceIndex];
			const firstUnfinished = batch?.calls.findIndex((candidate) => candidate.status !== "completed");
			const argsKey = `${transition.operationId}:${transition.turnId}:${transition.sourceIndex}`;
			const [argsRegister, resultEntries, resultUsage] = await Promise.all([
				this.#storage.getRegister("op.tool_args", argsKey),
				this.#storage.getEntries([transition.resultEntryId]),
				this.#storage.getUsageRows([transition.resultEntryId]),
			]);
			const current =
				laneState.seq === transition.expectedLaneStateSeq &&
				mainLeaf.seq === transition.expectedLeafSeq &&
				mainLeaf.value === transition.expectedLeafId &&
				currentOperationId === transition.operationId &&
				runState?.seq === transition.expectedOperationStateSeq &&
				batch?.assistantEntryId === transition.assistantEntryId &&
				batch.turnId === transition.turnId &&
				firstUnfinished === transition.sourceIndex &&
				call?.status === "planned" &&
				call.sourceIndex === transition.sourceIndex &&
				call.resultEntryId === transition.resultEntryId;
			if (!current) return Object.freeze({ status: "obsolete" as const, attachment });
			if (!runOperation || !runState || !batch || call?.status !== "planned")
				throw new SessionError("corruption", "Validated tool clearance changed inside the mutation line");
			if (argsRegister || resultEntries.size > 0 || resultUsage.size > 0)
				throw new SessionError("corruption", "Tool clearance reservations are already materialized");
			const assistant = hydrated.entries.get(batch.assistantEntryId);
			const sourceCalls =
				assistant?.message.role === "assistant"
					? assistant.message.content.filter((content) => content.type === "toolCall")
					: [];
			const source = sourceCalls[transition.sourceIndex];
			if (!source || !isDeepStrictEqual(source, transition.outcome.toolCall))
				throw new SessionError("corruption", "Tool clearance source identity does not match the assistant entry");

			if (transition.outcome.kind === "prepared") {
				const prepared = transition.outcome;
				const nextState: RunState = {
					...runState.value,
					phase: {
						kind: "tools",
						batch: {
							...batch,
							calls: batch.calls.map((candidate, index) =>
								index === transition.sourceIndex
									? { ...candidate, status: "effect_pending" as const, replay: prepared.replay }
									: candidate,
							),
						},
					},
				};
				const committed = await this.#storage.commit({
					writes: [
						{
							kind: "register",
							op: "set",
							namespace: "op.tool_args",
							key: argsKey,
							value: structuredClone(transition.outcome.args) as JsonValue,
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
				const toolArguments = new Map(hydrated.toolArguments);
				toolArguments.set(argsKey, Object.freeze(structuredClone(transition.outcome.args)));
				return Object.freeze({
					status: "committed" as const,
					attachment: Object.freeze({
						...attachment,
						runState: Object.freeze({ seq: committed.seqs[1], value: structuredClone(nextState) }),
						toolArguments,
					}),
				});
			}

			const immediate = transition.outcome;
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId: immediate.toolCall.id,
				toolName: immediate.toolCall.name,
				content: structuredClone(immediate.result.content),
				details: structuredClone(immediate.result.details),
				...(immediate.result.addedToolNames?.length
					? { addedToolNames: structuredClone(immediate.result.addedToolNames) }
					: {}),
				isError: true,
				timestamp: Date.now(),
			};
			const encodedMessage = encodeMessage(message);
			const completedCalls = batch.calls.map((candidate, index) =>
				index === transition.sourceIndex
					? { ...candidate, status: "completed" as const, terminate: immediate.terminate }
					: candidate,
			);
			const final = transition.sourceIndex === batch.calls.length - 1;
			const cancelled = runState.value.control.status === "cancel_requested";
			const nextState: RunState = {
				...runState.value,
				phase: final
					? {
							kind: "checkpoint",
							continuation:
								cancelled ||
								completedCalls.every((candidate) => candidate.status === "completed" && candidate.terminate)
									? { kind: "may_finish", includeFinalAssistant: false }
									: { kind: "need_assistant", overflowRecoveryUsed: false },
							triggerEntryId: transition.resultEntryId,
						}
					: { kind: "tools", batch: { ...batch, calls: completedCalls } },
			};
			const priorParent =
				transition.sourceIndex === 0
					? transition.assistantEntryId
					: batch.calls[transition.sourceIndex - 1]?.status === "completed"
						? batch.calls[transition.sourceIndex - 1].resultEntryId
						: undefined;
			if (priorParent === undefined || mainLeaf.value !== priorParent)
				throw new SessionError("corruption", "Tool result parent does not close the completed prefix");
			let cleanup: Register[] = [];
			if (final) {
				const listed = await this.#storage.listRegisters("op.tool_args");
				for (const register of listed) {
					try {
						assertRegister(register);
					} catch (error) {
						throw new SessionError("corruption", "Malformed tool argument cleanup register", error);
					}
					if (register.namespace !== "op.tool_args")
						throw new SessionError("corruption", "Tool argument cleanup register has the wrong namespace");
				}
				const cleanupPrefix = `${transition.operationId}:${transition.turnId}:`;
				cleanup = listed.filter(({ key }) => key.startsWith(cleanupPrefix));
				const seen = new Set<number>();
				for (const register of cleanup) {
					const suffix = register.key.slice(cleanupPrefix.length);
					const sourceIndex = Number(suffix);
					if (
						!Number.isSafeInteger(sourceIndex) ||
						sourceIndex < 0 ||
						sourceIndex >= batch.calls.length ||
						String(sourceIndex) !== suffix ||
						seen.has(sourceIndex)
					)
						throw new SessionError("corruption", "Tool argument cleanup key has an invalid source index");
					seen.add(sourceIndex);
				}
				cleanup.sort((left, right) => left.key.localeCompare(right.key));
			}
			const writes: Write[] = [
				{
					kind: "entry",
					entry: {
						id: transition.resultEntryId,
						parentId: priorParent,
						type: "message",
						payload: encodedMessage,
					},
				},
				{ kind: "register", op: "set", namespace: LEAF_NAMESPACE, key: MAIN, value: transition.resultEntryId },
				...cleanup.map(({ key }) => ({
					kind: "register" as const,
					op: "delete" as const,
					namespace: "op.tool_args" as const,
					key,
				})),
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: transition.operationId,
					value: encodeRunState(nextState, transition.operationId),
				},
			];
			const committed = await this.#storage.commit({ writes });
			const entries = new Map(hydrated.entries);
			const toolArguments = new Map(hydrated.toolArguments);
			if (final) for (const register of cleanup) toolArguments.delete(register.key);
			entries.set(
				transition.resultEntryId,
				Object.freeze({
					id: transition.resultEntryId,
					parentId: priorParent,
					seq: committed.seqs[0],
					timestamp: committed.timestamp,
					type: "message" as const,
					message: structuredClone(message),
				}),
			);
			return Object.freeze({
				status: "committed" as const,
				attachment: Object.freeze({
					...attachment,
					mainLeaf: Object.freeze({ seq: committed.seqs[1], value: transition.resultEntryId }),
					runState: Object.freeze({ seq: committed.seqs.at(-1)!, value: structuredClone(nextState) }),
					entries,
					toolArguments,
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
			const hydrated = await hydrateCurrentState(this.#storage, mainLeaf, laneState, runOperation, runState);
			const attachment = Object.freeze({
				laneConfiguration: configuration,
				laneState,
				mainLeaf,
				runOperation,
				runState,
				...hydrated,
			});
			if (currentOperationId !== transition.operationId || runState?.seq !== transition.expectedOperationStateSeq)
				return Object.freeze({ status: "obsolete" as const, attachment });
			if (!runOperation || !runState)
				throw new SessionError("corruption", "Validated finish authority changed inside the mutation line");
			const phase = runState.value.phase;
			const cancelled = runState.value.control.status === "cancel_requested";
			const completed = phase.kind === "checkpoint" && phase.continuation.kind === "may_finish";
			const failed = phase.kind === "failure_drain";
			const cancelledBoundary =
				phase.kind === "checkpoint" ||
				phase.kind === "failure_drain" ||
				(phase.kind === "assistant" && phase.generation.status !== "effect_pending") ||
				(phase.kind === "tools" && phase.batch.calls.every((call) => call.status === "completed"));
			if (
				runOperation.value.operationId !== transition.operationId ||
				runOperation.value.lane !== MAIN ||
				(cancelled ? !cancelledBoundary : !completed && !failed) ||
				runState.value.inbox.steer.length !== 0 ||
				runState.value.inbox.followUp.length !== 0 ||
				runState.value.inbox.writes.length !== 0 ||
				mainLeaf.value === null ||
				(completed && mainLeaf.value !== phase.triggerEntryId) ||
				(failed && mainLeaf.value !== phase.provenance.entryId) ||
				(completed &&
					phase.kind === "checkpoint" &&
					phase.continuation.kind === "may_finish" &&
					phase.continuation.includeFinalAssistant &&
					mainLeaf.value !== runState.value.latestAssistantEntryId) ||
				(!cancelled && runState.value.latestAssistantEntryId === null)
			)
				throw new SessionError("corruption", "Run is not at a valid finish boundary");
			const finalEntry = hydrated.entries.get(mainLeaf.value);
			const latestEntry =
				runState.value.latestAssistantEntryId === null
					? undefined
					: hydrated.entries.get(runState.value.latestAssistantEntryId);
			if (runState.value.latestAssistantEntryId !== null && latestEntry?.message.role !== "assistant")
				throw new SessionError("corruption", "Latest assistant entry is missing or invalid");
			if (!finalEntry) throw new SessionError("corruption", "Final entry is missing or invalid");
			const includeFinalAssistant =
				phase.kind !== "checkpoint" ||
				phase.continuation.kind !== "may_finish" ||
				phase.continuation.includeFinalAssistant;
			if (
				!cancelled &&
				(includeFinalAssistant ? finalEntry.message.role !== "assistant" : finalEntry.message.role !== "toolResult")
			)
				throw new SessionError("corruption", "Final entry is missing or invalid");

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
			let durableResult: JsonValue;
			let result: FinishedRunResult | FailedRunResult | AbortedRunResult;
			if (cancelled) {
				durableResult = encodeLaneLastResult({
					operationId: transition.operationId,
					kind: "run",
					outcome: "aborted",
					leafId: mainLeaf.value,
					...(runState.value.latestAssistantEntryId === null
						? {}
						: { finalAssistantEntryId: runState.value.latestAssistantEntryId }),
				});
				result = Object.freeze({
					operationId: transition.operationId,
					kind: "aborted",
					leafId: mainLeaf.value,
					...(latestEntry?.message.role === "assistant"
						? { finalEntryId: latestEntry.id, finalMessage: structuredClone(latestEntry.message) }
						: {}),
				});
			} else if (phase.kind === "failure_drain") {
				durableResult = encodeLaneLastResult({
					operationId: transition.operationId,
					kind: "run",
					outcome: "failed",
					leafId: mainLeaf.value,
					finalAssistantEntryId: mainLeaf.value,
					error: structuredClone(phase.error),
				});
				result = Object.freeze({
					operationId: transition.operationId,
					kind: "failed",
					leafId: mainLeaf.value,
					finalEntryId: mainLeaf.value,
					error: structuredClone(phase.error),
				});
			} else {
				if (includeFinalAssistant) {
					durableResult = encodeLaneLastResult({
						operationId: transition.operationId,
						kind: "run",
						outcome: "completed",
						leafId: mainLeaf.value,
						finalAssistantEntryId: mainLeaf.value,
						runCompletion: "assistant",
					});
					result = Object.freeze({
						operationId: transition.operationId,
						kind: "completed",
						leafId: mainLeaf.value,
						finalEntryId: mainLeaf.value,
						finalMessage: structuredClone(finalEntry!.message) as AssistantMessage,
					});
				} else {
					durableResult = encodeLaneLastResult({
						operationId: transition.operationId,
						kind: "run",
						outcome: "completed",
						leafId: mainLeaf.value,
						runCompletion: "terminated_tools",
					});
					result = Object.freeze({
						operationId: transition.operationId,
						kind: "completed",
						leafId: mainLeaf.value,
					});
				}
			}
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
					pendingEntries: hydrated.pendingEntries,
					usageRows: hydrated.usageRows,
					toolArguments: new Map(),
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
			const hydrated = await hydrateCurrentState(
				this.#storage,
				mainLeaf,
				laneState,
				currentRunOperation,
				currentRunState,
			);
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
				mainLeaf.seq !== transition.expectedLeafSeq ||
				!expectedIdentity
			)
				return Object.freeze({ status: "stale" as const, attachment });
			if (laneState.value.currentOperationId !== null) return Object.freeze({ status: "busy" as const, attachment });
			if (!transition.identityAvailable) return Object.freeze({ status: "unavailable" as const, attachment });

			const operationId = this.idGenerator.next();
			const entryIds = transition.messages.map(() => this.idGenerator.next());
			const capturedIds = [...laneState.value.pendingNextRun];
			const candidates = [operationId, ...entryIds];
			const reservedIds = new Set(capturedIds);
			if (new Set(candidates).size !== candidates.length || candidates.some((id) => reservedIds.has(id)))
				throw new SessionError("storage", "Generated prompt acceptance IDs are not unique");
			const [occupiedEntries, occupiedUsageRows, ...occupiedRegisters] = await Promise.all([
				this.#storage.getEntries(candidates),
				this.#storage.getUsageRows(candidates),
				...candidates.flatMap((id) => [
					this.#storage.getRegister("op.meta", id),
					this.#storage.getRegister("op.state", id),
					this.#storage.getRegister("pending.entry", id),
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
					...(capturedIds.length === 0 ? {} : { skipInboxOnce: true as const }),
				},
				inbox: { steer: [], followUp: [], writes: [] },
				latestAssistantEntryId: null,
			};
			const capturedWrites = capturedIds.map((id, index) => ({
				kind: "entry" as const,
				entry: {
					id,
					parentId: index === 0 ? mainLeaf.value : capturedIds[index - 1],
					type: "message" as const,
					payload: encodeMessage(hydrated.pendingEntries.get(id)!.payload),
				},
			}));
			const writes = transition.messages.map((message, index) => ({
				kind: "entry" as const,
				entry: {
					id: entryIds[index],
					parentId: index === 0 ? (capturedIds.at(-1) ?? mainLeaf.value) : entryIds[index - 1],
					type: "message" as const,
					payload: encodeMessage(message),
				},
			}));
			const committed = await this.#storage.commit({
				writes: [
					...capturedWrites,
					...writes,
					...capturedIds.map((key) => ({
						kind: "register" as const,
						op: "delete" as const,
						namespace: "pending.entry",
						key,
					})),
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
						value: {
							currentOperationId: operationId,
							pendingNextRun: laneState.value.pendingNextRun.slice(capturedIds.length),
						},
					},
				],
			});
			const entries = new Map(hydrated.entries);
			for (let index = 0; index < capturedIds.length; index++) {
				const id = capturedIds[index];
				entries.set(
					id,
					Object.freeze({
						id,
						parentId: index === 0 ? mainLeaf.value : capturedIds[index - 1],
						seq: committed.seqs[index],
						timestamp: committed.timestamp,
						type: "message" as const,
						message: structuredClone(hydrated.pendingEntries.get(id)!.payload),
					}),
				);
			}
			for (let index = 0; index < transition.messages.length; index++)
				entries.set(
					entryIds[index],
					Object.freeze({
						id: entryIds[index],
						parentId: index === 0 ? (capturedIds.at(-1) ?? mainLeaf.value) : entryIds[index - 1],
						seq: committed.seqs[capturedIds.length + index],
						timestamp: committed.timestamp,
						type: "message" as const,
						message: structuredClone(transition.messages[index]),
					}),
				);
			const offset = capturedIds.length + transition.messages.length + capturedIds.length;
			return Object.freeze({
				status: "committed" as const,
				attachment: Object.freeze({
					laneConfiguration: configuration,
					laneState: Object.freeze({
						seq: committed.seqs[offset + 3],
						value: {
							currentOperationId: operationId,
							pendingNextRun: laneState.value.pendingNextRun.slice(capturedIds.length),
						},
					}),
					mainLeaf: Object.freeze({ seq: committed.seqs[offset], value: entryIds.at(-1)! }),
					runOperation: Object.freeze({ seq: committed.seqs[offset + 1], value: structuredClone(runOperation) }),
					runState: Object.freeze({ seq: committed.seqs[offset + 2], value: structuredClone(runState) }),
					entries,
					pendingEntries: new ImmutableMap<string, PendingMessageEntry>(),
					usageRows: hydrated.usageRows,
					toolArguments: hydrated.toolArguments,
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
		this.#closePromise = this.#mutationLine
			.then(() => this.#storage.close())
			.catch((error) => {
				throw storageFailure(error);
			})
			.finally(this.#release);
		return this.#closePromise;
	}
}
