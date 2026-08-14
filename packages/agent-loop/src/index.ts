import {
	type ImageContent,
	type Static,
	type TextContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type TSchema,
	type Usage,
	validateToolArguments,
} from "@earendil-works/pi-ai";

export type ToolReplay = "never" | "safe";
export type ToolExecutionMode = "sequential" | "parallel";
export type AgentToolCall = ToolCall;

export interface AgentToolResult<TDetails = unknown> {
	content: (TextContent | ImageContent)[];
	details: TDetails;
	usage?: Usage;
	addedToolNames?: string[];
	terminate?: boolean;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (partialResult: AgentToolResult<TDetails>) => void;

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> extends Tool<TParameters> {
	label: string;
	prepareArguments?: (args: unknown) => Static<TParameters>;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	executionMode?: ToolExecutionMode;
	replay?: ToolReplay;
}

export interface BeforeToolCallContext {
	toolCall: AgentToolCall;
	args: unknown;
}

export interface BeforeToolCallResult {
	/** Opaque until prepareToolCall validates and clones it against the tool schema. */
	args?: unknown;
	block?: { reason: string; terminate?: boolean };
}

export type BeforeToolCallCallback = (
	context: BeforeToolCallContext,
	signal?: AbortSignal,
) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;

export interface AfterToolCallContext {
	toolCall: AgentToolCall;
	args: unknown;
	result: AgentToolResult;
	isError: boolean;
}

export interface AfterToolCallResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	usage?: Usage;
	terminate?: boolean;
}

export type AfterToolCallCallback = (
	context: AfterToolCallContext,
	signal?: AbortSignal,
) => AfterToolCallResult | undefined | Promise<AfterToolCallResult | undefined>;

export type CallbackNormalizationResult<T> = { kind: "valid"; value: T | undefined } | { kind: "invalid" };

export interface PreparedToolCall {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool;
	args: unknown;
	replay: ToolReplay;
}

export interface ImmediateToolCallOutcome {
	kind: "immediate";
	toolCall: AgentToolCall;
	result: AgentToolResult;
	isError: true;
	terminate: boolean;
}

export interface ExecutedToolCallOutcome {
	result: AgentToolResult;
	isError: boolean;
}

export interface FinalizedToolCallOutcome {
	toolCall: AgentToolCall;
	result: AgentToolResult;
	isError: boolean;
	terminate: boolean;
}

export interface ToolUpdate {
	toolCall: AgentToolCall;
	partialResult: AgentToolResult;
}

export type ToolUpdateSink = (update: ToolUpdate) => void | Promise<void>;

const INVALID_BEFORE_OUTPUT = "Invalid before tool callback output";
const INVALID_AFTER_OUTPUT = "Invalid after tool callback output";
const INVALID_TOOL_RESULT = "Invalid tool result";

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
	}
	return value as Record<string, unknown>;
}

function hasExactFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	let valid = true;
	if (Array.isArray(value)) {
		const keys = Reflect.ownKeys(value);
		if (keys.length !== value.length + 1) valid = false;
		else {
			for (const key of keys) {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (key === "length") {
					if (!descriptor || !("value" in descriptor) || descriptor.value !== value.length) valid = false;
					continue;
				}
				if (
					typeof key !== "string" ||
					!descriptor?.enumerable ||
					!("value" in descriptor) ||
					!Number.isInteger(Number(key)) ||
					Number(key) < 0 ||
					Number(key) >= value.length ||
					String(Number(key)) !== key ||
					!isJsonValue(descriptor.value, seen)
				)
					valid = false;
			}
		}
	} else {
		const record = plainRecord(value);
		if (!record) valid = false;
		else for (const item of Object.values(record)) if (!isJsonValue(item, seen)) valid = false;
	}
	seen.delete(value);
	return valid;
}

function isContent(value: unknown): value is (TextContent | ImageContent)[] {
	if (!Array.isArray(value) || !isJsonValue(value)) return false;
	return value.every((candidate) => {
		const item = plainRecord(candidate);
		if (!item || typeof item.type !== "string") return false;
		if (item.type === "text")
			return (
				hasExactFields(item, ["type", "text", "textSignature"]) &&
				typeof item.text === "string" &&
				(!Object.hasOwn(item, "textSignature") || typeof item.textSignature === "string")
			);
		return (
			item.type === "image" &&
			hasExactFields(item, ["type", "data", "mimeType"]) &&
			typeof item.data === "string" &&
			typeof item.mimeType === "string"
		);
	});
}

function isUsage(value: unknown): value is Usage {
	const usage = plainRecord(value);
	if (
		!usage ||
		!hasExactFields(usage, [
			"input",
			"output",
			"cacheRead",
			"cacheWrite",
			"cacheWrite1h",
			"reasoning",
			"totalTokens",
			"cost",
		])
	)
		return false;
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
		if (typeof usage[key] !== "number" || !Number.isFinite(usage[key])) return false;
	for (const key of ["cacheWrite1h", "reasoning"])
		if (Object.hasOwn(usage, key) && (typeof usage[key] !== "number" || !Number.isFinite(usage[key]))) return false;
	const cost = plainRecord(usage.cost);
	if (!cost || !hasExactFields(cost, ["input", "output", "cacheRead", "cacheWrite", "total"])) return false;
	return ["input", "output", "cacheRead", "cacheWrite", "total"].every(
		(key) => typeof cost[key] === "number" && Number.isFinite(cost[key]),
	);
}

export function normalizeBeforeToolCallResult(value: unknown): CallbackNormalizationResult<BeforeToolCallResult> {
	if (value === undefined) return { kind: "valid", value: undefined };
	const result = plainRecord(value);
	if (!result || !hasExactFields(result, ["args", "block"])) return { kind: "invalid" };
	let blockResult: BeforeToolCallResult["block"];
	if (Object.hasOwn(result, "block")) {
		const block = plainRecord(result.block);
		if (
			!block ||
			!hasExactFields(block, ["reason", "terminate"]) ||
			typeof block.reason !== "string" ||
			(Object.hasOwn(block, "terminate") && typeof block.terminate !== "boolean")
		)
			return { kind: "invalid" };
		blockResult = {
			reason: block.reason as string,
			...(Object.hasOwn(block, "terminate") ? { terminate: block.terminate as boolean } : {}),
		};
	}
	return {
		kind: "valid",
		value: {
			...(Object.hasOwn(result, "args") ? { args: result.args } : {}),
			...(Object.hasOwn(result, "block") ? { block: blockResult } : {}),
		},
	};
}

export function normalizeAfterToolCallResult(value: unknown): CallbackNormalizationResult<AfterToolCallResult> {
	if (value === undefined) return { kind: "valid", value: undefined };
	const patch = plainRecord(value);
	if (!patch || !hasExactFields(patch, ["content", "details", "isError", "usage", "terminate"]))
		return { kind: "invalid" };
	if (Object.hasOwn(patch, "content") && !isContent(patch.content)) return { kind: "invalid" };
	if (Object.hasOwn(patch, "details") && !isJsonValue(patch.details)) return { kind: "invalid" };
	if (Object.hasOwn(patch, "isError") && typeof patch.isError !== "boolean") return { kind: "invalid" };
	if (Object.hasOwn(patch, "usage") && !isUsage(patch.usage)) return { kind: "invalid" };
	if (Object.hasOwn(patch, "terminate") && typeof patch.terminate !== "boolean") return { kind: "invalid" };
	return { kind: "valid", value: structuredClone(patch) as AfterToolCallResult };
}

function normalizeResult(value: unknown): AgentToolResult | undefined {
	const result = plainRecord(value);
	if (!result || !hasExactFields(result, ["content", "details", "usage", "addedToolNames", "terminate"]))
		return undefined;
	if (!Object.hasOwn(result, "content") || !isContent(result.content)) return undefined;
	if (!Object.hasOwn(result, "details") || !isJsonValue(result.details)) return undefined;
	if (Object.hasOwn(result, "usage") && !isUsage(result.usage)) return undefined;
	if (
		Object.hasOwn(result, "addedToolNames") &&
		(!isJsonValue(result.addedToolNames) ||
			!Array.isArray(result.addedToolNames) ||
			!result.addedToolNames.every((name) => typeof name === "string"))
	)
		return undefined;
	if (Object.hasOwn(result, "terminate") && typeof result.terminate !== "boolean") return undefined;
	return structuredClone(result) as unknown as AgentToolResult;
}

function normalizeExternalResult(value: unknown): { result: AgentToolResult; valid: boolean } {
	const result = normalizeResult(value);
	if (result) return { result, valid: true };
	let usage: Usage | undefined;
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const prototype = Object.getPrototypeOf(value);
		const descriptor = Object.getOwnPropertyDescriptor(value, "usage");
		if (
			(prototype === Object.prototype || prototype === null) &&
			descriptor?.enumerable &&
			"value" in descriptor &&
			isUsage(descriptor.value)
		)
			usage = structuredClone(descriptor.value);
	}
	return { result: { ...createErrorToolResult(INVALID_TOOL_RESULT), ...(usage ? { usage } : {}) }, valid: false };
}

function immediate(toolCall: AgentToolCall, message: string, terminate = false): ImmediateToolCallOutcome {
	return { kind: "immediate", toolCall, result: createErrorToolResult(message), isError: true, terminate };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function aborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

export async function prepareToolCall(
	toolCall: AgentToolCall,
	tools: readonly AgentTool[],
	before?: BeforeToolCallCallback,
	signal?: AbortSignal,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	if (aborted(signal)) return immediate(toolCall, "Operation aborted");
	const tool = tools.find((candidate) => candidate.name === toolCall.name);
	if (!tool) return immediate(toolCall, `Tool ${toolCall.name} not found`);
	try {
		const preparedArguments = tool.prepareArguments ? tool.prepareArguments(toolCall.arguments) : toolCall.arguments;
		let args = validateToolArguments(tool, {
			...toolCall,
			arguments: preparedArguments as Record<string, unknown>,
		});
		let blocked: { reason: string; terminate: boolean } | undefined;
		if (before) {
			const normalized = normalizeBeforeToolCallResult(
				await before({ toolCall: structuredClone(toolCall), args: structuredClone(args) }, signal),
			);
			if (normalized.kind === "invalid") return immediate(toolCall, INVALID_BEFORE_OUTPUT);
			const result = normalized.value;
			if (result !== undefined) {
				let blockResult: { reason: string; terminate: boolean } | undefined;
				if (Object.hasOwn(result, "block")) {
					const block = result.block;
					if (block) blockResult = { reason: block.reason, terminate: block.terminate === true };
				}
				if (Object.hasOwn(result, "args"))
					args = validateToolArguments(tool, { ...toolCall, arguments: result.args as Record<string, unknown> });
				blocked = blockResult;
			}
		}
		if (aborted(signal)) return immediate(toolCall, "Operation aborted");
		if (blocked) return immediate(toolCall, blocked.reason, blocked.terminate);
		return { kind: "prepared", toolCall, tool, args, replay: tool.replay ?? "never" };
	} catch (error) {
		return immediate(toolCall, errorText(error));
	}
}

export async function executeToolCall(
	prepared: PreparedToolCall,
	signal?: AbortSignal,
	updateSink?: ToolUpdateSink,
): Promise<ExecutedToolCallOutcome> {
	const updates: Promise<void>[] = [];
	let acceptingUpdates = true;
	let sinkFailure: unknown;
	let sinkRejected = false;
	try {
		let execution: Promise<AgentToolResult>;
		try {
			execution = prepared.tool.execute(prepared.toolCall.id, prepared.args as never, signal, (partialResult) => {
				if (!acceptingUpdates || !updateSink) return;
				const update = normalizeResult(partialResult);
				if (!update) return;
				const pending = Promise.resolve()
					.then(() => updateSink({ toolCall: prepared.toolCall, partialResult: update }))
					.catch((error: unknown) => {
						if (!sinkRejected) sinkFailure = error;
						sinkRejected = true;
					});
				updates.push(pending);
			});
		} catch (error) {
			execution = Promise.reject(error);
		}
		let value: unknown;
		let toolFailure: unknown;
		let toolRejected = false;
		try {
			value = await execution;
		} catch (error) {
			toolFailure = error;
			toolRejected = true;
		}
		acceptingUpdates = false;
		await Promise.all(updates);
		if (sinkRejected) throw sinkFailure;
		if (toolRejected) return { result: createErrorToolResult(errorText(toolFailure)), isError: true };
		const normalized = normalizeExternalResult(value);
		return { result: normalized.result, isError: !normalized.valid };
	} finally {
		acceptingUpdates = false;
	}
}

export async function finalizeToolCall(
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	after?: AfterToolCallCallback,
	signal?: AbortSignal,
): Promise<FinalizedToolCallOutcome> {
	const normalized = normalizeExternalResult(executed.result);
	let result = normalized.result;
	let isError = normalized.valid ? executed.isError : true;
	if (after) {
		try {
			const normalizedOutput = normalizeAfterToolCallResult(
				await after(
					{
						toolCall: structuredClone(prepared.toolCall),
						args: structuredClone(prepared.args),
						result: structuredClone(result),
						isError,
					},
					signal,
				),
			);
			if (normalizedOutput.kind === "invalid") throw new Error(INVALID_AFTER_OUTPUT);
			const output = normalizedOutput.value;
			if (output) {
				result = {
					content: output.content ?? result.content,
					details: Object.hasOwn(output, "details") ? output.details : result.details,
					...(Object.hasOwn(output, "usage")
						? { usage: output.usage }
						: result.usage
							? { usage: result.usage }
							: {}),
					...(result.addedToolNames ? { addedToolNames: result.addedToolNames } : {}),
					...(Object.hasOwn(output, "terminate")
						? { terminate: output.terminate }
						: result.terminate !== undefined
							? { terminate: result.terminate }
							: {}),
				};
				isError = output.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(errorText(error));
			isError = true;
		}
	}
	const finalResult = normalizeResult(result);
	if (!finalResult) {
		result = createErrorToolResult(INVALID_TOOL_RESULT);
		isError = true;
	} else result = finalResult;
	return { toolCall: prepared.toolCall, result, isError, terminate: result.terminate === true };
}

export function createErrorToolResult(message: string): AgentToolResult<Record<string, never>> {
	return { content: [{ type: "text", text: message }], details: {} };
}

export function createToolResultMessage(
	finalized: FinalizedToolCallOutcome,
	timestamp = Date.now(),
): ToolResultMessage {
	const external = normalizeExternalResult(finalized.result);
	const normalized = external.result;
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		content: normalized.content ?? [],
		details: normalized.details,
		...(normalized.usage ? { usage: normalized.usage } : {}),
		...(normalized.addedToolNames?.length ? { addedToolNames: normalized.addedToolNames } : {}),
		isError: external.valid ? finalized.isError : true,
		timestamp,
	};
}
