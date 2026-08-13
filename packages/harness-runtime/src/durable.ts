import {
	assertJsonValue,
	assertRegister,
	isUuidV7,
	type JsonValue,
	type Register,
	uuidV7Timestamp,
} from "@nguyenphutrong/pi-session-storage";
import { SessionError } from "./types.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface LaneConfiguration {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}

export interface LaneState {
	currentOperationId: string | null;
	pendingNextRun: string[];
}

export interface OperationError {
	code: string;
	message: string;
}

export type Control =
	| { status: "running" }
	| { status: "cancel_requested"; requestedAt: number; drainedSteer: []; drainedFollowUp: [] };

export type LaneLastResult = {
	operationId: string;
	kind: "run";
	leafId: string;
} & (
	| { outcome: "completed"; runCompletion: "assistant"; finalAssistantEntryId: string }
	| { outcome: "completed"; runCompletion: "terminated_tools"; finalAssistantEntryId?: never }
	| { outcome: "failed"; error: OperationError; finalAssistantEntryId: string; runCompletion?: never }
	| { outcome: "aborted"; finalAssistantEntryId?: string; runCompletion?: never }
);

export interface RunOperation {
	operationId: string;
	lane: "main";
	sourceLeafId: string | null;
	startedAt: number;
	intent: {
		kind: "run";
		promptEntryIds: string[];
		systemPromptOverride?: string;
		resumeData?: Record<string, JsonValue>;
	};
}

export interface StreamOptions {
	transport?: "sse" | "websocket" | "websocket-cached" | "auto";
	timeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	headers?: Record<string, string>;
	metadata?: Record<string, JsonValue>;
	cacheRetention?: "none" | "short" | "long";
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
}

export interface NormalizedRetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
}

export interface GenerationContext {
	stepId: string;
	triggerEntryId: string;
	configuration: LaneConfiguration;
	streamOptions: StreamOptions;
	retryPolicy: { maxAttempts: number; baseDelayMs: number };
	overflowRecoveryUsed: boolean;
}

type CheckpointPhase = {
	kind: "checkpoint";
	continuation:
		| { kind: "need_assistant"; overflowRecoveryUsed: boolean }
		| { kind: "may_finish"; includeFinalAssistant: boolean };
	triggerEntryId: string;
	thresholdCheckedTriggerEntryId?: string;
	skipInboxOnce?: boolean;
};

type AssistantPhase = {
	kind: "assistant";
	generation:
		| { status: "ready"; context: GenerationContext; nextAttempt: number }
		| {
				status: "retry_wait";
				context: GenerationContext;
				nextAttempt: number;
				notBefore: number;
				errorMessage: string;
		  }
		| {
				status: "effect_pending";
				context: GenerationContext;
				attempt: number;
				responseEntryId: string;
				usageId: string;
				intendedOutputLimit: number;
				contextWindow: number;
		  };
};

type FailureDrainPhase = {
	kind: "failure_drain";
	error: OperationError;
	provenance: { kind: "response"; entryId: string };
};

export interface ToolBatch {
	assistantEntryId: string;
	configuration: LaneConfiguration;
	turnId: string;
	calls: ToolCall[];
}

export type ToolCall =
	| { status: "planned"; sourceIndex: number; resultEntryId: string }
	| { status: "effect_pending"; sourceIndex: number; resultEntryId: string; replay: "never" | "safe" }
	| { status: "completed"; sourceIndex: number; resultEntryId: string; terminate: boolean };

type ToolsPhase = { kind: "tools"; batch: ToolBatch };

export interface RunState {
	kind: "run";
	control: Control;
	settings: {
		compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
		steeringMode: "all" | "one-at-a-time";
		followUpMode: "all" | "one-at-a-time";
		toolExecution: "sequential" | "parallel";
	};
	phase: CheckpointPhase | AssistantPhase | ToolsPhase | FailureDrainPhase;
	inbox: { steer: []; followUp: []; writes: [] };
	latestAssistantEntryId: string | null;
}

export interface CurrentRegister<T> {
	readonly seq: number;
	readonly value: T;
}

function fail(message: string): never {
	throw new SessionError("corruption", message);
}

function object(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) fail(`${name} must be a plain object`);
	const result = value as Record<string, unknown>;
	const keys = Reflect.ownKeys(result);
	if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key)))
		fail(`${name} has unsupported fields`);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(result, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) fail(`${name} must contain plain enumerable data`);
	}
	return result;
}

function optionalObject(value: unknown, required: readonly string[], optional: readonly string[], name: string) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
	const allowed = [...required, ...optional];
	const present = Reflect.ownKeys(value).map((key) => {
		if (typeof key !== "string" || !allowed.includes(key)) fail(`${name} has unsupported fields`);
		return key;
	});
	const result = object(value, present, name);
	if (required.some((field) => !Object.hasOwn(result, field))) fail(`${name} is missing required fields`);
	return result;
}

function semanticObject(value: unknown, name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
	const keys = Reflect.ownKeys(value);
	return object(
		value,
		keys.map((key) => {
			if (typeof key !== "string") fail(`${name} has unsupported fields`);
			return key;
		}),
		name,
	);
}

function uuid(value: unknown, name: string): asserts value is string {
	if (typeof value !== "string" || !isUuidV7(value)) fail(`${name} must be a UUIDv7`);
}

function uuidOrNull(value: unknown, name: string): asserts value is string | null {
	if (value !== null) uuid(value, name);
}

function safe(value: unknown, name: string, minimum = 0): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum)
		fail(`${name} must be a safe integer >= ${minimum}`);
}

function strings(value: unknown, name: string, uuids = false): asserts value is string[] {
	if (!Array.isArray(value)) fail(`${name} must be an array`);
	const keys = Reflect.ownKeys(value);
	if (
		Object.getPrototypeOf(value) !== Array.prototype ||
		keys.length !== value.length + 1 ||
		Array.from({ length: value.length }, (_, index) => String(index)).some((key) => !keys.includes(key)) ||
		keys.some((key) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			return key !== "length" && (!descriptor?.enumerable || !("value" in descriptor));
		}) ||
		value.some((item) => typeof item !== "string" || (uuids && !isUuidV7(item)))
	)
		fail(`${name} must be an array of ${uuids ? "UUIDv7s" : "strings"}`);
}

function emptyArray(value: unknown, name: string): asserts value is [] {
	strings(value, name);
	if (value.length !== 0) fail(`${name} must be empty`);
}

function decodeRegister<T>(
	candidate: unknown,
	namespace: string,
	key: string,
	decode: (value: unknown) => T,
): CurrentRegister<T> {
	try {
		assertRegister(candidate);
	} catch (error) {
		throw new SessionError("corruption", "Malformed register envelope", error);
	}
	const register = candidate as Register;
	if (register.namespace !== namespace || register.key !== key) fail(`Wrong ${namespace}/${key} register identity`);
	return Object.freeze({ seq: register.seq, value: structuredClone(decode(register.value)) });
}

export function decodeLaneConfiguration(value: unknown): LaneConfiguration {
	const config = object(value, ["model", "thinkingLevel", "activeToolNames"], "lane configuration");
	const model = object(config.model, ["provider", "modelId"], "lane model");
	if (typeof model.provider !== "string" || typeof model.modelId !== "string")
		fail("Lane model identities must be strings");
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.thinkingLevel as string))
		fail("Unsupported thinking level");
	strings(config.activeToolNames, "activeToolNames");
	if (new Set(config.activeToolNames).size !== config.activeToolNames.length)
		fail("activeToolNames must not contain duplicates");
	return config as unknown as LaneConfiguration;
}

export function encodeLaneConfiguration(value: LaneConfiguration): JsonValue {
	try {
		assertJsonValue(value);
	} catch (error) {
		throw new SessionError("invalid_query", "Lane configuration must be detached JSON-safe data", error);
	}
	return structuredClone(decodeLaneConfiguration(value)) as unknown as JsonValue;
}

export function decodeLaneState(value: unknown): LaneState {
	const state = object(value, ["currentOperationId", "pendingNextRun"], "lane state");
	uuidOrNull(state.currentOperationId, "currentOperationId");
	strings(state.pendingNextRun, "pendingNextRun", true);
	if (new Set(state.pendingNextRun).size !== state.pendingNextRun.length)
		fail("pendingNextRun must not contain duplicates");
	return state as unknown as LaneState;
}

export function decodeLaneLastResult(value: unknown): LaneLastResult {
	const candidate = semanticObject(value, "lane last result");
	const result =
		candidate.outcome === "completed"
			? object(
					candidate,
					candidate.runCompletion === "terminated_tools"
						? ["operationId", "kind", "outcome", "leafId", "runCompletion"]
						: ["operationId", "kind", "outcome", "leafId", "finalAssistantEntryId", "runCompletion"],
					"lane last result",
				)
			: candidate.outcome === "aborted"
				? optionalObject(
						candidate,
						["operationId", "kind", "outcome", "leafId"],
						["finalAssistantEntryId"],
						"lane last result",
					)
				: object(
						candidate,
						["operationId", "kind", "outcome", "leafId", "finalAssistantEntryId", "error"],
						"lane last result",
					);
	uuid(result.operationId, "lane last result operationId");
	uuid(result.leafId, "lane last result leafId");
	if (result.kind !== "run") fail("Unsupported lane last result kind");
	if (result.outcome === "completed") {
		if (result.runCompletion !== "assistant" && result.runCompletion !== "terminated_tools")
			fail("Unsupported completed lane last result");
		if (result.runCompletion === "assistant")
			uuid(result.finalAssistantEntryId, "lane last result finalAssistantEntryId");
	} else if (result.outcome === "failed") {
		uuid(result.finalAssistantEntryId, "lane last result finalAssistantEntryId");
		decodeOperationError(result.error, "lane last result error");
	} else if (result.outcome === "aborted") {
		if (result.finalAssistantEntryId !== undefined)
			uuid(result.finalAssistantEntryId, "lane last result finalAssistantEntryId");
	} else fail("Unsupported lane last result outcome");
	if (
		result.outcome !== "aborted" &&
		result.runCompletion !== "terminated_tools" &&
		result.leafId !== result.finalAssistantEntryId
	)
		fail("Assistant lane last result leaf must equal its final assistant");
	return result as unknown as LaneLastResult;
}

function decodeOperationError(value: unknown, name: string): OperationError {
	const error = object(value, ["code", "message"], name);
	if (typeof error.code !== "string" || typeof error.message !== "string") fail(`${name} fields must be strings`);
	return error as unknown as OperationError;
}

export function encodeLaneLastResult(value: LaneLastResult): JsonValue {
	try {
		assertJsonValue(value);
	} catch (error) {
		throw new SessionError("invalid_query", "Lane last result must be detached JSON-safe data", error);
	}
	return structuredClone(decodeLaneLastResult(value)) as unknown as JsonValue;
}

function decodeConfigurationRegister(candidate: unknown): CurrentRegister<LaneConfiguration> {
	return decodeRegister(candidate, "lane.config", "main", decodeLaneConfiguration);
}

export function decodeLaneStateRegister(candidate: unknown): CurrentRegister<LaneState> {
	return decodeRegister(candidate, "lane.state", "main", decodeLaneState);
}

export function decodeRunOperationRegister(candidate: unknown, operationId: string): CurrentRegister<RunOperation> {
	return decodeRegister(candidate, "op.meta", operationId, (value) => {
		const operation = object(value, ["operationId", "lane", "sourceLeafId", "startedAt", "intent"], "operation");
		uuid(operation.operationId, "operationId");
		if (operation.operationId !== operationId || operation.lane !== "main")
			fail("Operation identity or lane mismatch");
		uuidOrNull(operation.sourceLeafId, "sourceLeafId");
		safe(operation.startedAt, "startedAt");
		const intent = optionalObject(
			operation.intent,
			["kind", "promptEntryIds"],
			["systemPromptOverride", "resumeData"],
			"run intent",
		);
		if (intent.kind !== "run") fail("Only run operations are supported");
		strings(intent.promptEntryIds, "promptEntryIds", true);
		if (new Set(intent.promptEntryIds).size !== intent.promptEntryIds.length)
			fail("promptEntryIds must not contain duplicates");
		if (intent.systemPromptOverride !== undefined && typeof intent.systemPromptOverride !== "string")
			fail("Invalid system prompt override");
		if (intent.resumeData !== undefined) {
			object(intent.resumeData, Object.keys(intent.resumeData as object), "resumeData");
			try {
				assertJsonValue(intent.resumeData);
			} catch (error) {
				throw new SessionError("corruption", "resumeData must be JSON-safe data", error);
			}
		}
		return operation as unknown as RunOperation;
	});
}

export function encodeRunOperation(value: RunOperation): JsonValue {
	try {
		assertJsonValue(value);
	} catch (error) {
		throw new SessionError("invalid_query", "Run operation must be detached JSON-safe data", error);
	}
	return structuredClone(
		decodeRunOperationRegister({ namespace: "op.meta", key: value.operationId, seq: 1, value }, value.operationId)
			.value,
	) as unknown as JsonValue;
}

function generationContext(value: unknown): GenerationContext {
	const context = object(
		value,
		["stepId", "triggerEntryId", "configuration", "streamOptions", "retryPolicy", "overflowRecoveryUsed"],
		"generation context",
	);
	uuid(context.stepId, "stepId");
	uuid(context.triggerEntryId, "generation triggerEntryId");
	decodeLaneConfiguration(context.configuration);
	try {
		assertJsonValue(context.streamOptions);
	} catch (error) {
		throw new SessionError("corruption", "streamOptions must be JSON-safe data", error);
	}
	decodeStreamOptions(context.streamOptions);
	const retry = object(context.retryPolicy, ["maxAttempts", "baseDelayMs"], "retryPolicy");
	safe(retry.maxAttempts, "maxAttempts", 1);
	safe(retry.baseDelayMs, "baseDelayMs");
	if (context.overflowRecoveryUsed !== false) fail("Phase 1 overflowRecoveryUsed must be false");
	return context as unknown as GenerationContext;
}

function decodeStreamOptions(value: unknown): StreamOptions {
	const stream = optionalObject(
		value,
		[],
		["transport", "timeoutMs", "maxRetries", "maxRetryDelayMs", "headers", "metadata", "cacheRetention", "deferred"],
		"streamOptions",
	);
	for (const field of ["timeoutMs", "maxRetries", "maxRetryDelayMs"] as const)
		if (stream[field] !== undefined) safe(stream[field], field);
	if (
		stream.transport !== undefined &&
		!["sse", "websocket", "websocket-cached", "auto"].includes(stream.transport as string)
	)
		fail("Invalid transport");
	if (stream.cacheRetention !== undefined && !["none", "short", "long"].includes(stream.cacheRetention as string))
		fail("Invalid cacheRetention");
	if (
		stream.headers !== undefined &&
		Object.values(object(stream.headers, Object.keys(stream.headers as object), "headers")).some(
			(item) => typeof item !== "string",
		)
	)
		fail("Headers must contain strings");
	if (stream.metadata !== undefined) semanticObject(stream.metadata, "metadata");
	if (stream.deferred !== undefined && stream.deferred !== false) fail("Phase 1 deferred must be absent or false");
	return stream as unknown as StreamOptions;
}

export function encodeStreamOptions(value: StreamOptions): StreamOptions {
	try {
		assertJsonValue(value);
		const candidate = structuredClone(value);
		decodeStreamOptions(candidate);
		return Object.freeze(candidate);
	} catch (error) {
		throw new SessionError("invalid_query", "Stream options must be detached JSON-safe data", error);
	}
}

export function encodeRunState(value: RunState, operationId: string): JsonValue {
	try {
		assertJsonValue(value);
	} catch (error) {
		throw new SessionError("invalid_query", "Run state must be detached JSON-safe data", error);
	}
	return structuredClone(
		decodeRunStateRegister({ namespace: "op.state", key: operationId, seq: 1, value }, operationId).value,
	) as unknown as JsonValue;
}

export function decodeRunStateRegister(candidate: unknown, operationId: string): CurrentRegister<RunState> {
	return decodeRegister(candidate, "op.state", operationId, (value) => {
		const state = object(
			value,
			["kind", "control", "settings", "phase", "inbox", "latestAssistantEntryId"],
			"run state",
		);
		if (state.kind !== "run") fail("Only run state is supported");
		const controlCandidate = semanticObject(state.control, "run control");
		if (controlCandidate.status === "running") object(controlCandidate, ["status"], "run control");
		else if (controlCandidate.status === "cancel_requested") {
			const control = object(
				controlCandidate,
				["status", "requestedAt", "drainedSteer", "drainedFollowUp"],
				"run control",
			);
			safe(control.requestedAt, "requestedAt");
			emptyArray(control.drainedSteer, "drainedSteer");
			emptyArray(control.drainedFollowUp, "drainedFollowUp");
		} else fail("Unsupported run control");
		const settings = object(
			state.settings,
			["compaction", "steeringMode", "followUpMode", "toolExecution"],
			"run settings",
		);
		const compaction = object(
			settings.compaction,
			["enabled", "reserveTokens", "keepRecentTokens"],
			"compaction settings",
		);
		if (typeof compaction.enabled !== "boolean") fail("compaction.enabled must be boolean");
		safe(compaction.reserveTokens, "reserveTokens");
		safe(compaction.keepRecentTokens, "keepRecentTokens");
		if (
			!["all", "one-at-a-time"].includes(settings.steeringMode as string) ||
			!["all", "one-at-a-time"].includes(settings.followUpMode as string)
		)
			fail("Invalid queue mode");
		if (!["sequential", "parallel"].includes(settings.toolExecution as string)) fail("Invalid tool execution mode");
		const inbox = object(state.inbox, ["steer", "followUp", "writes"], "inbox");
		emptyArray(inbox.steer, "inbox.steer");
		emptyArray(inbox.followUp, "inbox.followUp");
		emptyArray(inbox.writes, "inbox.writes");
		uuidOrNull(state.latestAssistantEntryId, "latestAssistantEntryId");
		const phase = semanticObject(state.phase, "run phase");
		if (phase.kind === "checkpoint") {
			const checkpoint = optionalObject(
				phase,
				["kind", "continuation", "triggerEntryId"],
				["thresholdCheckedTriggerEntryId", "skipInboxOnce"],
				"checkpoint",
			);
			uuid(checkpoint.triggerEntryId, "checkpoint triggerEntryId");
			if (checkpoint.thresholdCheckedTriggerEntryId !== undefined)
				fail("Phase 1 checkpoint threshold field must be absent");
			if (checkpoint.skipInboxOnce !== undefined && checkpoint.skipInboxOnce !== true)
				fail("checkpoint skipInboxOnce must be true when present");
			const continuation = semanticObject(checkpoint.continuation, "checkpoint continuation");
			if (continuation.kind === "need_assistant") {
				if (object(continuation, ["kind", "overflowRecoveryUsed"], "need_assistant").overflowRecoveryUsed !== false)
					fail("Phase 1 need_assistant overflowRecoveryUsed must be false");
				if (state.latestAssistantEntryId === checkpoint.triggerEntryId)
					fail("Tool checkpoint trigger must differ from its producing assistant");
			} else if (continuation.kind === "may_finish") {
				const includeFinalAssistant = object(
					continuation,
					["kind", "includeFinalAssistant"],
					"may_finish",
				).includeFinalAssistant;
				if (typeof includeFinalAssistant !== "boolean") fail("may_finish includeFinalAssistant must be boolean");
				if (includeFinalAssistant && state.latestAssistantEntryId !== checkpoint.triggerEntryId)
					fail("may_finish latest assistant must equal its trigger");
				if (!includeFinalAssistant && state.latestAssistantEntryId === null)
					fail("Tool-terminated checkpoint must retain its producing assistant");
				if (!includeFinalAssistant && state.latestAssistantEntryId === checkpoint.triggerEntryId)
					fail("Tool-terminated trigger must differ from its producing assistant");
			} else fail("Unsupported checkpoint continuation");
		} else if (phase.kind === "assistant") {
			const assistant = object(phase, ["kind", "generation"], "assistant phase");
			const generation = semanticObject(assistant.generation, "assistant generation");
			if (generation.status === "ready") {
				const ready = object(generation, ["status", "context", "nextAttempt"], "ready generation");
				const context = generationContext(ready.context);
				safe(ready.nextAttempt, "nextAttempt", 1);
				if (ready.nextAttempt > context.retryPolicy.maxAttempts) fail("nextAttempt exceeds maxAttempts");
				if (state.latestAssistantEntryId === context.triggerEntryId)
					fail("Assistant generation trigger must differ from the previous assistant");
			} else if (generation.status === "retry_wait") {
				const wait = object(
					generation,
					["status", "context", "nextAttempt", "notBefore", "errorMessage"],
					"retry wait",
				);
				const context = generationContext(wait.context);
				safe(wait.nextAttempt, "nextAttempt", 2);
				if (wait.nextAttempt > context.retryPolicy.maxAttempts) fail("nextAttempt exceeds maxAttempts");
				safe(wait.notBefore, "notBefore");
				if (wait.errorMessage !== "Provider outcome unknown after interruption")
					fail("Unsupported retry wait errorMessage");
				if (state.latestAssistantEntryId === context.triggerEntryId)
					fail("Assistant generation trigger must differ from the previous assistant");
			} else if (generation.status === "effect_pending") {
				const pending = object(
					generation,
					["status", "context", "attempt", "responseEntryId", "usageId", "intendedOutputLimit", "contextWindow"],
					"pending generation",
				);
				const context = generationContext(pending.context);
				safe(pending.attempt, "attempt", 1);
				if (pending.attempt > context.retryPolicy.maxAttempts) fail("attempt exceeds maxAttempts");
				uuid(pending.responseEntryId, "responseEntryId");
				uuid(pending.usageId, "usageId");
				const reserved = [pending.responseEntryId, pending.usageId];
				if (
					new Set(reserved).size !== reserved.length ||
					reserved.some((id) => [operationId, context.stepId, context.triggerEntryId].includes(id as string))
				)
					fail("Generation reservation IDs must be distinct from known correlation IDs");
				safe(pending.intendedOutputLimit, "intendedOutputLimit");
				safe(pending.contextWindow, "contextWindow");
				if (state.latestAssistantEntryId === context.triggerEntryId)
					fail("Assistant generation trigger must differ from the previous assistant");
			} else fail("Unsupported assistant generation state");
		} else if (phase.kind === "tools") {
			const tools = object(phase, ["kind", "batch"], "tools phase");
			const batch = object(tools.batch, ["assistantEntryId", "configuration", "turnId", "calls"], "tool batch");
			uuid(batch.assistantEntryId, "tool batch assistantEntryId");
			uuid(batch.turnId, "tool batch turnId");
			decodeLaneConfiguration(batch.configuration);
			if (state.latestAssistantEntryId !== batch.assistantEntryId)
				fail("Tool batch assistant must equal latest assistant entry");
			if (!Array.isArray(batch.calls) || batch.calls.length === 0) fail("Tool batch calls must be non-empty");
			const resultIds = new Set<string>();
			for (let index = 0; index < batch.calls.length; index++) {
				const call = semanticObject(batch.calls[index], "tool call state");
				if (call.status === "planned")
					object(call, ["status", "sourceIndex", "resultEntryId"], "planned tool call");
				else if (call.status === "effect_pending") {
					object(call, ["status", "sourceIndex", "resultEntryId", "replay"], "pending tool call");
					if (call.replay !== "never" && call.replay !== "safe") fail("Invalid tool replay declaration");
				} else if (call.status === "completed") {
					object(call, ["status", "sourceIndex", "resultEntryId", "terminate"], "completed tool call");
					if (typeof call.terminate !== "boolean") fail("Completed tool terminate must be boolean");
				} else fail("Unsupported tool call status");
				safe(call.sourceIndex, "tool sourceIndex");
				if (call.sourceIndex !== index) fail("Tool source indices must be complete and ordered");
				uuid(call.resultEntryId, "tool resultEntryId");
				if (uuidV7Timestamp(call.resultEntryId) !== uuidV7Timestamp(batch.assistantEntryId))
					fail("Tool result entry must be a follower of the assistant entry");
				if (resultIds.has(call.resultEntryId)) fail("Tool result IDs must be unique");
				resultIds.add(call.resultEntryId);
			}
		} else if (phase.kind === "failure_drain") {
			const drain = object(phase, ["kind", "error", "provenance"], "failure drain");
			decodeOperationError(drain.error, "failure drain error");
			const provenance = object(drain.provenance, ["kind", "entryId"], "failure provenance");
			if (provenance.kind !== "response") fail("Unsupported failure provenance");
			uuid(provenance.entryId, "failure response entryId");
			if (state.latestAssistantEntryId !== provenance.entryId)
				fail("Failure response must equal latest assistant entry");
		} else fail("Unsupported run phase");
		return state as unknown as RunState;
	});
}

export { decodeConfigurationRegister };
