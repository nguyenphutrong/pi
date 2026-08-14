import { Type } from "@earendil-works/pi-ai";
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { ToolHookRegistry } from "../src/hooks.ts";

const tool = {
	name: "echo",
	label: "Echo",
	description: "echo",
	parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: null }),
};

function registry(reporter: NonNullable<ConstructorParameters<typeof ToolHookRegistry>[2]> = () => {}) {
	const telemetry = new InMemoryTelemetryContext();
	return { hooks: new ToolHookRegistry(() => {}, telemetry, reporter), telemetry };
}

describe("D-057 tool hook registry", () => {
	it("validates registrations, captures a plain exact id once, and permits duplicate ids", async () => {
		const { hooks, telemetry } = registry();
		for (const [name, handler, options] of [
			["future", () => {}, {}],
			["before_tool", 1, {}],
			["before_tool", () => {}, null],
			["before_tool", () => {}, { extra: true }],
			["before_tool", () => {}, { id: 1 }],
			["before_tool", () => {}, Object.create({})],
			["before_tool", () => {}, Object.defineProperty({}, "id", { get: () => "accessor", enumerable: true })],
			["before_tool", () => {}, Object.defineProperty({}, "id", { value: "hidden" })],
		] as const)
			expect(() => hooks.on(name as never, handler as never, options as never)).toThrow(TypeError);
		const options = { id: "same" };
		expect(() => hooks.on("before_tool", () => undefined, options)).not.toThrow();
		options.id = "mutated";
		expect(() => hooks.on("before_tool", () => undefined, { id: "same" })).not.toThrow();
		await hooks.invokeBefore("run", "call", "echo", { value: "x" }, tool);
		expect(telemetry.getSpans().map((span) => span.attributes["pi.hook.registration_id"])).toEqual(["same", "same"]);
	});

	it("snapshots FIFO registrations and makes unsubscribe idempotent across invocation boundaries", async () => {
		const { hooks } = registry();
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const off = hooks.on("before_tool", async () => {
			order.push("first");
			await gate;
			return undefined;
		});
		hooks.on("before_tool", () => {
			order.push("second");
			return undefined;
		});
		const running = hooks.invokeBefore("run", "call", "echo", { value: "x" }, tool);
		await Promise.resolve();
		off();
		off();
		hooks.on("before_tool", () => {
			order.push("late");
			return undefined;
		});
		release();
		await running;
		expect(order).toEqual(["first", "second"]);
		await hooks.invokeBefore("run", "call", "echo", { value: "x" }, tool);
		expect(order).toEqual(["first", "second", "second", "late"]);
	});

	it("deeply detaches and freezes events while chaining schema-valid argument replacements", async () => {
		const { hooks } = registry();
		const source = { value: "one" };
		const seen: unknown[] = [];
		hooks.on("before_tool", (event) => {
			seen.push(event);
			expect(Object.isFrozen(event)).toBe(true);
			expect(Object.isFrozen(event.args)).toBe(true);
			return { args: { value: "two" } };
		});
		hooks.on("before_tool", (event) => {
			expect(event.args).toEqual({ value: "two" });
			return { block: { reason: "stop", terminate: true } };
		});
		const result = await hooks.invokeBefore("run", "call", "echo", source, tool);
		source.value = "changed";
		expect(seen[0]).toMatchObject({ args: { value: "one" } });
		expect(result).toEqual({ args: { value: "two" }, block: { reason: "stop", terminate: true } });
		expect(Object.isFrozen(result)).toBe(true);
	});

	it.each(["throw", "reject", "malformed", "schema"] as const)(
		"fails closed exactly once and stops later before handlers for %s",
		async (kind) => {
			const report = vi.fn();
			const { hooks } = registry(report as never);
			const later = vi.fn();
			hooks.on(
				"before_tool",
				kind === "throw"
					? () => {
							throw new Error("bad");
						}
					: kind === "reject"
						? () => Promise.reject(new Error("bad"))
						: kind === "malformed"
							? () => 1 as never
							: () => ({ args: {} as never }),
				{ id: "broken" },
			);
			hooks.on("before_tool", later);
			const result = await hooks.invokeBefore("run", "call", "echo", { value: "x" }, tool);
			expect(result?.block?.reason).toEqual(expect.any(String));
			expect(later).not.toHaveBeenCalled();
			expect(report).toHaveBeenCalledTimes(1);
			expect(report.mock.calls[0][0]).toMatchObject({
				kind: "hook",
				hook: "before_tool",
				lane: "main",
				runId: "run",
				registrationId: "broken",
				error: expect.any(String),
			});
			expect(Object.isFrozen(report.mock.calls[0][0])).toBe(true);
		},
	);

	it("chains after patches including falsy values and isolates invalid handlers", async () => {
		const report = vi.fn(() => Promise.reject(new Error("report failed")));
		const { hooks } = registry(report as never);
		hooks.on("after_tool", () => ({ details: null, isError: true, terminate: true }));
		hooks.on("after_tool", () => {
			throw new Error("isolated");
		});
		hooks.on("after_tool", (event) => {
			expect(event).toMatchObject({ details: null, isError: true });
			return { content: [], isError: false, terminate: false };
		});
		const result = await hooks.invokeAfter({
			lane: "main",
			runId: "run",
			toolCallId: "call",
			toolName: "echo",
			args: { value: "x" },
			content: [{ type: "text", text: "raw" }],
			isError: false,
		});
		expect(result).toEqual({ details: null, content: [], isError: false, terminate: false });
		expect(report).toHaveBeenCalledTimes(1);
	});

	it.each(["throw", "reject", "malformed"] as const)(
		"isolates after_tool %s and preserves the prior aggregate for a later handler",
		async (kind) => {
			const report = vi.fn();
			const { hooks } = registry(report);
			const later = vi.fn((event) => {
				expect(event.details).toEqual({ prior: true });
				return { content: [{ type: "text" as const, text: "continued" }] };
			});
			hooks.on("after_tool", () => ({ details: { prior: true }, isError: true }));
			hooks.on(
				"after_tool",
				kind === "throw"
					? () => {
							throw new Error("bad");
						}
					: kind === "reject"
						? () => Promise.reject(new Error("bad"))
						: () => 1 as never,
				{ id: "broken" },
			);
			hooks.on("after_tool", later);
			await expect(
				hooks.invokeAfter({
					lane: "main",
					runId: "run",
					toolCallId: "call",
					toolName: "echo",
					args: { value: "x" },
					content: [{ type: "text", text: "raw" }],
					isError: false,
				}),
			).resolves.toEqual({
				details: { prior: true },
				isError: true,
				content: [{ type: "text", text: "continued" }],
			});
			expect(later).toHaveBeenCalledTimes(1);
			expect(report).toHaveBeenCalledTimes(1);
			expect(report.mock.calls[0][0]).toMatchObject({ hook: "after_tool", registrationId: "broken" });
		},
	);

	it("isolates unreadable thrown values and synchronous reporter failure", async () => {
		const report = vi.fn((_metadata: unknown) => {
			throw new Error("report failed");
		});
		const { hooks } = registry(report as never);
		const unreadable = new Proxy(
			{},
			{
				get: () => {
					throw new Error("unreadable");
				},
			},
		);
		hooks.on("after_tool", () => {
			throw unreadable;
		});
		await expect(
			hooks.invokeAfter({
				lane: "main",
				runId: "run",
				toolCallId: "call",
				toolName: "echo",
				args: { value: "x" },
				content: [],
				isError: false,
			}),
		).resolves.toBeUndefined();
		expect(report).toHaveBeenCalledTimes(1);
		expect(report.mock.calls[0][0]).toMatchObject({ error: "Hook handler failed" });
	});

	it("emits one canonical span per handler with safe attributes, every outcome, and failed status", async () => {
		const { hooks, telemetry } = registry();
		hooks.on("before_tool", () => ({ args: { value: "changed" } }), { id: "complete" });
		hooks.on("before_tool", () => undefined, { id: "skip" });
		hooks.on("before_tool", () => ({ block: { reason: "no" } }), { id: "block" });
		await hooks.invokeBefore("run", "call", "echo", { value: "x" }, tool);
		hooks.on(
			"after_tool",
			() => {
				throw new Error("telemetry failure");
			},
			{ id: "fail" },
		);
		await hooks.invokeAfter({
			lane: "main",
			runId: "run",
			toolCallId: "call",
			toolName: "echo",
			args: { value: "x" },
			content: [],
			isError: false,
		});
		const spans = telemetry.getSpans();
		expect(spans).toHaveLength(4);
		expect(spans.map(({ name }) => name)).toEqual(Array(4).fill("pi.harness.hook"));
		expect(spans.map(({ attributes }) => attributes)).toEqual([
			{
				"pi.lane.name": "main",
				"pi.operation.id": "run",
				"pi.hook.name": "before_tool",
				"pi.hook.registration_id": "complete",
				"pi.hook.outcome": "completed",
			},
			{
				"pi.lane.name": "main",
				"pi.operation.id": "run",
				"pi.hook.name": "before_tool",
				"pi.hook.registration_id": "skip",
				"pi.hook.outcome": "skipped",
			},
			{
				"pi.lane.name": "main",
				"pi.operation.id": "run",
				"pi.hook.name": "before_tool",
				"pi.hook.registration_id": "block",
				"pi.hook.outcome": "blocked",
			},
			{
				"pi.lane.name": "main",
				"pi.operation.id": "run",
				"pi.hook.name": "after_tool",
				"pi.hook.registration_id": "fail",
				"pi.hook.outcome": "failed",
			},
		]);
		expect(spans.map(({ status }) => status)).toEqual([
			{ status: "ok" },
			{ status: "ok" },
			{ status: "ok" },
			{ status: "error", error: { name: "Error", message: "telemetry failure" } },
		]);
	});
});
