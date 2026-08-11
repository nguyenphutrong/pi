import type { Usage } from "@earendil-works/pi-ai";
import { isUuidV7 } from "./id.ts";
import {
	type BranchScan,
	type Entry,
	type EntryScan,
	type JsonValue,
	type Register,
	StorageError,
	type Transaction,
	type UsageRow,
} from "./types.ts";

type ValidationCode = "invalid_id" | "invalid_payload" | "invalid_query" | "invalid_transaction" | "corruption";

const ENTRY_TYPES = new Set(["message", "compaction", "branch_summary", "custom"]);

function invalid(code: ValidationCode, message: string): never {
	throw new StorageError(code, message);
}

function guard(code: ValidationCode, validate: () => void): void {
	try {
		validate();
	} catch (error) {
		if (error instanceof StorageError) throw error;
		throw new StorageError(code, error instanceof Error ? error.message : "Runtime validation failed");
	}
}

function record(value: unknown, code: ValidationCode, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(code, `${label} must be an object`);
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
		invalid(code, `${label} must be a plain object`);
	if (Object.getOwnPropertySymbols(value).length > 0) invalid(code, `${label} has unsupported properties`);
	const names = Object.getOwnPropertyNames(value);
	if (names.length !== Object.keys(value).length) invalid(code, `${label} has unsupported properties`);
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (!descriptor || !("value" in descriptor)) invalid(code, `${label} contains an accessor`);
	}
	return value as Record<string, unknown>;
}

function fields(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
	code: ValidationCode,
	label: string,
): void {
	const supported = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) if (!supported.has(key)) invalid(code, `${label} has unknown property ${key}`);
	for (const key of required) if (!Object.hasOwn(value, key)) invalid(code, `${label} is missing ${key}`);
}

function string(value: unknown, code: ValidationCode, label: string): asserts value is string {
	if (typeof value !== "string") invalid(code, `${label} must be a string`);
}

function finite(value: unknown, code: ValidationCode, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value)) invalid(code, `${label} must be a finite number`);
}

function safeInteger(value: unknown, code: ValidationCode, label: string, minimum: number): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum)
		invalid(code, `${label} must be a ${minimum === 0 ? "non-negative" : "positive"} safe integer`);
}

function uuid(
	value: unknown,
	code: ValidationCode,
	invalidIdCode: ValidationCode,
	label: string,
): asserts value is string {
	string(value, code, label);
	if (!isUuidV7(value)) invalid(invalidIdCode, `${label} must be a UUIDv7`);
}

function text(value: unknown, code: ValidationCode, label: string, allowEmpty: boolean): asserts value is string {
	string(value, code, label);
	if ((!allowEmpty && value.length === 0) || value.includes("\u0000"))
		invalid(code, `${label} must ${allowEmpty ? "contain no NUL" : "be non-empty and contain no NUL"}`);
}

function denseArray(value: unknown, code: ValidationCode, label: string): asserts value is unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		invalid(code, `${label} must be a dense array`);
	if (Object.getOwnPropertySymbols(value).length > 0) invalid(code, `${label} has unsupported properties`);
	const names = Object.getOwnPropertyNames(value);
	if (names.length !== value.length + 1 || !names.includes("length")) invalid(code, `${label} must be a dense array`);
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
			invalid(code, `${label} must be a dense array`);
	}
}

function validateJsonValue(value: unknown, code: ValidationCode): void {
	guard(code, () => {
		const seen = new WeakSet<object>();
		const visit = (candidate: unknown): void => {
			if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return;
			if (typeof candidate === "number") {
				if (!Number.isFinite(candidate)) invalid(code, "JSON contains a non-finite number");
				return;
			}
			if (typeof candidate !== "object") invalid(code, `JSON contains ${typeof candidate}`);
			if (seen.has(candidate)) invalid(code, "JSON contains a cycle");
			seen.add(candidate);
			if (Array.isArray(candidate)) {
				denseArray(candidate, code, "JSON array");
				for (const item of candidate) visit(item);
			} else {
				for (const item of Object.values(record(candidate, code, "JSON object"))) visit(item);
			}
			seen.delete(candidate);
		};
		visit(value);
	});
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
	validateJsonValue(value, "invalid_payload");
}

function validateUsage(value: unknown, code: ValidationCode): void {
	const usage = record(value, code, "usage");
	fields(
		usage,
		["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"],
		["cacheWrite1h", "reasoning"],
		code,
		"usage",
	);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
		finite(usage[key], code, `usage.${key}`);
	if (Object.hasOwn(usage, "cacheWrite1h")) finite(usage.cacheWrite1h, code, "usage.cacheWrite1h");
	if (Object.hasOwn(usage, "reasoning")) finite(usage.reasoning, code, "usage.reasoning");
	const cost = record(usage.cost, code, "usage.cost");
	fields(cost, ["input", "output", "cacheRead", "cacheWrite", "total"], [], code, "usage.cost");
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
		finite(cost[key], code, `usage.cost.${key}`);
}

export function assertUsage(value: unknown): asserts value is Usage {
	guard("invalid_transaction", () => validateUsage(value, "invalid_transaction"));
}

function validateEntryEnvelope(value: unknown, complete: boolean, code: ValidationCode): void {
	const entry = record(value, code, "entry");
	fields(
		entry,
		["id", "parentId", "type", ...(complete ? ["seq", "timestamp"] : [])],
		["customType", "payload"],
		code,
		"entry",
	);
	uuid(entry.id, code, code === "invalid_transaction" ? "invalid_id" : code, "entry.id");
	if (entry.parentId !== null)
		uuid(entry.parentId, code, code === "invalid_transaction" ? "invalid_id" : code, "entry.parentId");
	if (typeof entry.type !== "string" || !ENTRY_TYPES.has(entry.type)) invalid(code, "Unknown entry type");
	if (complete) {
		safeInteger(entry.seq, code, "entry.seq", 1);
		safeInteger(entry.timestamp, code, "entry.timestamp", 0);
	}
	if (entry.type === "custom") {
		if (!Object.hasOwn(entry, "customType")) invalid(code, "Custom entry requires customType");
		text(entry.customType, code, "entry.customType", false);
	} else {
		if (Object.hasOwn(entry, "customType")) invalid(code, "Only custom entries may have customType");
		if (!Object.hasOwn(entry, "payload")) invalid(code, "Non-custom entry requires payload");
	}
	if (Object.hasOwn(entry, "payload"))
		validateJsonValue(entry.payload, code === "invalid_transaction" ? "invalid_payload" : code);
}

function validateUsageRowEnvelope(value: unknown, complete: boolean, code: ValidationCode): void {
	const row = record(value, code, "usage row");
	fields(row, ["id", "usage", "adjustment", ...(complete ? ["seq"] : [])], ["entryId", "details"], code, "usage row");
	uuid(row.id, code, code === "invalid_transaction" ? "invalid_id" : code, "usage row.id");
	if (complete) safeInteger(row.seq, code, "usage row.seq", 1);
	if (Object.hasOwn(row, "entryId"))
		uuid(row.entryId, code, code === "invalid_transaction" ? "invalid_id" : code, "usage row.entryId");
	if (typeof row.adjustment !== "boolean") invalid(code, "usage row.adjustment must be boolean");
	validateUsage(row.usage, code);
	if (Object.hasOwn(row, "details"))
		validateJsonValue(row.details, code === "invalid_transaction" ? "invalid_payload" : code);
}

export function assertEntry(value: unknown): asserts value is Entry {
	guard("corruption", () => validateEntryEnvelope(value, true, "corruption"));
}

export function assertUsageRow(value: unknown): asserts value is UsageRow {
	guard("corruption", () => validateUsageRowEnvelope(value, true, "corruption"));
}

export function assertRegister(value: unknown): asserts value is Register {
	guard("corruption", () => {
		const register = record(value, "corruption", "register");
		fields(register, ["namespace", "key", "value", "seq"], [], "corruption", "register");
		text(register.namespace, "corruption", "register.namespace", false);
		text(register.key, "corruption", "register.key", true);
		safeInteger(register.seq, "corruption", "register.seq", 1);
		validateJsonValue(register.value, "corruption");
	});
}

export function assertTransaction(value: unknown): asserts value is Transaction {
	guard("invalid_transaction", () => {
		const tx = record(value, "invalid_transaction", "transaction");
		fields(tx, ["writes"], [], "invalid_transaction", "transaction");
		denseArray(tx.writes, "invalid_transaction", "writes");
		if (tx.writes.length === 0) invalid("invalid_transaction", "Transaction must contain at least one write");
		for (const candidate of tx.writes) {
			const write = record(candidate, "invalid_transaction", "write");
			string(write.kind, "invalid_transaction", "write.kind");
			if (write.kind === "entry") {
				fields(write, ["kind", "entry"], [], "invalid_transaction", "entry write");
				validateEntryEnvelope(write.entry, false, "invalid_transaction");
			} else if (write.kind === "usage") {
				fields(write, ["kind", "row"], [], "invalid_transaction", "usage write");
				validateUsageRowEnvelope(write.row, false, "invalid_transaction");
			} else if (write.kind === "register") {
				string(write.op, "invalid_transaction", "register op");
				if (write.op !== "set" && write.op !== "delete") invalid("invalid_transaction", "Unknown register op");
				fields(
					write,
					["kind", "op", "namespace", "key", ...(write.op === "set" ? ["value"] : [])],
					[],
					"invalid_transaction",
					"register write",
				);
				string(write.namespace, "invalid_transaction", "register namespace");
				string(write.key, "invalid_transaction", "register key");
				if (write.namespace.length === 0 || write.namespace.includes("\u0000"))
					invalid("invalid_transaction", "register namespace must be non-empty and contain no NUL");
				if (write.key.includes("\u0000")) invalid("invalid_transaction", "register key must contain no NUL");
				if (write.op === "set") assertJsonValue(write.value);
			} else invalid("invalid_transaction", "Unknown write kind");
		}
	});
}

function query(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
	const result = record(value, "invalid_query", label);
	fields(result, [], allowed, "invalid_query", label);
	return result;
}

export function assertEntryScan(value: unknown): asserts value is EntryScan {
	guard("invalid_query", () => {
		const scan = query(value, ["type", "customType", "fromSeq", "toSeq", "order", "limit"], "entry scan");
		if (scan.type !== undefined && (typeof scan.type !== "string" || !ENTRY_TYPES.has(scan.type)))
			invalid("invalid_query", "Unknown entry type");
		if (scan.customType !== undefined) string(scan.customType, "invalid_query", "customType");
		for (const key of ["fromSeq", "toSeq", "limit"] as const)
			if (scan[key] !== undefined && typeof scan[key] !== "number")
				invalid("invalid_query", `${key} must be a number`);
		if (scan.order !== undefined && scan.order !== "asc" && scan.order !== "desc")
			invalid("invalid_query", "Unknown entry order");
	});
}

export function assertBranchScan(value: unknown): asserts value is BranchScan {
	guard("invalid_query", () => {
		const scan = query(
			value,
			["start", "stopAtType", "stopAtId", "type", "customType", "order", "limit", "cursor"],
			"branch scan",
		);
		string(scan.start, "invalid_query", "start");
		for (const key of ["stopAtType", "type"] as const)
			if (scan[key] !== undefined && (typeof scan[key] !== "string" || !ENTRY_TYPES.has(scan[key] as string)))
				invalid("invalid_query", `Unknown ${key}`);
		for (const key of ["stopAtId", "customType"] as const)
			if (scan[key] !== undefined) string(scan[key], "invalid_query", key);
		if (scan.order !== undefined && scan.order !== "newestFirst" && scan.order !== "oldestFirst")
			invalid("invalid_query", "Unknown branch order");
		if (scan.limit !== undefined && typeof scan.limit !== "number")
			invalid("invalid_query", "limit must be a number");
		if (scan.cursor !== undefined) {
			const cursor = query(scan.cursor, ["seq"], "cursor");
			if (!Object.hasOwn(cursor, "seq") || typeof cursor.seq !== "number")
				invalid("invalid_query", "cursor.seq must be a number");
		}
	});
}

export function assertIdList(value: unknown): asserts value is string[] {
	guard("invalid_query", () => {
		denseArray(value, "invalid_query", "ids");
		const seen = new Set<string>();
		for (const id of value) {
			string(id, "invalid_query", "entry id");
			if (seen.has(id)) invalid("invalid_query", "entry ids must be unique");
			seen.add(id);
		}
	});
}

export function assertQueryText(value: unknown, label: string): asserts value is string {
	guard("invalid_query", () => string(value, "invalid_query", label));
}
