import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { classifyAssistantSettlement } from "../src/assistant-settlement.ts";
import { assistant } from "./fixtures.ts";

function withOutput(stopReason: AssistantMessage["stopReason"], output: number): AssistantMessage {
	const message = assistant(stopReason);
	return {
		...message,
		usage: { ...message.usage, output, totalTokens: output },
	};
}

describe("assistant settlement classifier", () => {
	const cases: Array<
		[
			string,
			AssistantMessage,
			number,
			"running" | "cancel_requested",
			"commit_success" | "commit_tools" | "unsupported" | "corruption",
		]
	> = [
		["stop without calls", assistant("stop"), 10, "running", "commit_success"],
		["length at intended limit", withOutput("length", 10), 10, "running", "commit_success"],
		["length above intended limit", withOutput("length", 11), 10, "running", "commit_success"],
		["length below intended limit", withOutput("length", 9), 10, "running", "unsupported"],
		[
			"length below intended limit with calls",
			{
				...withOutput("length", 9),
				content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
			},
			10,
			"running",
			"unsupported",
		],
		[
			"tool-call content",
			{ ...assistant("stop"), content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
			10,
			"running",
			"commit_tools",
		],
		[
			"toolUse with calls",
			{ ...assistant("toolUse"), content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
			10,
			"running",
			"commit_tools",
		],
		[
			"genuine length with calls",
			{
				...withOutput("length", 10),
				content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
			},
			10,
			"running",
			"commit_tools",
		],
		["toolUse stop reason", assistant("toolUse"), 10, "running", "unsupported"],
		["error", assistant("error"), 10, "running", "unsupported"],
		[
			"deferred handle",
			{
				...assistant("deferred"),
				deferred: { provider: "test", modelId: "model", api: "test", id: "job", data: {} },
			},
			10,
			"running",
			"unsupported",
		],
		["aborted while running", assistant("aborted"), 10, "running", "corruption"],
	];

	it.each(cases)("classifies %s", (_name, message, limit, control, expected) => {
		expect(classifyAssistantSettlement(message, limit, control)).toBe(expected);
	});
});
