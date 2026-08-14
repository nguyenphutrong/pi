import type { AssistantMessage } from "@earendil-works/pi-ai";
import { InMemoryTelemetryContext, type TelemetryContext, type TelemetrySpan } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { type HarnessEvent, type RunEndEvent, RuntimeEventRegistry } from "../src/events.ts";
import { ZERO_USAGE } from "./fixtures.ts";

const flush = async (): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function registry(telemetryContext: TelemetryContext = new InMemoryTelemetryContext()) {
	return new RuntimeEventRegistry(() => {}, telemetryContext);
}

const runStart = (runId = "run"): HarnessEvent => ({ type: "run_start", lane: "main", runId });

const assistant = (
	stopReason: AssistantMessage["stopReason"],
	content: AssistantMessage["content"] = [],
): AssistantMessage => ({
	role: "assistant",
	content,
	api: "harness",
	provider: "test",
	model: "test",
	usage: ZERO_USAGE,
	stopReason,
	timestamp: 1,
});

const runEndShapes = [
	{ type: "run_end", lane: "main", runId: "completed-empty", leafId: null, outcome: "completed" },
	{
		type: "run_end",
		lane: "main",
		runId: "completed-paired",
		leafId: "leaf",
		outcome: "completed",
		finalEntryId: "assistant",
		finalMessage: assistant("stop"),
	},
	{ type: "run_end", lane: "main", runId: "aborted-empty", leafId: "leaf", outcome: "aborted" },
	{
		type: "run_end",
		lane: "main",
		runId: "aborted-paired",
		leafId: "leaf",
		outcome: "aborted",
		finalEntryId: "assistant",
		finalMessage: assistant("aborted"),
	},
	{
		type: "run_end",
		lane: "main",
		runId: "failed-empty",
		leafId: "leaf",
		outcome: "failed",
		error: { code: "failed", message: "failure" },
	},
	{
		type: "run_end",
		lane: "main",
		runId: "failed-paired-details-recovery",
		leafId: "leaf",
		outcome: "failed",
		error: { code: "failed", message: "failure", details: { nested: { value: "original" } } },
		finalEntryId: "assistant",
		finalMessage: assistant("error", [{ type: "text", text: "original" }]),
		recovery: true,
	},
] satisfies RunEndEvent[];

describe("D-058 runtime event registry", () => {
	it("accepts every public run_end outcome shape and deeply detaches and freezes nested payloads", () => {
		const events = registry();
		const seen: RunEndEvent[] = [];
		events.on("run_end", (event) => {
			seen.push(event);
		});
		for (const shape of runEndShapes) events.publish(shape);
		expect(seen).toHaveLength(runEndShapes.length);
		for (const event of seen) {
			expect(Object.isFrozen(event)).toBe(true);
			expect("finalEntryId" in event).toBe("finalMessage" in event);
		}
		const source = runEndShapes.at(-1)!;
		const published = seen.at(-1)!;
		expect(published).toEqual(source);
		expect(published).not.toBe(source);
		if (published.outcome !== "failed" || source.outcome !== "failed") throw new Error("failed shape missing");
		expect(Object.isFrozen(published.error)).toBe(true);
		expect(Object.isFrozen(published.error.details)).toBe(true);
		expect(published.error.details).not.toBe(source.error.details);
		(source.error.details as { nested: { value: string } }).nested.value = "mutated";
		expect(published.error.details).toEqual({ nested: { value: "original" } });
		if (published.finalMessage === undefined || source.finalMessage === undefined)
			throw new Error("paired shape missing");
		expect(Object.isFrozen(published.finalMessage)).toBe(true);
		expect(Object.isFrozen(published.finalMessage.content)).toBe(true);
		expect(published.finalMessage).not.toBe(source.finalMessage);
	});

	it.each(["throw", "reject"] as const)(
		"keeps run_end listener %s nonblocking, starts the next listener, and reports once",
		async (kind) => {
			const events = registry();
			const errors: HarnessEvent[] = [];
			const later = vi.fn();
			events.on("handler_error", (event) => {
				errors.push(event);
			});
			events.on("run_end", () => {
				if (kind === "throw") throw new Error("run_end failed");
				return Promise.reject(new Error("run_end failed"));
			});
			events.on("run_end", later);
			events.publish(runEndShapes[0]);
			expect(later).toHaveBeenCalledTimes(1);
			await flush();
			expect(errors).toEqual([
				{
					type: "handler_error",
					kind: "event",
					event: "run_end",
					lane: "main",
					error: "run_end failed",
					stack: expect.any(String),
				},
			]);
		},
	);
	it("validates synchronously and makes duplicate registrations and unsubscribe independent", async () => {
		const events = registry();
		expect(() => events.on("future" as never, () => undefined)).toThrow(TypeError);
		expect(() => events.on("run_start", 1 as never)).toThrow(TypeError);
		const listener = vi.fn();
		const first = events.on("run_start", listener);
		const second = events.on("run_start", listener);
		first();
		first();
		events.publish(runStart());
		await flush();
		expect(listener).toHaveBeenCalledTimes(1);
		second();
		events.publish(runStart("later"));
		await flush();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("snapshots active listeners FIFO and starts all callbacks without awaiting prior completion", async () => {
		const events = registry();
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let offSecond!: () => void;
		events.on("run_start", async () => {
			order.push("first:start");
			offSecond();
			events.on("run_start", () => {
				order.push("late");
			});
			await gate;
			order.push("first:end");
		});
		offSecond = events.on("run_start", () => {
			order.push("second");
		});
		events.publish(runStart("one"));
		expect(order).toEqual(["first:start", "second"]);
		events.publish(runStart("two"));
		expect(order).toEqual(["first:start", "second", "first:start", "late"]);
		release();
		await flush();
		expect(order).toEqual(["first:start", "second", "first:start", "late", "first:end", "first:end"]);
	});

	it("does not queue or replay publications", async () => {
		const events = registry();
		events.publish(runStart("missed"));
		const seen: string[] = [];
		events.on("run_start", (event) => {
			seen.push(event.runId);
		});
		events.publish(runStart("first"));
		events.publish(runStart("second"));
		expect(seen).toEqual(["first", "second"]);
	});

	it("deeply detaches and freezes one payload shared by sibling listeners", () => {
		const events = registry();
		const source = { type: "run_start", lane: "main", runId: "original", nested: { safe: "source" } };
		const seen: unknown[] = [];
		events.on("run_start", (event) => {
			seen.push(event);
			expect(Object.isFrozen(event)).toBe(true);
			expect(Object.isFrozen((event as unknown as { nested: object }).nested)).toBe(true);
			expect(() => {
				(event as unknown as { nested: { safe: string } }).nested.safe = "listener";
			}).toThrow();
		});
		events.on("run_start", (event) => {
			seen.push(event);
		});
		events.publish(source as never);
		source.runId = "mutated";
		source.nested.safe = "mutated";
		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(seen[1]);
		expect(seen[0]).toMatchObject({ runId: "original", nested: { safe: "source" } });
		expect(seen[0]).not.toBe(source);
	});

	it.each(["throw", "reject"] as const)("isolates a listener %s and emits one exact handler_error", async (kind) => {
		const events = registry();
		const errors: HarnessEvent[] = [];
		const later = vi.fn();
		events.on("handler_error", (event) => {
			errors.push(event);
		});
		events.on("run_start", () => {
			if (kind === "throw") throw new Error("broken listener");
			return Promise.reject(new Error("broken listener"));
		});
		events.on("run_start", later);
		events.publish(runStart());
		expect(later).toHaveBeenCalledTimes(1);
		await flush();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toEqual({
			type: "handler_error",
			kind: "event",
			event: "run_start",
			lane: "main",
			error: "broken listener",
			stack: expect.any(String),
		});
	});

	it("bounds handler_error recursion and safely normalizes hostile thrown values", async () => {
		const events = registry();
		const reported = vi.fn();
		events.on("handler_error", reported);
		events.on("handler_error", () => Promise.reject(new Error("must not recurse")));
		const hostile = new Proxy(
			{},
			{
				get: () => {
					throw new Error("hostile");
				},
			},
		);
		events.on("run_start", () => {
			throw hostile;
		});
		events.publish(runStart());
		await flush();
		expect(reported).toHaveBeenCalledTimes(1);
		expect(reported.mock.calls[0][0]).toEqual({
			type: "handler_error",
			kind: "event",
			event: "run_start",
			lane: "main",
			error: "Event listener failed",
		});
	});

	it("records one content-free canonical span per listener with automatic status", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const events = registry(telemetry);
		events.on("run_start", () => undefined);
		events.on("run_start", () => Promise.reject(new Error("secret event content")));
		events.publish(runStart("secret run id"));
		await flush();
		expect(telemetry.getSpans()).toMatchObject([
			{
				name: "pi.harness.event_handler",
				attributes: { "pi.event.type": "run_start", "pi.lane.name": "main" },
				status: { status: "ok" },
			},
			{
				name: "pi.harness.event_handler",
				attributes: { "pi.event.type": "run_start", "pi.lane.name": "main" },
				status: { status: "error" },
			},
		]);
		for (const span of telemetry.getSpans())
			expect(Object.keys(span.attributes).sort()).toEqual(["pi.event.type", "pi.lane.name"]);
		expect(JSON.stringify(telemetry.getSpans())).not.toContain("secret run id");
	});

	it.each(["throw", "reject", "omit", "delay-repeat"] as const)(
		"runs a listener once when telemetry adapters %s callbacks",
		async (behavior) => {
			let repeatCallback: (() => void) | undefined;
			const telemetry: TelemetryContext = {
				startSpan: <T>(_options: unknown, supplied: (span: TelemetrySpan) => T | Promise<T>): Promise<T> => {
					repeatCallback = () => {
						void Promise.resolve(supplied({} as TelemetrySpan)).catch(() => {});
					};
					if (behavior === "throw") throw new Error("telemetry");
					if (behavior === "reject") return Promise.reject(new Error("telemetry"));
					return new Promise<T>(() => {});
				},
			};
			const events = registry(telemetry);
			const listener = vi.fn();
			const errors = vi.fn();
			events.on("handler_error", errors);
			events.on("run_start", listener);
			events.publish(runStart());
			await flush();
			if (behavior === "delay-repeat" && repeatCallback) {
				repeatCallback();
				repeatCallback();
				await flush();
			}
			expect(listener).toHaveBeenCalledTimes(1);
			expect(errors).not.toHaveBeenCalled();
		},
	);

	it.each(["success", "failure"] as const)(
		"isolates telemetry rejection after repeated callback invocation from listener %s",
		async (outcome) => {
			const telemetry: TelemetryContext = {
				startSpan: async <T>(_options: unknown, supplied: (span: TelemetrySpan) => T | Promise<T>): Promise<T> => {
					void Promise.resolve(supplied({} as TelemetrySpan)).catch(() => {});
					void Promise.resolve(supplied({} as TelemetrySpan)).catch(() => {});
					throw new Error("adapter rejected independently");
				},
			};
			const events = registry(telemetry);
			const listener = vi.fn(() => {
				if (outcome === "failure") throw new Error("listener failed");
			});
			const errors = vi.fn();
			events.on("handler_error", errors);
			events.on("run_start", listener);
			events.publish(runStart());
			await flush();
			expect(listener).toHaveBeenCalledTimes(1);
			expect(errors).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
			if (outcome === "failure") {
				const payload = errors.mock.calls[0][0];
				expect(payload).toEqual({
					type: "handler_error",
					kind: "event",
					event: "run_start",
					lane: "main",
					error: "listener failed",
					stack: expect.any(String),
				});
				expect(Object.isFrozen(payload)).toBe(true);
			}
		},
	);
});
