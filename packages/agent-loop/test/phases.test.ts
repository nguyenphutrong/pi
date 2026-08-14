import { Type, type Usage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	type AfterToolCallResult,
	type AgentTool,
	type AgentToolCall,
	type AgentToolResult,
	createErrorToolResult,
	createToolResultMessage,
	executeToolCall,
	finalizeToolCall,
	normalizeAfterToolCallResult,
	normalizeBeforeToolCallResult,
	type PreparedToolCall,
	prepareToolCall,
} from "../src/index.ts";

const schema = Type.Object({ value: Type.String() }, { additionalProperties: false });
const call: AgentToolCall = { type: "toolCall", id: "call-1", name: "echo", arguments: { value: "raw" } };
const usage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};
const rawResult: AgentToolResult = {
	content: [{ type: "text", text: "raw" }],
	details: { nested: { old: true } },
	usage,
	addedToolNames: ["new-tool"],
	terminate: true,
};

function tool(overrides: Partial<AgentTool<typeof schema>> = {}): AgentTool<typeof schema> {
	return {
		name: "echo",
		label: "Echo",
		description: "echo",
		parameters: schema,
		execute: async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: null }),
		...overrides,
	};
}

function prepared(overrides: Partial<PreparedToolCall> = {}): PreparedToolCall {
	return {
		kind: "prepared",
		toolCall: call,
		tool: tool(),
		args: { value: "effective" },
		replay: "never",
		...overrides,
	};
}

function text(outcome: PreparedToolCall | { result: AgentToolResult }): string | undefined {
	if (!("result" in outcome)) return undefined;
	const first = outcome.result.content[0];
	return first?.type === "text" ? first.text : undefined;
}

const afterPatchCases: [keyof AgentToolResult, AfterToolCallResult, unknown][] = [
	["content", { content: [{ type: "text", text: "patched" }] }, [{ type: "text", text: "patched" }]],
	["details", { details: { replacement: true } }, { replacement: true }],
	["usage", { usage: { ...usage, input: 9 } }, { ...usage, input: 9 }],
	["terminate", { terminate: false }, false],
];

describe("prepareToolCall", () => {
	it("aborts before lookup or callbacks", async () => {
		const controller = new AbortController();
		controller.abort();
		const prepareArguments = vi.fn();
		const before = vi.fn();
		const execute = vi.fn();
		const outcome = await prepareToolCall(call, [tool({ prepareArguments, execute })], before, controller.signal);
		expect(outcome).toMatchObject({ kind: "immediate", isError: true, terminate: false });
		expect(text(outcome)).toBe("Operation aborted");
		expect(prepareArguments).not.toHaveBeenCalled();
		expect(before).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("reports missing tools with the compatibility text", async () => {
		const outcome = await prepareToolCall(call, []);
		expect(text(outcome)).toBe("Tool echo not found");
	});

	it("returns validated arguments detached from the raw provider arguments and defaults replay to never", async () => {
		const outcome = await prepareToolCall(call, [tool()]);
		expect(outcome).toMatchObject({ kind: "prepared", args: call.arguments, replay: "never" });
		if (outcome.kind === "prepared") expect(outcome.args).not.toBe(call.arguments);
	});

	it("uses replacement prepared arguments and retains safe replay", async () => {
		const outcome = await prepareToolCall(call, [
			tool({ prepareArguments: () => ({ value: "prepared" }), replay: "safe" }),
		]);
		expect(outcome).toMatchObject({ kind: "prepared", args: { value: "prepared" }, replay: "safe" });
	});

	it.each([
		[
			"throw",
			() => {
				throw new Error("prepare exploded");
			},
			"prepare exploded",
		],
		[
			"non-Error",
			() => {
				throw 17;
			},
			"17",
		],
	])("normalizes prepareArguments %s", async (_label, prepareArguments, message) => {
		const outcome = await prepareToolCall(call, [tool({ prepareArguments })]);
		expect(text(outcome)).toBe(message);
	});

	it("validates initial and replacement arguments", async () => {
		const initial = await prepareToolCall({ ...call, arguments: {} }, [tool()]);
		expect(initial.kind).toBe("immediate");
		const replacement = await prepareToolCall(call, [tool()], () => ({ args: {} }));
		expect(replacement.kind).toBe("immediate");
		expect(replacement.kind === "immediate" ? replacement.isError : false).toBe(true);
	});

	it("isolates callback mutation unless replacement args are returned", async () => {
		const untouched = await prepareToolCall(call, [tool()], (context) => {
			(context.args as { value: string }).value = "mutated";
			return undefined;
		});
		expect(untouched).toMatchObject({ kind: "prepared", args: { value: "raw" } });
		const replaced = await prepareToolCall(call, [tool()], () => ({ args: { value: "replacement" } }));
		expect(replaced).toMatchObject({ kind: "prepared", args: { value: "replacement" } });
	});

	it.each([
		[undefined, "prepared", undefined, false],
		[{}, "prepared", undefined, false],
		[{ args: { value: "changed" } }, "prepared", undefined, false],
		[{ block: { reason: "denied" } }, "immediate", "denied", false],
		[{ block: { reason: "stop", terminate: true } }, "immediate", "stop", true],
		[{ block: { reason: "continue", terminate: false } }, "immediate", "continue", false],
		[{ args: { value: "ignored" }, block: { reason: "blocked" } }, "immediate", "blocked", false],
	] as const)("accepts aggregate before output %#", async (output, kind, message, terminate) => {
		const outcome = await prepareToolCall(call, [tool()], () => output);
		expect(outcome.kind).toBe(kind);
		if (message) expect(text(outcome)).toBe(message);
		if (outcome.kind === "immediate") expect(outcome.terminate).toBe(terminate);
	});

	it.each([
		["primitive", 1],
		["unknown key", { nope: true }],
		["malformed block", { block: "no" }],
		["missing reason", { block: {} }],
		["non-string reason", { block: { reason: 1 } }],
		["invalid terminate", { block: { reason: "x", terminate: 1 } }],
	])("rejects %s with stable text", async (_label, output) => {
		const outcome = await prepareToolCall(call, [tool()], () => output as never);
		expect(text(outcome)).toBe("Invalid before tool callback output");
	});

	it.each([
		["alone", { args: undefined }],
		["before a valid block can settle", { args: undefined, block: { reason: "must not settle", terminate: true } }],
	] as const)("reports an invalid args field as replacement argument validation %s", async (_label, output) => {
		const outcome = await prepareToolCall(call, [tool()], () => output);
		expect(text(outcome)).toContain('Validation failed for tool "echo"');
		expect(text(outcome)).not.toBe("must not settle");
		if (outcome.kind === "immediate") expect(outcome.terminate).toBe(false);
	});

	it.each([
		["function", { value: () => {} }],
		["symbol", { value: Symbol("replacement") }],
	])("preserves the exact validation outcome for non-cloneable replacement args: %s", async (_label, args) => {
		const withoutBlock = await prepareToolCall(call, [tool()], () => ({ args }));
		const withBlock = await prepareToolCall(call, [tool()], () => ({
			args,
			block: { reason: "must not replace validation", terminate: true },
		}));
		expect(withBlock).toEqual(withoutBlock);
		expect(text(withoutBlock)).toContain("could not be cloned");
		expect(text(withoutBlock)).not.toBe("Invalid before tool callback output");
	});

	it("leaves cyclic replacement behavior owned by argument validation", async () => {
		const args: { value: unknown; self?: unknown } = { value: 1 };
		args.self = args;
		const withoutBlock = await prepareToolCall(call, [tool()], () => ({ args }));
		const withBlock = await prepareToolCall(call, [tool()], () => ({ args, block: { reason: "blocked" } }));
		expect(withBlock).toEqual(withoutBlock);
		expect(withoutBlock.kind).toBe("immediate");
		expect(text(withoutBlock)).not.toBe("Invalid before tool callback output");
	});

	it.each([
		["custom prototype", Object.assign(Object.create({ inherited: true }), { value: 1 })],
		["accessor", Object.defineProperty({}, "value", { enumerable: true, get: () => 1 })],
	])("leaves %s replacement behavior owned by argument validation", async (_label, args) => {
		const withoutBlock = await prepareToolCall(call, [tool()], () => ({ args }));
		const withBlock = await prepareToolCall(call, [tool()], () => ({ args, block: { reason: "blocked" } }));
		expect(withoutBlock).toMatchObject({ kind: "prepared", args: { value: "1" } });
		expect(text(withBlock)).toBe("blocked");
	});

	it.each([
		[
			"throw",
			() => {
				throw new Error("before exploded");
			},
			"before exploded",
		],
		["reject", async () => Promise.reject(new Error("before rejected")), "before rejected"],
		[
			"non-Error",
			() => {
				throw { code: 9 };
			},
			"[object Object]",
		],
	])("normalizes callback %s", async (_label, before, expected) => {
		const outcome = await prepareToolCall(call, [tool()], before);
		expect(text(outcome)).toBe(expected);
	});

	it("lets abort win when it occurs during the callback", async () => {
		const controller = new AbortController();
		const outcome = await prepareToolCall(
			call,
			[tool()],
			() => {
				controller.abort();
				return { args: { value: "valid" } };
			},
			controller.signal,
		);
		expect(text(outcome)).toBe("Operation aborted");
	});
});

describe("executeToolCall", () => {
	it("returns a valid cloned tool result", async () => {
		const source = structuredClone(rawResult);
		const outcome = await executeToolCall(prepared({ tool: tool({ execute: async () => source }) }));
		expect(outcome).toEqual({ result: rawResult, isError: false });
		expect(outcome.result).not.toBe(source);
	});

	it.each([
		[
			"throw",
			() => {
				throw new Error("tool exploded");
			},
			"tool exploded",
		],
		["reject", async () => Promise.reject(new Error("tool rejected")), "tool rejected"],
		[
			"non-Error",
			() => {
				throw 23;
			},
			"23",
		],
	])("normalizes tool %s", async (_label, execute, expected) => {
		const outcome = await executeToolCall(prepared({ tool: tool({ execute }) }));
		expect(outcome.isError).toBe(true);
		expect(text(outcome)).toBe(expected);
		expect(outcome.result.usage).toBeUndefined();
	});

	it.each([
		["primitive", 1, false],
		["unknown field", { ...rawResult, unknown: true }, true],
		["content", { ...rawResult, content: [{ type: "text", text: 1 }] }, true],
		["details", { ...rawResult, details: undefined }, true],
		["usage", { ...rawResult, usage: { ...usage, input: Number.NaN } }, false],
		["explicit undefined usage", { ...rawResult, usage: undefined }, false],
		["terminate", { ...rawResult, terminate: "yes" }, true],
		["addedToolNames", { ...rawResult, addedToolNames: [1] }, true],
	] as const)("normalizes invalid raw result %s", async (_label, value, preservesUsage) => {
		const outcome = await executeToolCall(prepared({ tool: tool({ execute: async () => value as never }) }));
		expect(outcome).toEqual({
			result: { ...createErrorToolResult("Invalid tool result"), ...(preservesUsage ? { usage } : {}) },
			isError: true,
		});
	});

	it("preserves a clone of independently valid usage when an invalid raw result becomes synthetic", async () => {
		const sourceUsage = structuredClone(usage);
		const outcome = await executeToolCall(
			prepared({
				tool: tool({ execute: async () => ({ ...rawResult, content: "bad", usage: sourceUsage }) as never }),
			}),
		);
		expect(outcome.result.usage).toEqual(usage);
		expect(outcome.result.usage).not.toBe(sourceUsage);
	});

	it.each(["safe", "never"] as const)("retains the %s replay declaration on preparation", async (replay) => {
		const outcome = await prepareToolCall(call, [tool({ replay })]);
		expect(outcome).toMatchObject({ kind: "prepared", replay });
	});

	it("delivers valid updates in order and drains sink promises", async () => {
		const seen: string[] = [];
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execute = async (
			_id: string,
			_args: { value: string },
			_signal?: AbortSignal,
			onUpdate?: (value: AgentToolResult) => void,
		) => {
			onUpdate?.({ content: [{ type: "text", text: "one" }], details: null });
			onUpdate?.({ content: [{ type: "text", text: "two" }], details: null });
			return rawResult;
		};
		let settled = false;
		const promise = executeToolCall(prepared({ tool: tool({ execute }) }), undefined, async ({ partialResult }) => {
			seen.push(text({ result: partialResult }) ?? "");
			await gate;
		}).then((value) => {
			settled = true;
			return value;
		});
		await Promise.resolve();
		expect(seen).toEqual(["one", "two"]);
		expect(settled).toBe(false);
		release?.();
		await promise;
		expect(settled).toBe(true);
	});

	it("ignores invalid and late transient updates", async () => {
		const sink = vi.fn();
		let update: ((value: AgentToolResult) => void) | undefined;
		const execute = async (
			_id: string,
			_args: { value: string },
			_signal?: AbortSignal,
			onUpdate?: (value: AgentToolResult) => void,
		) => {
			update = onUpdate;
			onUpdate?.({ content: [] } as never);
			return rawResult;
		};
		const outcome = await executeToolCall(prepared({ tool: tool({ execute }) }), undefined, sink);
		update?.({ content: [{ type: "text", text: "late" }], details: null });
		expect(sink).not.toHaveBeenCalled();
		expect(outcome.result).toEqual(rawResult);
	});

	it("rejects with the first internal sink failure while observing every queued rejection", async () => {
		const execute = async (
			_id: string,
			_args: { value: string },
			_signal?: AbortSignal,
			onUpdate?: (value: AgentToolResult) => void,
		) => {
			onUpdate?.({ content: [], details: 1 });
			onUpdate?.({ content: [], details: 2 });
			return rawResult;
		};
		const sink = vi.fn().mockRejectedValueOnce(new Error("sink one")).mockRejectedValueOnce(new Error("sink two"));
		await expect(executeToolCall(prepared({ tool: tool({ execute }) }), undefined, sink)).rejects.toThrow("sink one");
		expect(sink).toHaveBeenCalledTimes(2);
	});
});

describe("finalizeToolCall", () => {
	it("preserves a valid raw result without a callback", async () => {
		const outcome = await finalizeToolCall(prepared(), { result: rawResult, isError: false });
		expect(outcome).toEqual({ toolCall: call, result: rawResult, isError: false, terminate: true });
	});

	it.each(afterPatchCases)("independently replaces %s", async (field, patch, expected) => {
		const outcome = await finalizeToolCall(prepared(), { result: rawResult, isError: false }, () => patch);
		expect(outcome.result[field]).toEqual(expected);
		if (field !== "details") expect(outcome.result.details).toEqual(rawResult.details);
		expect(outcome.result.addedToolNames).toEqual(rawResult.addedToolNames);
	});

	it("independently replaces isError", async () => {
		const outcome = await finalizeToolCall(prepared(), { result: rawResult, isError: false }, () => ({
			isError: true,
		}));
		expect(outcome.isError).toBe(true);
		expect(outcome.result).toEqual(rawResult);
	});

	it("clones callback inputs and ignores mutation without a patch", async () => {
		const p = prepared();
		const outcome = await finalizeToolCall(p, { result: rawResult, isError: false }, (context) => {
			(context.args as { value: string }).value = "changed";
			context.toolCall.name = "changed";
			context.result.content = [];
			return undefined;
		});
		expect(outcome.result).toEqual(rawResult);
		expect(p.args).toEqual({ value: "effective" });
		expect(p.toolCall.name).toBe("echo");
	});

	it.each([
		[
			"throw",
			() => {
				throw new Error("after exploded");
			},
			"after exploded",
		],
		["reject", async () => Promise.reject(new Error("after rejected")), "after rejected"],
		[
			"non-Error",
			() => {
				throw 31;
			},
			"31",
		],
		["primitive", () => 1, "Invalid after tool callback output"],
		["unknown", () => ({ unknown: true }), "Invalid after tool callback output"],
		["content", () => ({ content: "bad" }), "Invalid after tool callback output"],
		["details", () => ({ details: undefined }), "Invalid after tool callback output"],
		["isError", () => ({ isError: 1 }), "Invalid after tool callback output"],
		["usage", () => ({ usage: undefined }), "Invalid after tool callback output"],
		["terminate", () => ({ terminate: "yes" }), "Invalid after tool callback output"],
	])("replaces the raw result for invalid after %s", async (_label, after, message) => {
		const outcome = await finalizeToolCall(prepared(), { result: rawResult, isError: false }, after as never);
		expect(outcome).toEqual({
			toolCall: call,
			result: createErrorToolResult(message),
			isError: true,
			terminate: false,
		});
		expect(outcome.result.usage).toBeUndefined();
	});

	it("normalizes an invalid raw result before callback and never exposes it", async () => {
		let seen: AgentToolResult | undefined;
		const outcome = await finalizeToolCall(
			prepared(),
			{ result: { content: "bad", details: 1 } as never, isError: false },
			(context) => {
				seen = context.result;
				return undefined;
			},
		);
		expect(seen).toEqual(createErrorToolResult("Invalid tool result"));
		expect(outcome).toMatchObject({
			result: createErrorToolResult("Invalid tool result"),
			isError: true,
			terminate: false,
		});
	});

	it("passes the abort signal through without arbitrating it", async () => {
		const controller = new AbortController();
		controller.abort();
		const after = vi.fn(() => ({ content: [{ type: "text" as const, text: "ran" }] }));
		const outcome = await finalizeToolCall(
			prepared(),
			{ result: rawResult, isError: false },
			after,
			controller.signal,
		);
		expect(after).toHaveBeenCalledWith(expect.any(Object), controller.signal);
		expect(text(outcome)).toBe("ran");
	});
});

describe("normalization helpers", () => {
	it("distinguishes valid undefined callback outputs from invalid outputs", () => {
		expect(normalizeBeforeToolCallResult(undefined)).toEqual({ kind: "valid", value: undefined });
		expect(normalizeAfterToolCallResult(undefined)).toEqual({ kind: "valid", value: undefined });
		expect(normalizeBeforeToolCallResult(null)).toEqual({ kind: "invalid" });
		expect(normalizeAfterToolCallResult(null)).toEqual({ kind: "invalid" });
	});

	it("detaches the before envelope and block while leaving args opaque for schema validation", () => {
		const source = { args: { value: "replacement" }, block: { reason: "", terminate: false } };
		const normalized = normalizeBeforeToolCallResult(source);
		expect(normalized).toEqual({ kind: "valid", value: source });
		if (normalized.kind === "valid" && normalized.value) {
			expect(normalized.value).not.toBe(source);
			expect(normalized.value.args).toBe(source.args);
			expect(normalized.value.block).not.toBe(source.block);
		}
	});

	it("normalizes and detaches all after fields while preserving falsy values", () => {
		const source = {
			content: [{ type: "text" as const, text: "" }],
			details: { nested: false },
			isError: false,
			usage,
			terminate: false,
		};
		const normalized = normalizeAfterToolCallResult(source);
		expect(normalized).toEqual({ kind: "valid", value: source });
		if (normalized.kind === "valid" && normalized.value) {
			expect(normalized.value).not.toBe(source);
			expect(normalized.value.content).not.toBe(source.content);
			expect(normalized.value.details).not.toBe(source.details);
			expect(normalized.value.usage).not.toBe(source.usage);
		}
	});

	it.each([
		["primitive", 1],
		["unknown field", { unknown: true }],
		["custom prototype", Object.create({ inherited: true })],
		["accessor", Object.defineProperty({}, "args", { enumerable: true, get: () => ({ value: "x" }) })],
		["symbol", { [Symbol("field")]: true }],
		["block accessor", { block: Object.defineProperty({}, "reason", { enumerable: true, get: () => "x" }) }],
	])("rejects invalid before callback shape: %s", (_label, value) => {
		expect(normalizeBeforeToolCallResult(value)).toEqual({ kind: "invalid" });
	});

	it.each([
		["primitive", 1],
		["unknown field", { unknown: true }],
		["custom prototype", Object.create({ inherited: true })],
		["accessor", Object.defineProperty({}, "terminate", { enumerable: true, get: () => false })],
		["symbol", { [Symbol("field")]: true }],
		["invalid falsy field", { usage: undefined }],
	])("rejects invalid after callback shape: %s", (_label, value) => {
		expect(normalizeAfterToolCallResult(value)).toEqual({ kind: "invalid" });
	});

	it("creates the exact synthetic error shape", () => {
		expect(createErrorToolResult("failure")).toEqual({ content: [{ type: "text", text: "failure" }], details: {} });
	});

	it("creates the exact tool result message and omits empty optional names and terminate", () => {
		const result = { ...rawResult, addedToolNames: [] };
		const message = createToolResultMessage({ toolCall: call, result, isError: false, terminate: true }, 1234);
		expect(message).toEqual({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "echo",
			content: rawResult.content,
			details: rawResult.details,
			usage,
			isError: false,
			timestamp: 1234,
		});
		expect(message).not.toHaveProperty("terminate");
		expect(message).not.toHaveProperty("addedToolNames");
	});

	it("includes non-empty added names", () => {
		const message = createToolResultMessage(
			{ toolCall: call, result: rawResult, isError: true, terminate: true },
			99,
		);
		expect(message.addedToolNames).toEqual(["new-tool"]);
	});

	it("normalizes an invalid finalized result while preserving independently valid usage", () => {
		const sourceUsage = structuredClone(usage);
		const message = createToolResultMessage(
			{
				toolCall: call,
				result: { ...rawResult, content: "bad", usage: sourceUsage } as never,
				isError: false,
				terminate: true,
			},
			99,
		);
		expect(message).toMatchObject({
			content: [{ type: "text", text: "Invalid tool result" }],
			details: {},
			usage,
			isError: true,
		});
		expect(message.usage).not.toBe(sourceUsage);
	});

	it.each([
		[
			"sparse content",
			(() => {
				const value: AgentToolResult["content"] = Array(1);
				return value;
			})(),
		],
		[
			"symbol content property",
			(() => {
				const value: AgentToolResult["content"] = [];
				value[Symbol("x") as never] = 1 as never;
				return value;
			})(),
		],
		[
			"accessor content property",
			Object.defineProperty([], "0", { enumerable: true, get: () => ({ type: "text", text: "x" }) }),
		],
		["extra content property", Object.assign([], { extra: true })],
		["undefined textSignature", [{ type: "text", text: "x", textSignature: undefined }]],
	])("rejects non-durable content: %s", async (_label, content) => {
		const outcome = await executeToolCall(
			prepared({ tool: tool({ execute: async () => ({ content, details: null }) as never }) }),
		);
		expect(outcome).toEqual({ result: createErrorToolResult("Invalid tool result"), isError: true });
	});

	it.each([
		["cacheWrite1h", { ...usage, cacheWrite1h: undefined }],
		["reasoning", { ...usage, reasoning: undefined }],
	])("rejects usage with explicitly undefined %s", async (_label, invalidUsage) => {
		const outcome = await executeToolCall(
			prepared({
				tool: tool({ execute: async () => ({ content: [], details: null, usage: invalidUsage }) as never }),
			}),
		);
		expect(outcome).toEqual({ result: createErrorToolResult("Invalid tool result"), isError: true });
	});

	it.each([
		[
			"sparse",
			(() => {
				const value: string[] = Array(1);
				return value;
			})(),
		],
		[
			"symbol property",
			(() => {
				const value: string[] = [];
				value[Symbol("x") as never] = "x" as never;
				return value;
			})(),
		],
		["extra property", Object.assign([], { extra: true })],
	])("rejects non-durable addedToolNames arrays: %s", async (_label, addedToolNames) => {
		const outcome = await executeToolCall(
			prepared({ tool: tool({ execute: async () => ({ content: [], details: null, addedToolNames }) as never }) }),
		);
		expect(outcome).toEqual({ result: createErrorToolResult("Invalid tool result"), isError: true });
	});

	it.each([
		["undefined", undefined],
		["bigint", 1n],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		[
			"cyclic",
			(() => {
				const value: { self?: unknown } = {};
				value.self = value;
				return value;
			})(),
		],
		["accessor", Object.defineProperty({}, "x", { enumerable: true, get: () => 1 })],
		["symbol key", { [Symbol("x")]: 1 }],
		["sparse array", Array(1)],
		["date", new Date(0)],
	])("rejects JSON-invalid details: %s", async (_label, details) => {
		const outcome = await executeToolCall(
			prepared({ tool: tool({ execute: async () => ({ content: [], details }) }) }),
		);
		expect(outcome.isError).toBe(true);
		expect(text(outcome)).toBe("Invalid tool result");
	});

	it.each([null, [], [null, { valid: [1, true, "x"] }], {}, { nested: { valid: true } }])(
		"accepts JSON details %#",
		async (details) => {
			const outcome = await executeToolCall(
				prepared({ tool: tool({ execute: async () => ({ content: [], details }) }) }),
			);
			expect(outcome).toEqual({ result: { content: [], details }, isError: false });
		},
	);

	it.each(["usage", "addedToolNames", "terminate"] as const)(
		"rejects explicitly undefined optional field %s",
		async (field) => {
			const outcome = await executeToolCall(
				prepared({ tool: tool({ execute: async () => ({ content: [], details: null, [field]: undefined }) }) }),
			);
			expect(outcome.isError).toBe(true);
			expect(text(outcome)).toBe("Invalid tool result");
		},
	);
});
