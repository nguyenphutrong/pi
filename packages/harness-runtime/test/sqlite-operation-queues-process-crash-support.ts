import { writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createModels, type Message, type ModelRequestLease, Type } from "@earendil-works/pi-ai";
import type { LaneConfiguration } from "../src/durable.ts";
import type { RuntimeToolDefinition } from "../src/runtime-shell.ts";

export const VERSION = 1;
export const INITIAL_TIME = 1_720_000_000_000;
export const RECOVERY_TIME = INITIAL_TIME + 30_000;
export const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "queue" },
	thinkingLevel: "off",
	activeToolNames: [],
};
export const messages: Record<"prompt" | "followUp" | "nextRun" | "steer", Message> = {
	prompt: { role: "user", content: [{ type: "text", text: "prompt" }], timestamp: INITIAL_TIME },
	followUp: { role: "user", content: [{ type: "text", text: "follow-up" }], timestamp: INITIAL_TIME },
	nextRun: { role: "user", content: [{ type: "text", text: "next-run" }], timestamp: INITIAL_TIME },
	steer: { role: "user", content: [{ type: "text", text: "steer" }], timestamp: INITIAL_TIME },
};

export interface EffectCounts {
	modelLeases: number;
	providerStarts: number;
	toolStarts: number;
}

export function effects(): {
	models: ReturnType<typeof createModels>;
	tool: RuntimeToolDefinition<object>;
	counts: EffectCounts;
} {
	const counts: EffectCounts = { modelLeases: 0, providerStarts: 0, toolStarts: 0 };
	const models = createModels();
	const lease = {
		model: { provider: "test", id: "queue", maxTokens: 4096, contextWindow: 8192 },
		stream() {
			counts.providerStarts++;
			throw new Error("unexpected stream");
		},
		streamSimple() {
			counts.providerStarts++;
			throw new Error("unexpected streamSimple");
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
	return {
		models,
		counts,
		tool: {
			name: "unexpected",
			label: "Unexpected",
			description: "must not execute during queue recovery",
			parameters: Type.Object({}, { additionalProperties: false }),
			replay: "never",
			async execute() {
				counts.toolStarts++;
				throw new Error("unexpected tool effect");
			},
		},
	};
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
