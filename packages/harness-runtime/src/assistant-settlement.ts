import type { AssistantMessage } from "@earendil-works/pi-ai";

export type AssistantSettlementClassification = "commit_success" | "commit_tools" | "unsupported" | "corruption";

export function classifyAssistantSettlement(
	message: AssistantMessage,
	intendedOutputLimit: number,
	control: "running" | "cancel_requested",
): AssistantSettlementClassification {
	const hasToolCall = message.content.some((content) => content.type === "toolCall");
	if (control === "cancel_requested") return "commit_success";
	if (message.stopReason === "aborted") return "corruption";
	if (message.stopReason === "error" || message.deferred !== undefined) return "unsupported";
	if (message.stopReason === "length" && message.usage.output < intendedOutputLimit) return "unsupported";
	if (hasToolCall) return "commit_tools";
	if (message.stopReason === "toolUse") return "unsupported";
	if (message.stopReason === "stop" || message.stopReason === "length") return "commit_success";
	return "unsupported";
}
