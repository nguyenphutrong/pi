import { writeSync } from "node:fs";
import { type AssistantMessage, type Context, createModels, type ModelRequestLease, Type } from "@earendil-works/pi-ai";
import type { LaneConfiguration } from "../src/durable.ts";
import type { ActionInfo } from "../src/planner.ts";
import type { RuntimeToolDefinition } from "../src/runtime-shell.ts";

export const VERSION = 1;
export const INITIAL_TIME = 1_720_000_000_000;
export const RECOVERY_TIME = INITIAL_TIME + 30_000;
export const TRACE = [
	"start_assistant_step",
	"prepare_assistant_effect",
	"dispatch_assistant_effect",
	"await_assistant_effect",
	"settle_assistant_effect",
	"prepare_tool_call",
	"dispatch_tool_effect",
	"await_tool_effect",
	"finalize_tool_effect",
	"settle_tool_effect",
	"start_assistant_step",
	"prepare_assistant_effect",
	"dispatch_assistant_effect",
	"await_assistant_effect",
	"settle_assistant_effect",
	"finish_run",
] as const;
export const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "current" },
	thinkingLevel: "medium",
	activeToolNames: ["echo"],
};
export const firstUsage = {
	input: 3,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export const finalUsage = {
	input: 7,
	output: 4,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 11,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export type Replay = "safe" | "never";
export type Phase = "initial" | "recovery" | "idle";
export interface EffectCounts {
	modelLeases: number;
	providerStarts: number;
	toolStarts: number;
}

export function emit(value: object): void {
	writeSync(1, `${JSON.stringify({ v: VERSION, ...value })}\n`);
}

export function assistantMessage(final: boolean): AssistantMessage {
	return {
		role: "assistant",
		content: final
			? [{ type: "text", text: "complete" }]
			: [{ type: "toolCall", id: "echo-1", name: "echo", arguments: { value: "durable echo" } }],
		api: "anthropic-messages",
		provider: "test",
		model: "current",
		responseId: final ? "final-response" : "tool-response",
		usage: final ? finalUsage : firstUsage,
		stopReason: final ? "stop" : "toolUse",
		timestamp: 10,
	};
}

export function effects(
	replay: Replay,
	phase: Phase,
): { models: ReturnType<typeof createModels>; tool: RuntimeToolDefinition<object>; counts: EffectCounts } {
	let providerOrdinal = 0;
	let toolOrdinal = 0;
	const counts: EffectCounts = { modelLeases: 0, providerStarts: 0, toolStarts: 0 };
	const models = createModels();
	const lease = {
		model: { provider: "test", id: "current", maxTokens: 4096, contextWindow: 8192 },
		stream() {
			throw new Error("unexpected stream");
		},
		streamSimple(context: Context) {
			counts.providerStarts++;
			emit({ event: "provider-start", phase, ordinal: providerOrdinal++, context: structuredClone(context) });
			const response = assistantMessage(context.messages.some((message) => message.role === "toolResult"));
			return { result: () => Promise.resolve(response) } as ReturnType<ModelRequestLease["streamSimple"]>;
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
	const schema = Type.Object({ value: Type.String() }, { additionalProperties: false });
	return {
		models,
		counts,
		tool: {
			name: "echo",
			label: "Echo",
			description: "echo",
			parameters: schema,
			replay,
			async execute(callId, args: { value: string }) {
				counts.toolStarts++;
				emit({ event: "tool-start", phase, ordinal: toolOrdinal++, callId, args: structuredClone(args), replay });
				return { content: [{ type: "text", text: `echoed: ${args.value}` }], details: { durable: true } };
			},
		},
	};
}

export function actionShape(value: unknown): value is ActionInfo {
	if (!plain(value) || typeof value.kind !== "string" || typeof value.operationId !== "string") return false;
	const keys: Record<string, readonly string[]> = {
		start_assistant_step: ["kind", "operationId", "triggerEntryId"],
		prepare_assistant_effect: ["kind", "operationId", "stepId", "nextAttempt"],
		dispatch_assistant_effect: ["kind", "operationId", "effectKey"],
		await_assistant_effect: ["kind", "operationId", "effectKey"],
		settle_assistant_effect: ["kind", "operationId", "effectKey"],
		recover_assistant_effect: ["kind", "operationId", "stepId", "attempt"],
		repair_materialized_assistant: ["kind", "operationId", "responseEntryId", "usageId"],
		wait_assistant_retry: ["kind", "operationId", "stepId", "nextAttempt", "notBefore"],
		release_assistant_retry: ["kind", "operationId", "stepId", "nextAttempt", "notBefore"],
		prepare_tool_call: ["kind", "operationId", "assistantEntryId", "sourceIndex", "resultEntryId"],
		dispatch_tool_effect: ["kind", "operationId", "effectKey"],
		await_tool_effect: ["kind", "operationId", "effectKey"],
		finalize_tool_effect: ["kind", "operationId", "effectKey"],
		settle_tool_effect: ["kind", "operationId", "effectKey"],
		recover_tool_effect: ["kind", "operationId", "assistantEntryId", "turnId", "sourceIndex", "resultEntryId"],
		finish_run: ["kind", "operationId", "triggerEntryId"],
	};
	if (
		!(
			keys[value.kind]?.length === Object.keys(value).length &&
			keys[value.kind]?.every((key) => Object.hasOwn(value, key)) === true
		)
	)
		return false;
	for (const [key, field] of Object.entries(value)) {
		if (key === "kind") continue;
		if (["nextAttempt", "attempt", "notBefore", "sourceIndex"].includes(key)) {
			if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) return false;
		} else if (typeof field !== "string") return false;
	}
	return true;
}

export function plain(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
