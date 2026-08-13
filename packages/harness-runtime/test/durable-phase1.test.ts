import type { Register } from "@nguyenphutrong/pi-session-storage";
import { describe, expect, it } from "vitest";
import {
	decodeLaneConfiguration,
	decodeLaneStateRegister,
	decodeRunOperationRegister,
	decodeRunStateRegister,
} from "../src/durable.ts";
import { id } from "./fixtures.ts";

const OPERATION_ID = id();
const TRIGGER_ID = id();
const STEP_ID = id();
const RESPONSE_ID = id();
const USAGE_ID = id();
const RESULT_ID = id();

function register(namespace: string, key: string, value: unknown, seq = 17): Register {
	return { namespace, key, value: value as Register["value"], seq };
}

function configuration() {
	return { model: { provider: "test", modelId: "model" }, thinkingLevel: "medium" as const, activeToolNames: [] };
}

function context() {
	return {
		stepId: STEP_ID,
		triggerEntryId: TRIGGER_ID,
		configuration: configuration(),
		streamOptions: {
			transport: "sse",
			timeoutMs: 100,
			maxRetries: 2,
			maxRetryDelayMs: 1_000,
			headers: { authorization: "redacted" },
			metadata: { nested: [null, true, { n: 1 }] },
			cacheRetention: "short",
			deferred: false,
		},
		retryPolicy: { maxAttempts: 3, baseDelayMs: 20 },
		overflowRecoveryUsed: false,
	};
}

function common(phase: unknown, latestAssistantEntryId: string | null = null) {
	return {
		kind: "run",
		control: { status: "running" },
		settings: {
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			toolExecution: "sequential",
		},
		phase,
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId,
	};
}

const phases = {
	needAssistant: {
		kind: "checkpoint",
		continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
		triggerEntryId: TRIGGER_ID,
	},
	ready: { kind: "assistant", generation: { status: "ready", context: context(), nextAttempt: 1 } },
	effectPending: {
		kind: "assistant",
		generation: {
			status: "effect_pending",
			context: context(),
			attempt: 1,
			responseEntryId: RESPONSE_ID,
			usageId: USAGE_ID,
			intendedOutputLimit: 4_096,
			contextWindow: 128_000,
		},
	},
	retryWait: {
		kind: "assistant",
		generation: {
			status: "retry_wait",
			context: context(),
			nextAttempt: 2,
			notBefore: 123,
			errorMessage: "Provider outcome unknown after interruption",
		},
	},
	failureDrain: {
		kind: "failure_drain",
		error: { code: "provider_interrupted", message: "Provider outcome unknown after interruption" },
		provenance: { kind: "response", entryId: RESPONSE_ID },
	},
	mayFinish: {
		kind: "checkpoint",
		continuation: { kind: "may_finish", includeFinalAssistant: true },
		triggerEntryId: TRIGGER_ID,
	},
	tools: {
		kind: "tools",
		batch: {
			assistantEntryId: RESPONSE_ID,
			configuration: { ...configuration(), activeToolNames: ["read"] },
			turnId: STEP_ID,
			calls: [{ status: "planned", sourceIndex: 0, resultEntryId: RESULT_ID }],
		},
	},
} as const;

function decodeState(value: unknown) {
	return decodeRunStateRegister(register("op.state", OPERATION_ID, value), OPERATION_ID);
}

function expectCorruption(action: () => unknown): void {
	expect(action).toThrow(expect.objectContaining({ code: "corruption" }));
}

describe("Phase 1 durable codecs", () => {
	it.each([
		["checkpoint need_assistant", phases.needAssistant, null],
		["assistant ready", phases.ready, null],
		["assistant effect_pending", phases.effectPending, null],
		["assistant retry_wait", phases.retryWait, null],
		["failure drain", phases.failureDrain, RESPONSE_ID],
		["checkpoint may_finish", phases.mayFinish, TRIGGER_ID],
		["all-planned tool batch", phases.tools, RESPONSE_ID],
	] as const)("accepts the exact canonical %s fixture", (_label, phase, latest) => {
		const decoded = decodeState(common(phase, latest));
		expect(decoded).toEqual({ seq: 17, value: common(phase, latest) });
		expect(decoded.value).not.toBe(common(phase, latest));
	});

	it("accepts active tools and rejects malformed tool plans", () => {
		expect(decodeLaneConfiguration({ ...configuration(), activeToolNames: ["read", "write"] })).toEqual({
			...configuration(),
			activeToolNames: ["read", "write"],
		});
		for (const calls of [
			[],
			[{ status: "planned", sourceIndex: 1, resultEntryId: RESULT_ID }],
			[
				{ status: "planned", sourceIndex: 0, resultEntryId: RESULT_ID },
				{ status: "planned", sourceIndex: 1, resultEntryId: RESULT_ID },
			],
			[{ status: "planned", sourceIndex: 0, resultEntryId: "bad" }],
		])
			expectCorruption(() =>
				decodeState(common({ ...phases.tools, batch: { ...phases.tools.batch, calls } }, RESPONSE_ID)),
			);
		expectCorruption(() => decodeLaneConfiguration({ ...configuration(), activeToolNames: ["read", "read"] }));
	});

	it.each([1, 2, 3])("accepts ready and effect_pending attempt %i through the captured cap", (attempt) => {
		expect(
			decodeState(common({ ...phases.ready, generation: { ...phases.ready.generation, nextAttempt: attempt } }))
				.value,
		).toBeDefined();
		expect(
			decodeState(common({ ...phases.effectPending, generation: { ...phases.effectPending.generation, attempt } }))
				.value,
		).toBeDefined();
	});

	it.each([0, 4])("rejects ready and effect_pending attempt %i outside the captured cap", (attempt) => {
		expectCorruption(() =>
			decodeState(common({ ...phases.ready, generation: { ...phases.ready.generation, nextAttempt: attempt } })),
		);
		expectCorruption(() =>
			decodeState(common({ ...phases.effectPending, generation: { ...phases.effectPending.generation, attempt } })),
		);
	});

	it("validates the exact retry_wait and failure_drain shapes", () => {
		for (const nextAttempt of [2, 3])
			expect(
				decodeState(common({ ...phases.retryWait, generation: { ...phases.retryWait.generation, nextAttempt } }))
					.value,
			).toBeDefined();
		for (const generation of [
			{ ...phases.retryWait.generation, nextAttempt: 1 },
			{ ...phases.retryWait.generation, nextAttempt: 4 },
			{ ...phases.retryWait.generation, notBefore: -1 },
			{ ...phases.retryWait.generation, notBefore: Number.MAX_SAFE_INTEGER + 1 },
			{ ...phases.retryWait.generation, errorMessage: 1 },
			{ ...phases.retryWait.generation, errorMessage: "different" },
			{ ...phases.retryWait.generation, extra: true },
		])
			expectCorruption(() => decodeState(common({ kind: "assistant", generation })));
		for (const phase of [
			{ ...phases.failureDrain, extra: true },
			{ ...phases.failureDrain, error: { ...phases.failureDrain.error, extra: true } },
			{ ...phases.failureDrain, provenance: { kind: "structural", entryId: RESPONSE_ID } },
			{ ...phases.failureDrain, provenance: { kind: "response", entryId: id() } },
		])
			expectCorruption(() => decodeState(common(phase, RESPONSE_ID)));
	});

	it("preserves canonical register identity, sequence, and common run fields", () => {
		const value = common(phases.ready);
		const decoded = decodeRunStateRegister(register("op.state", OPERATION_ID, value, 41), OPERATION_ID);
		expect(decoded.seq).toBe(41);
		expect(decoded.value.control).toEqual({ status: "running" });
		expect(decoded.value.settings).toEqual(value.settings);
		expect(decoded.value.inbox).toEqual({ steer: [], followUp: [], writes: [] });
		expect(() => decodeRunStateRegister(register("op.meta", OPERATION_ID, value), OPERATION_ID)).toThrow();
		expect(() => decodeRunStateRegister(register("op.state", id(), value), OPERATION_ID)).toThrow();
	});

	it("round-trips exact cancel_requested control and rejects malformed variants", () => {
		const control = { status: "cancel_requested", requestedAt: 123, drainedSteer: [], drainedFollowUp: [] } as const;
		const value = { ...common(phases.ready), control };
		expect(decodeState(value)).toEqual({ seq: 17, value });
		for (const malformed of [
			{ ...control, requestedAt: -1 },
			{ ...control, requestedAt: 1.5 },
			{ ...control, requestedAt: Number.MAX_SAFE_INTEGER + 1 },
			{ ...control, drainedSteer: [TRIGGER_ID] },
			{ ...control, drainedFollowUp: [TRIGGER_ID] },
			{ ...control, extra: true },
		])
			expectCorruption(() => decodeState({ ...common(phases.ready), control: malformed }));
	});

	it.each([
		["empty", {}],
		["nested JSON-safe", { nested: [null, true, { n: 1 }] }],
	] as const)("accepts %s stream metadata", (_label, metadata) => {
		const generationContext = { ...context(), streamOptions: { ...context().streamOptions, metadata } };
		const state = common({
			kind: "assistant",
			generation: { status: "ready", context: generationContext, nextAttempt: 1 },
		});
		expect(decodeState(state).value).toEqual(state);
	});

	it.each([
		["missing field", () => ({ ...common(phases.ready), inbox: undefined })],
		["unknown field", () => ({ ...common(phases.ready), extra: true })],
		["wrong primitive", () => ({ ...common(phases.ready), control: { status: 1 } })],
		["custom prototype", () => Object.assign(Object.create({}), common(phases.ready))],
		["accessor", () => Object.defineProperty(common(phases.ready), "kind", { enumerable: true, get: () => "run" })],
		["symbol property", () => ({ ...common(phases.ready), [Symbol("extra")]: true })],
		["hidden property", () => Object.defineProperty(common(phases.ready), "extra", { value: true })],
	])("rejects exact-structure violation: %s", (_label, make) => expectCorruption(() => decodeState(make())));

	it.each([
		["array metadata", () => []],
		["null metadata", () => null],
		["string metadata", () => "metadata"],
		["number metadata", () => 1],
		["boolean metadata", () => true],
		["custom-prototype metadata", () => Object.create({ inherited: true })],
		["accessor metadata", () => Object.defineProperty({}, "value", { enumerable: true, get: () => "x" })],
		["hidden metadata", () => Object.defineProperty({}, "hidden", { value: true })],
		["symbol-keyed metadata", () => ({ [Symbol("metadata")]: true })],
		["nested undefined metadata", () => ({ nested: { bad: undefined } })],
	])("rejects malformed stream metadata: %s", (_label, makeMetadata) => {
		const generationContext = {
			...context(),
			streamOptions: { ...context().streamOptions, metadata: makeMetadata() },
		};
		expectCorruption(() =>
			decodeState(
				common({ kind: "assistant", generation: { status: "ready", context: generationContext, nextAttempt: 1 } }),
			),
		);
	});

	it.each([
		["malformed headers", () => ({ ...context(), streamOptions: { headers: { x: 1 } } })],
		[
			"accessor headers",
			() => ({
				...context(),
				streamOptions: { headers: Object.defineProperty({}, "x", { enumerable: true, get: () => "y" }) },
			}),
		],
		["unsafe stream number", () => ({ ...context(), streamOptions: { timeoutMs: Number.MAX_SAFE_INTEGER + 1 } })],
		["invalid UUIDv7", () => ({ ...context(), stepId: "not-an-id" })],
	])("rejects malformed generation context: %s", (_label, makeContext) => {
		expectCorruption(() =>
			decodeState(
				common({ kind: "assistant", generation: { status: "ready", context: makeContext(), nextAttempt: 1 } }),
			),
		);
	});

	it("rejects malformed resume data, unsafe operation numbers, and duplicate prompt IDs", () => {
		const operation = {
			operationId: OPERATION_ID,
			lane: "main",
			sourceLeafId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [TRIGGER_ID], resumeData: { nested: [true] } },
		};
		expect(decodeRunOperationRegister(register("op.meta", OPERATION_ID, operation, 23), OPERATION_ID)).toEqual({
			seq: 23,
			value: operation,
		});
		for (const invalid of [
			{ ...operation, startedAt: Number.MAX_SAFE_INTEGER + 1 },
			{ ...operation, operationId: "bad" },
			{ ...operation, intent: { ...operation.intent, promptEntryIds: [TRIGGER_ID, TRIGGER_ID] } },
			{ ...operation, intent: { ...operation.intent, resumeData: { bad: undefined } } },
		])
			expectCorruption(() => decodeRunOperationRegister(register("op.meta", OPERATION_ID, invalid), OPERATION_ID));
	});

	it("enforces all Phase 1 reachability restrictions", () => {
		const invalidStates = [
			common(phases.needAssistant, TRIGGER_ID),
			common({ ...phases.needAssistant, thresholdCheckedTriggerEntryId: TRIGGER_ID }),
			common({ ...phases.needAssistant, skipInboxOnce: false }),
			common({ ...phases.needAssistant, continuation: { kind: "need_assistant", overflowRecoveryUsed: true } }),
			common(
				{ ...phases.mayFinish, continuation: { kind: "may_finish", includeFinalAssistant: false } },
				TRIGGER_ID,
			),
			common({
				...phases.ready,
				generation: { ...phases.ready.generation, context: { ...context(), overflowRecoveryUsed: true } },
			}),
			common({ kind: "tool", state: "ready" }),
			{ ...common(phases.ready), control: { status: "paused" } },
			{ ...common(phases.ready), inbox: { steer: [TRIGGER_ID], followUp: [], writes: [] } },
		];
		for (const candidate of invalidStates) expectCorruption(() => decodeState(candidate));
		expectCorruption(() =>
			decodeLaneStateRegister(
				register("lane.state", "main", { currentOperationId: null, pendingNextRun: [OPERATION_ID] }),
			),
		);
		for (const deferred of [true, { window: "15m" }]) {
			const changed = { ...context(), streamOptions: { ...context().streamOptions, deferred } };
			expectCorruption(() =>
				decodeState(
					common({ kind: "assistant", generation: { status: "ready", context: changed, nextAttempt: 1 } }),
				),
			);
		}
	});

	it("enforces cross-field identities before entry hydration", () => {
		const invalid = [
			common(phases.mayFinish, id()),
			common(phases.ready, TRIGGER_ID),
			common(phases.effectPending, TRIGGER_ID),
			common({ ...phases.effectPending, generation: { ...phases.effectPending.generation, usageId: RESPONSE_ID } }),
			common({
				...phases.effectPending,
				generation: { ...phases.effectPending.generation, responseEntryId: OPERATION_ID },
			}),
			common({ ...phases.effectPending, generation: { ...phases.effectPending.generation, usageId: STEP_ID } }),
		];
		for (const candidate of invalid) expectCorruption(() => decodeState(candidate));
	});
});
