import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createModels, type ModelRequestLease, Type } from "@earendil-works/pi-ai";
import type { LaneConfiguration } from "../src/durable.ts";
import type { ActionInfo } from "../src/planner.ts";
import type { RuntimeToolDefinition } from "../src/runtime-shell.ts";
import { user } from "./fixtures.ts";

export const VERSION = 1;
export const INITIAL_TIME = 1_720_000_000_000;
export const RECOVERY_TIME = INITIAL_TIME + 30_000;
export const PROJECTED_MESSAGE = user("projected deferred write");
export const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "deferred-write" },
	thinkingLevel: "off",
	activeToolNames: [],
};
export const prompt = user("deferred-write crash prompt");
export type Classification = "projecting" | "unprojected";
export type Cut = "pre-placement" | "post-placement";

export interface Counts {
	modelLeases: number;
	providerStarts: number;
	toolStarts: number;
	projectors: number;
}

export function effects(classification: Classification, phase: "initial" | "recovery" | "idle") {
	const counts: Counts = { modelLeases: 0, providerStarts: 0, toolStarts: 0, projectors: 0 };
	const models = createModels();
	const lease = {
		model: { provider: "test", id: "deferred-write", maxTokens: 4096, contextWindow: 8192 },
		stream() {
			counts.providerStarts++;
			throw new Error("unexpected provider start");
		},
		streamSimple() {
			counts.providerStarts++;
			throw new Error("unexpected provider start");
		},
		fetchDeferred() {
			throw new Error("unexpected deferred fetch");
		},
		cancelDeferred() {
			throw new Error("unexpected deferred cancel");
		},
	} as unknown as ModelRequestLease;
	Object.defineProperty(models, "lease", {
		value: () => {
			counts.modelLeases++;
			return lease;
		},
	});
	const projector = () => {
		counts.projectors++;
		emit({ event: "projector", phase, classification });
		return classification === "projecting" ? [PROJECTED_MESSAGE] : [];
	};
	const tool: RuntimeToolDefinition<object> = {
		name: "unexpected",
		label: "Unexpected",
		description: "must not run",
		parameters: Type.Object({}, { additionalProperties: false }),
		replay: "never",
		async execute() {
			counts.toolStarts++;
			throw new Error("unexpected tool start");
		},
	};
	return { models, tool, counts, entryProjectors: { [classification]: projector } };
}

export function actionShape(value: unknown): value is ActionInfo {
	if (!plain(value) || typeof value.kind !== "string" || typeof value.operationId !== "string") return false;
	const keys: Record<string, readonly string[]> = {
		apply_deferred_writes: ["kind", "operationId", "entryIds"],
		start_assistant_step: ["kind", "operationId", "triggerEntryId"],
		finish_aborted_run: ["kind", "operationId"],
	};
	const expected = keys[value.kind];
	if (
		!expected ||
		Object.keys(value).length !== expected.length ||
		!expected.every((key) => Object.hasOwn(value, key))
	)
		return false;
	if (value.kind === "apply_deferred_writes")
		return Array.isArray(value.entryIds) && value.entryIds.every((id) => typeof id === "string");
	return Object.entries(value).every(([key, field]) => key === "kind" || typeof field === "string");
}

export function emit(value: object): void {
	writeSync(1, `${JSON.stringify({ v: VERSION, ...value })}\n`);
}

export function snapshot(path: string, sessionId: string): Record<string, unknown[]> {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const read = (table: string, order: string) =>
			db.prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${order}`).all(sessionId);
		return {
			sessions: read("sessions", "session_id"),
			sequences: read("session_sequences", "session_id"),
			stats: read("session_stats", "session_id"),
			entries: read("entries", "seq"),
			registers: read("registers", "namespace,key"),
			usage: read("usage_ledger", "seq"),
			branches: read("branch_meta", "branch_id"),
			branchEntries: read("branch_entries", "branch_id,entry_seq"),
			writerLeases: read("writer_leases", "session_id"),
		};
	} finally {
		db.close();
	}
}

export function plain(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
