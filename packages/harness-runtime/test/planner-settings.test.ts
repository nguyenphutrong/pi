import type { RetryPolicy } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { RunState, StreamOptions } from "../src/durable.ts";
import { assistantEffectKey, planAction, toolEffectKey } from "../src/planner.ts";
import { RuntimeSettingsOwner } from "../src/runtime-settings.ts";
import type { RuntimeAttachment } from "../src/session.ts";
import { id } from "./fixtures.ts";

function attachment(
	position: "idle" | "need" | "ready" | "pending" | "wait" | "failure" | "finish",
	materialized = false,
) {
	const operationId = id();
	const triggerEntryId = id();
	const stepId = id();
	const responseEntryId = id();
	const usageId = id();
	const context = {
		stepId,
		triggerEntryId,
		configuration: {
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "low" as const,
			activeToolNames: [],
		},
		streamOptions: {},
		retryPolicy: { maxAttempts: 1, baseDelayMs: 1000 },
		overflowRecoveryUsed: false,
	};
	const phase: RunState["phase"] =
		position === "failure"
			? {
					kind: "failure_drain",
					error: { code: "provider_interrupted", message: "Provider outcome unknown after interruption" },
					provenance: { kind: "response", entryId: triggerEntryId },
				}
			: position === "wait"
				? {
						kind: "assistant",
						generation: {
							status: "retry_wait",
							context: { ...context, retryPolicy: { maxAttempts: 3, baseDelayMs: 1000 } },
							nextAttempt: 2,
							notBefore: 5000,
							errorMessage: "Provider outcome unknown after interruption",
						},
					}
				: position === "ready"
					? { kind: "assistant", generation: { status: "ready", context, nextAttempt: 1 } }
					: position === "pending"
						? {
								kind: "assistant",
								generation: {
									status: "effect_pending",
									context,
									attempt: 1,
									responseEntryId,
									usageId,
									intendedOutputLimit: 10,
									contextWindow: 100,
								},
							}
						: {
								kind: "checkpoint",
								continuation:
									position === "finish"
										? { kind: "may_finish", includeFinalAssistant: true }
										: { kind: "need_assistant", overflowRecoveryUsed: false },
								triggerEntryId,
							};
	const value: RuntimeAttachment = {
		laneConfiguration: { seq: 11, value: context.configuration },
		laneState: {
			seq: 12,
			value: { currentOperationId: position === "idle" ? null : operationId, pendingNextRun: [] },
		},
		mainLeaf: { seq: 13, value: position === "idle" ? null : triggerEntryId },
		...(position === "idle"
			? {}
			: {
					runOperation: {
						seq: 14,
						value: {
							operationId,
							lane: "main",
							sourceLeafId: null,
							startedAt: 1,
							intent: { kind: "run", promptEntryIds: [triggerEntryId] },
						},
					},
					runState: {
						seq: 15,
						value: {
							kind: "run",
							control: { status: "running" },
							settings: {
								compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
								steeringMode: "all",
								followUpMode: "all",
								toolExecution: "sequential",
							},
							phase,
							inbox: { steer: [], followUp: [], writes: [] },
							latestAssistantEntryId: position === "finish" || position === "failure" ? triggerEntryId : null,
						},
					},
				}),
		entries: new Map(
			materialized ? [[responseEntryId, { marker: true }]] : [],
		) as unknown as RuntimeAttachment["entries"],
		usageRows: new Map(
			materialized ? [[usageId, { marker: true }]] : [],
		) as unknown as RuntimeAttachment["usageRows"],
		toolArguments: new Map(),
	};
	return { value, operationId, triggerEntryId, stepId, responseEntryId, usageId };
}

describe("pure Phase 1 action planner", () => {
	it("covers every durable position and hides correctness tokens from ActionInfo", () => {
		expect(
			planAction(attachment("idle").value, { settingsRevision: 0, assistantEffectStatus: () => undefined }),
		).toBeUndefined();
		for (const [position, kind] of [
			["need", "start_assistant_step"],
			["ready", "prepare_assistant_effect"],
			["finish", "finish_run"],
		] as const) {
			const fixture = attachment(position);
			const plan = planAction(fixture.value, { settingsRevision: 7, assistantEffectStatus: () => undefined })!;
			expect(plan.info.kind).toBe(kind);
			expect(Reflect.ownKeys(plan.info)).not.toContain("expectedOperationStateSeq");
			expect(plan.expected).toEqual({
				operationStateSeq: 15,
				laneStateSeq: 12,
				configurationSeq: 11,
				settingsRevision: 7,
			});
		}
	});

	it.each(["planned", "running", "settled", undefined] as const)(
		"prioritizes matching materialized reservations over local status %s",
		(status) => {
			const fixture = attachment("pending", true);
			const key = assistantEffectKey(fixture.operationId, fixture.stepId, 1);
			expect(
				planAction(fixture.value, {
					settingsRevision: 0,
					assistantEffectStatus: (candidate) => (candidate === key ? status : undefined),
				})?.info,
			).toEqual({
				kind: "repair_materialized_assistant",
				operationId: fixture.operationId,
				responseEntryId: fixture.responseEntryId,
				usageId: fixture.usageId,
			});
		},
	);

	it.each([
		["planned", "dispatch_assistant_effect"],
		["running", "await_assistant_effect"],
		["settled", "settle_assistant_effect"],
		[undefined, "recover_assistant_effect"],
	] as const)("maps exact local status %s to %s", (status, kind) => {
		const fixture = attachment("pending");
		const key = assistantEffectKey(fixture.operationId, fixture.stepId, 1);
		expect(
			planAction(fixture.value, {
				settingsRevision: 0,
				assistantEffectStatus: (candidate) => (candidate === key ? status : undefined),
			})?.info.kind,
		).toBe(kind);
	});

	it("repairs a materialized pending assistant before cancelled local recovery", () => {
		const fixture = attachment("pending", true);
		fixture.value.runState!.value.control = {
			status: "cancel_requested",
			requestedAt: 1,
			drainedSteer: [],
			drainedFollowUp: [],
		};
		const key = assistantEffectKey(fixture.operationId, fixture.stepId, 1);
		for (const status of ["planned", "running", "settled", undefined] as const)
			expect(
				planAction(fixture.value, {
					settingsRevision: 0,
					assistantEffectStatus: (candidate) => (candidate === key ? status : undefined),
				})?.info,
			).toEqual({
				kind: "repair_materialized_assistant",
				operationId: fixture.operationId,
				responseEntryId: fixture.responseEntryId,
				usageId: fixture.usageId,
			});
	});

	it.each(["ready", "wait", "need", "finish"] as const)(
		"finishes cancelled %s state without starting work",
		(position) => {
			const fixture = attachment(position);
			fixture.value.runState!.value.control = {
				status: "cancel_requested",
				requestedAt: 1,
				drainedSteer: [],
				drainedFollowUp: [],
			};
			expect(
				planAction(fixture.value, { settingsRevision: 0, assistantEffectStatus: () => "running" })?.info,
			).toEqual({ kind: "finish_aborted_run", operationId: fixture.operationId });
		},
	);

	it("uses only the exact deterministic effect key", () => {
		const fixture = attachment("pending");
		const key = assistantEffectKey(fixture.operationId, fixture.stepId, 1);
		for (const keys of [new Set<string>(), new Set([`${key}:bad`]), new Set(["malformed"])])
			expect(
				planAction(fixture.value, {
					settingsRevision: 0,
					assistantEffectStatus: (candidate) => (keys.has(candidate) ? "running" : undefined),
				})?.info.kind,
			).toBe("recover_assistant_effect");
	});

	it.each([
		["planned", "dispatch_tool_effect"],
		["running", "await_tool_effect"],
		["raw", "finalize_tool_effect"],
		["finalized", "settle_tool_effect"],
	] as const)("maps pending tool local status %s to %s", (status, kind) => {
		const fixture = attachment("need");
		const turnId = id();
		const assistantEntryId = id();
		const resultEntryId = id();
		fixture.value.runState!.value.phase = {
			kind: "tools",
			batch: {
				assistantEntryId,
				turnId,
				configuration: fixture.value.laneConfiguration.value,
				calls: [{ status: "effect_pending", sourceIndex: 0, resultEntryId, replay: "safe" }],
			},
		};
		const key = toolEffectKey(fixture.operationId, turnId, 0);
		expect(
			planAction(fixture.value, {
				settingsRevision: 4,
				assistantEffectStatus: () => undefined,
				toolEffectStatus: (candidate) => (candidate === key ? status : undefined),
			})?.info,
		).toEqual({ kind, operationId: fixture.operationId, effectKey: key });
	});

	it("recovers a restored pending tool with every stable identity field", () => {
		const fixture = attachment("need");
		const assistantEntryId = id();
		const turnId = id();
		const resultEntryId = id();
		fixture.value.runState!.value.phase = {
			kind: "tools",
			batch: {
				assistantEntryId,
				turnId,
				configuration: fixture.value.laneConfiguration.value,
				calls: [{ status: "effect_pending", sourceIndex: 0, resultEntryId, replay: "never" }],
			},
		};
		expect(planAction(fixture.value, { settingsRevision: 0, assistantEffectStatus: () => undefined })?.info).toEqual({
			kind: "recover_tool_effect",
			operationId: fixture.operationId,
			assistantEntryId,
			turnId,
			sourceIndex: 0,
			resultEntryId,
		});
	});

	it("keeps retry waits stable without exact elapsed proof and releases only on an exact proof", () => {
		const fixture = attachment("wait");
		const expectedWait = {
			kind: "wait_assistant_retry",
			operationId: fixture.operationId,
			stepId: fixture.stepId,
			nextAttempt: 2,
			notBefore: 5000,
		};
		for (const retryElapsed of [undefined, () => false])
			expect(
				planAction(fixture.value, { settingsRevision: 0, assistantEffectStatus: () => undefined, retryElapsed })
					?.info,
			).toEqual(expectedWait);
		const exact = vi.fn(
			(operationId, stepId, nextAttempt, notBefore) =>
				operationId === fixture.operationId && stepId === fixture.stepId && nextAttempt === 2 && notBefore === 5000,
		);
		expect(
			planAction(fixture.value, { settingsRevision: 0, assistantEffectStatus: () => undefined, retryElapsed: exact })
				?.info,
		).toEqual({ ...expectedWait, kind: "release_assistant_retry" });
		expect(exact).toHaveBeenCalledWith(fixture.operationId, fixture.stepId, 2, 5000);
	});

	it("plans failed finish directly from failure_drain", () => {
		const fixture = attachment("failure");
		expect(planAction(fixture.value, { settingsRevision: 0, assistantEffectStatus: () => undefined })?.info).toEqual({
			kind: "finish_failed_run",
			operationId: fixture.operationId,
			responseEntryId: fixture.triggerEntryId,
		});
	});

	it("is repeatable and does not mutate attachments, maps, or the input set", () => {
		const fixture = attachment("pending");
		const keys = new Set(["unrelated"]);
		const before = structuredClone({ attachment: fixture.value, keys: [...keys] });
		const first = planAction(fixture.value, {
			settingsRevision: 3,
			assistantEffectStatus: (candidate) => (keys.has(candidate) ? "running" : undefined),
		});
		const second = planAction(fixture.value, {
			settingsRevision: 3,
			assistantEffectStatus: (candidate) => (keys.has(candidate) ? "running" : undefined),
		});
		expect(second).toEqual(first);
		expect({ attachment: fixture.value, keys: [...keys] }).toEqual(before);
	});
});

function retry(value: unknown): RetryPolicy {
	return value as RetryPolicy;
}

function stream(value: unknown): StreamOptions {
	return value as StreamOptions;
}

function expectInvalidStreamOptions(cases: readonly unknown[]): void {
	for (const candidate of cases)
		expect(() => new RuntimeSettingsOwner(stream(candidate))).toThrowError(
			expect.objectContaining({ code: "invalid_query" }),
		);
}

describe("runtime settings", () => {
	it("provides detached canonical defaults and normalized policies", () => {
		const defaults = new RuntimeSettingsOwner().peek();
		expect(defaults).toEqual({ revision: 0, streamOptions: {}, retryPolicy: { maxAttempts: 1, baseDelayMs: 1000 } });
		expect(Number.isSafeInteger(defaults.revision)).toBe(true);
		expect(new RuntimeSettingsOwner({}, { enabled: true, maxRetries: 2, baseDelayMs: 9 }).peek().retryPolicy).toEqual(
			{ maxAttempts: 3, baseDelayMs: 9 },
		);
		expect(
			new RuntimeSettingsOwner({}, { enabled: false, maxRetries: 2, baseDelayMs: 9 }).peek().retryPolicy,
		).toEqual({ maxAttempts: 1, baseDelayMs: 9 });
	});

	it("rejects every non-exact or numerically invalid retry policy", () => {
		const accessor = Object.defineProperty({ enabled: true, baseDelayMs: 1 }, "maxRetries", {
			enumerable: true,
			get: () => 1,
		});
		const hidden = Object.defineProperty({ enabled: true, maxRetries: 1, baseDelayMs: 1 }, "extra", { value: true });
		const cases: unknown[] = [
			null,
			{},
			{ enabled: true, maxRetries: 1 },
			{ enabled: true, maxRetries: 1, baseDelayMs: 1, extra: true },
			{ enabled: true, maxRetries: 1, baseDelayMs: 1, [Symbol("x")]: true },
			accessor,
			hidden,
			Object.assign(Object.create({}), { enabled: true, maxRetries: 1, baseDelayMs: 1 }),
			{ enabled: 1, maxRetries: 1, baseDelayMs: 1 },
			{ enabled: true, maxRetries: -1, baseDelayMs: 1 },
			{ enabled: true, maxRetries: 1.5, baseDelayMs: 1 },
			{ enabled: true, maxRetries: Number.POSITIVE_INFINITY, baseDelayMs: 1 },
			{ enabled: true, maxRetries: 1, baseDelayMs: Number.MAX_SAFE_INTEGER + 1 },
			{ enabled: true, maxRetries: Number.MAX_SAFE_INTEGER, baseDelayMs: 1 },
			{ enabled: false, maxRetries: Number.MAX_SAFE_INTEGER, baseDelayMs: 1 },
		];
		for (const candidate of cases)
			expect(() => new RuntimeSettingsOwner({}, retry(candidate))).toThrowError(
				expect.objectContaining({ code: "invalid_query" }),
			);
	});

	it("rejects malformed stream options as invalid queries", () => {
		const accessor = Object.defineProperty({}, "transport", { enumerable: true, get: () => "sse" });
		const hidden = Object.defineProperty({}, "transport", { value: "sse" });
		const symbol = { [Symbol("transport")]: "sse" };
		const customPrototype = Object.assign(Object.create({ inherited: true }), { transport: "sse" });
		const malformedNumbers = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
		const numericCases = ["timeoutMs", "maxRetries", "maxRetryDelayMs"].flatMap((field) =>
			malformedNumbers.map((value) => ({ [field]: value })),
		);
		expectInvalidStreamOptions([
			null,
			true,
			"sse",
			[],
			{ unknown: true },
			accessor,
			hidden,
			symbol,
			customPrototype,
			{ transport: "http" },
			{ transport: null },
			{ cacheRetention: "forever" },
			{ cacheRetention: null },
			...numericCases,
			{ headers: null },
			{ headers: [] },
			{ headers: "authorization=x" },
			{ headers: { authorization: 1 } },
			{ headers: { authorization: true } },
			{ metadata: null },
			{ metadata: [] },
			{ metadata: "value" },
			{ metadata: Object.create({ inherited: true }) },
			{ metadata: Object.defineProperty({}, "value", { enumerable: true, get: () => 1 }) },
			{ metadata: Object.defineProperty({}, "value", { value: 1 }) },
			{ metadata: { [Symbol("value")]: 1 } },
			{ metadata: { nested: undefined } },
			{ metadata: { nested: { value: BigInt(1) } } },
			{ deferred: true },
			{ deferred: {} },
			{ deferred: { window: "15m" } },
		]);
	});

	it("detaches and canonically serializes stream options and serializes settings snapshots", async () => {
		const input = { transport: "sse" as const, headers: { authorization: "x" }, metadata: { nested: [1, true] } };
		const owner = new RuntimeSettingsOwner(input);
		input.headers.authorization = "changed";
		expect(owner.peek().streamOptions).toEqual({
			transport: "sse",
			headers: { authorization: "x" },
			metadata: { nested: [1, true] },
		});
		expect(JSON.parse(JSON.stringify(owner.peek()))).toEqual(owner.peek());
		const seen: number[] = [];
		await Promise.all([
			owner.withSnapshot(async (snapshot) => {
				seen.push(snapshot.revision);
				await Promise.resolve();
			}),
			owner.withSnapshot(async (snapshot) => {
				seen.push(snapshot.revision);
			}),
		]);
		expect(seen).toEqual([0, 0]);
	});

	it("accepts and detaches empty or nested metadata and deferred false", () => {
		const metadata = { nested: { values: [null, true, "value", 1] } };
		const owner = new RuntimeSettingsOwner({ metadata, deferred: false });
		metadata.nested.values[2] = "changed";
		expect(owner.peek().streamOptions).toEqual({
			metadata: { nested: { values: [null, true, "value", 1] } },
			deferred: false,
		});
		expect(new RuntimeSettingsOwner({ metadata: {} }).peek().streamOptions).toEqual({ metadata: {} });
	});
});
