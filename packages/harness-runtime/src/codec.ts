import type { Message, Usage } from "@earendil-works/pi-ai";
import { assertEntry, assertJsonValue, type Entry, type JsonValue } from "@nguyenphutrong/pi-session-storage";
import { type CustomEntry, type Entry as PublicEntry, SessionError } from "./types.ts";

type Code = "invalid_message" | "invalid_query" | "corruption";

function fail(code: Code, message: string): never {
	throw new SessionError(code, message);
}

function object(value: unknown, code: Code, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be an object`);
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
		fail(code, `${label} must be a plain object`);
	return value as Record<string, unknown>;
}

function fields(
	value: Record<string, unknown>,
	required: string[],
	optional: string[],
	code: Code,
	label: string,
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `${label} has unknown property ${key}`);
	for (const key of required) if (!Object.hasOwn(value, key)) fail(code, `${label} is missing ${key}`);
}

function string(value: unknown, code: Code, label: string): asserts value is string {
	if (typeof value !== "string") fail(code, `${label} must be a string`);
}

function number(value: unknown, code: Code, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(code, `${label} must be a finite number`);
}

function boolean(value: unknown, code: Code, label: string): asserts value is boolean {
	if (typeof value !== "boolean") fail(code, `${label} must be a boolean`);
}

function array(value: unknown, code: Code, label: string): asserts value is unknown[] {
	if (!Array.isArray(value)) fail(code, `${label} must be an array`);
}

function usage(value: unknown, code: Code): asserts value is Usage {
	const item = object(value, code, "usage");
	fields(
		item,
		["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"],
		["cacheWrite1h", "reasoning"],
		code,
		"usage",
	);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
		number(item[key], code, `usage.${key}`);
	if (item.cacheWrite1h !== undefined) number(item.cacheWrite1h, code, "usage.cacheWrite1h");
	if (item.reasoning !== undefined) number(item.reasoning, code, "usage.reasoning");
	const cost = object(item.cost, code, "usage.cost");
	fields(cost, ["input", "output", "cacheRead", "cacheWrite", "total"], [], code, "usage.cost");
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"])
		number(cost[key], code, `usage.cost.${key}`);
}

function content(value: unknown, allowed: readonly string[], code: Code): void {
	array(value, code, "message.content");
	for (const candidate of value) {
		const item = object(candidate, code, "content item");
		string(item.type, code, "content.type");
		if (!allowed.includes(item.type)) fail(code, `Unsupported content type: ${item.type}`);
		if (item.type === "text") {
			fields(item, ["type", "text"], ["textSignature"], code, "text content");
			string(item.text, code, "content.text");
			if (item.textSignature !== undefined) string(item.textSignature, code, "content.textSignature");
		} else if (item.type === "image") {
			fields(item, ["type", "data", "mimeType"], [], code, "image content");
			string(item.data, code, "content.data");
			string(item.mimeType, code, "content.mimeType");
		} else if (item.type === "thinking") {
			fields(item, ["type", "thinking"], ["thinkingSignature", "redacted"], code, "thinking content");
			string(item.thinking, code, "content.thinking");
			if (item.thinkingSignature !== undefined) string(item.thinkingSignature, code, "content.thinkingSignature");
			if (item.redacted !== undefined) boolean(item.redacted, code, "content.redacted");
		} else {
			fields(item, ["type", "id", "name", "arguments"], ["thoughtSignature", "namespace"], code, "tool call");
			string(item.id, code, "content.id");
			string(item.name, code, "content.name");
			object(item.arguments, code, "content.arguments");
			if (item.thoughtSignature !== undefined) string(item.thoughtSignature, code, "content.thoughtSignature");
			if (item.namespace !== undefined) string(item.namespace, code, "content.namespace");
		}
	}
}

function validateMessage(value: unknown, code: Code): asserts value is Message {
	try {
		assertJsonValue(value);
	} catch (error) {
		throw new SessionError(code, "Message must be detached JSON-safe data", error);
	}
	const message = object(value, code, "message");
	string(message.role, code, "message.role");
	if (message.role === "user") {
		fields(message, ["role", "content", "timestamp"], [], code, "user message");
		if (typeof message.content !== "string") content(message.content, ["text", "image"], code);
		number(message.timestamp, code, "message.timestamp");
	} else if (message.role === "assistant") {
		fields(
			message,
			["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"],
			["responseModel", "responseId", "diagnostics", "deferred", "errorMessage", "rawStopReason", "endTurn"],
			code,
			"assistant message",
		);
		content(message.content, ["text", "thinking", "toolCall"], code);
		for (const key of ["api", "provider", "model"] as const) string(message[key], code, `message.${key}`);
		string(message.stopReason, code, "message.stopReason");
		const stopReason = message.stopReason;
		if (!["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(stopReason))
			fail(code, stopReason === "pending" ? "Assistant message is not settled" : "Unknown assistant stop reason");
		for (const key of ["responseModel", "responseId", "errorMessage", "rawStopReason"] as const)
			if (message[key] !== undefined) string(message[key], code, `message.${key}`);
		if (message.endTurn !== undefined) boolean(message.endTurn, code, "message.endTurn");
		usage(message.usage, code);
		number(message.timestamp, code, "message.timestamp");
		if (message.diagnostics !== undefined) {
			array(message.diagnostics, code, "message.diagnostics");
			for (const candidate of message.diagnostics) {
				const diagnostic = object(candidate, code, "message diagnostic");
				fields(diagnostic, ["type", "timestamp"], ["error", "details"], code, "message diagnostic");
				string(diagnostic.type, code, "diagnostic.type");
				number(diagnostic.timestamp, code, "diagnostic.timestamp");
				if (diagnostic.error !== undefined) {
					const error = object(diagnostic.error, code, "diagnostic.error");
					fields(error, ["message"], ["name", "stack", "code"], code, "diagnostic.error");
					string(error.message, code, "diagnostic.error.message");
					for (const key of ["name", "stack"] as const)
						if (error[key] !== undefined) string(error[key], code, `diagnostic.error.${key}`);
					if (error.code !== undefined && typeof error.code !== "string" && typeof error.code !== "number")
						fail(code, "diagnostic.error.code must be a string or number");
				}
				if (diagnostic.details !== undefined) object(diagnostic.details, code, "diagnostic.details");
			}
		}
		if (message.deferred !== undefined) {
			const handle = object(message.deferred, code, "message.deferred");
			fields(
				handle,
				["provider", "modelId", "api", "id"],
				["expiresAt", "pollAfterMs", "data"],
				code,
				"message.deferred",
			);
			for (const key of ["provider", "modelId", "api", "id"] as const)
				string(handle[key], code, `message.deferred.${key}`);
			if (handle.expiresAt !== undefined) number(handle.expiresAt, code, "message.deferred.expiresAt");
			if (handle.pollAfterMs !== undefined) number(handle.pollAfterMs, code, "message.deferred.pollAfterMs");
		}
	} else if (message.role === "toolResult") {
		fields(
			message,
			["role", "toolCallId", "toolName", "content", "isError", "timestamp"],
			["details", "usage", "addedToolNames"],
			code,
			"tool result message",
		);
		string(message.toolCallId, code, "message.toolCallId");
		string(message.toolName, code, "message.toolName");
		content(message.content, ["text", "image"], code);
		boolean(message.isError, code, "message.isError");
		number(message.timestamp, code, "message.timestamp");
		if (message.usage !== undefined) usage(message.usage, code);
		if (message.addedToolNames !== undefined) {
			array(message.addedToolNames, code, "message.addedToolNames");
			for (const name of message.addedToolNames) string(name, code, "added tool name");
		}
	} else fail(code, `Unsupported message role: ${message.role}`);
}

export function encodeMessage(message: Message): JsonValue {
	validateMessage(message, "invalid_message");
	const encoded: unknown = structuredClone(message);
	assertJsonValue(encoded);
	return encoded;
}

export type PendingEntry =
	| { readonly type: "message"; readonly payload: Message }
	| { readonly type: "custom"; readonly customType: string; readonly payload?: JsonValue };

function customType(value: unknown, code: Code): asserts value is string {
	string(value, code, "customType");
	if (value.length === 0 || value.includes("\u0000")) fail(code, "customType must be non-empty and contain no NUL");
}

function detachedJson(value: unknown, code: Code, label: string): asserts value is JsonValue {
	try {
		assertJsonValue(value);
	} catch (error) {
		throw new SessionError(code, `${label} must be detached JSON-safe data`, error);
	}
}

export function encodePendingEntry(entry: PendingEntry): JsonValue {
	const pending = object(entry, "invalid_query", "pending entry");
	if (pending.type === "message") {
		fields(pending, ["type", "payload"], [], "invalid_query", "pending entry");
		validateMessage(pending.payload, "invalid_message");
		return { type: "message", payload: encodeMessage(pending.payload) };
	}
	if (pending.type !== "custom") fail("invalid_query", "Pending entry has an unsupported type");
	fields(pending, ["type", "customType"], ["payload"], "invalid_query", "pending entry");
	customType(pending.customType, "invalid_query");
	if (!Object.hasOwn(pending, "payload")) return { type: "custom", customType: pending.customType };
	detachedJson(pending.payload, "invalid_query", "Custom entry payload");
	return { type: "custom", customType: pending.customType, payload: structuredClone(pending.payload) };
}

export function decodePendingEntry(value: unknown): PendingEntry {
	const pending = object(value, "corruption", "pending entry");
	if (pending.type === "message") {
		fields(pending, ["type", "payload"], [], "corruption", "pending entry");
		validateMessage(pending.payload, "corruption");
		return Object.freeze({ type: "message", payload: structuredClone(pending.payload) });
	}
	if (pending.type !== "custom") fail("corruption", "Pending entry has an unsupported type");
	fields(pending, ["type", "customType"], ["payload"], "corruption", "pending entry");
	customType(pending.customType, "corruption");
	if (!Object.hasOwn(pending, "payload")) return Object.freeze({ type: "custom", customType: pending.customType });
	detachedJson(pending.payload, "corruption", "Custom pending payload");
	return Object.freeze({
		type: "custom",
		customType: pending.customType,
		payload: structuredClone(pending.payload),
	});
}

export function decodeEntry(candidate: Entry): PublicEntry {
	try {
		assertEntry(candidate);
	} catch (error) {
		throw new SessionError("corruption", "Malformed storage entry envelope", error);
	}
	if (candidate.type === "custom") {
		customType(candidate.customType, "corruption");
		if (Object.hasOwn(candidate, "payload")) detachedJson(candidate.payload, "corruption", "Custom entry payload");
		const entry: CustomEntry = Object.freeze({
			id: candidate.id,
			parentId: candidate.parentId,
			seq: candidate.seq,
			timestamp: candidate.timestamp,
			type: "custom",
			customType: candidate.customType,
			...(Object.hasOwn(candidate, "payload") ? { data: structuredClone(candidate.payload) } : {}),
		});
		return entry;
	}
	if (candidate.type !== "message" || candidate.payload === undefined)
		fail("corruption", `Unsupported persisted entry type: ${candidate.type}`);
	validateMessage(candidate.payload, "corruption");
	return Object.freeze({
		id: candidate.id,
		parentId: candidate.parentId,
		seq: candidate.seq,
		timestamp: candidate.timestamp,
		type: "message",
		message: structuredClone(candidate.payload),
	});
}
