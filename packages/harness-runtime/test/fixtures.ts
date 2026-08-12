import type { AssistantMessage, Message, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { createIdGenerator } from "@nguyenphutrong/pi-session-storage";

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function id(): string {
	return createIdGenerator().next();
}

export function user(text: string, timestamp = 1): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

export function assistant(stopReason: AssistantMessage["stopReason"] = "stop", timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: stopReason }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "model",
		usage: structuredClone(ZERO_USAGE),
		stopReason,
		timestamp,
	};
}

export function toolResult(timestamp = 1): ToolResultMessage<Record<string, string>> {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		details: { path: "file.txt" },
		isError: false,
		timestamp,
	};
}

export function asMessage(value: unknown): Message {
	return value as Message;
}
