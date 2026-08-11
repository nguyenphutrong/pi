import {
	assertJsonValue,
	assertRegister,
	isUuidV7,
	type JsonValue,
	type Register,
} from "@earendil-works/pi-session-storage";
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
				status: "effect_pending";
				context: GenerationContext;
				attempt: number;
				responseEntryId: string;
				usageId: string;
				intendedOutputLimit: number;
				contextWindow: number;
		  };
};

export interface RunState {
	kind: "run";
	control: { status: "running" };
	settings: {
		compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
		steeringMode: "all" | "one-at-a-time";
		followUpMode: "all" | "one-at-a-time";
		toolExecution: "sequential" | "parallel";
	};
	phase: CheckpointPhase | AssistantPhase;
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
	if (config.activeToolNames.length !== 0) fail("Phase 1 activeToolNames must be empty");
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
	if (state.pendingNextRun.length !== 0) fail("Phase 1 pendingNextRun must be empty");
	return state as unknown as LaneState;
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
		if (object(state.control, ["status"], "run control").status !== "running")
			fail("Only running control is supported");
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
			if (checkpoint.thresholdCheckedTriggerEntryId !== undefined || checkpoint.skipInboxOnce !== undefined)
				fail("Phase 1 checkpoint threshold and skip fields must be absent");
			const continuation = semanticObject(checkpoint.continuation, "checkpoint continuation");
			if (continuation.kind === "need_assistant") {
				if (object(continuation, ["kind", "overflowRecoveryUsed"], "need_assistant").overflowRecoveryUsed !== false)
					fail("Phase 1 need_assistant overflowRecoveryUsed must be false");
				if (state.latestAssistantEntryId !== null) fail("Pre-settlement latest assistant must be null");
			} else if (continuation.kind === "may_finish") {
				if (object(continuation, ["kind", "includeFinalAssistant"], "may_finish").includeFinalAssistant !== true)
					fail("Phase 1 may_finish includeFinalAssistant must be true");
				if (state.latestAssistantEntryId !== checkpoint.triggerEntryId)
					fail("may_finish latest assistant must equal its trigger");
			} else fail("Unsupported checkpoint continuation");
		} else if (phase.kind === "assistant") {
			const assistant = object(phase, ["kind", "generation"], "assistant phase");
			const generation = semanticObject(assistant.generation, "assistant generation");
			if (generation.status === "ready") {
				const ready = object(generation, ["status", "context", "nextAttempt"], "ready generation");
				generationContext(ready.context);
				if (ready.nextAttempt !== 1) fail("Phase 1 nextAttempt must be 1");
				if (state.latestAssistantEntryId !== null) fail("Pre-settlement latest assistant must be null");
			} else if (generation.status === "effect_pending") {
				const pending = object(
					generation,
					["status", "context", "attempt", "responseEntryId", "usageId", "intendedOutputLimit", "contextWindow"],
					"pending generation",
				);
				const context = generationContext(pending.context);
				if (pending.attempt !== 1) fail("Phase 1 attempt must be 1");
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
				if (state.latestAssistantEntryId !== null) fail("Pre-settlement latest assistant must be null");
			} else fail("Unsupported assistant generation state");
		} else fail("Unsupported run phase");
		return state as unknown as RunState;
	});
}

export { decodeConfigurationRegister };
