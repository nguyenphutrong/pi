import { InMemoryTelemetryContext, type TelemetryContext, type TelemetrySpan } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { type HarnessEvent, RuntimeEventRegistry } from "../src/events.ts";

const flush = async (): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function registry(telemetryContext: TelemetryContext = new InMemoryTelemetryContext()) {
	return new RuntimeEventRegistry(() => {}, telemetryContext);
}

const runStart = (runId = "run"): HarnessEvent => ({ type: "run_start", lane: "main", runId });

describe("D-058 runtime event registry", () => {
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
