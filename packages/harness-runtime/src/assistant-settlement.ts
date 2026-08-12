import type { AssistantMessage } from "@earendil-works/pi-ai";

export type AssistantSettlementClassification = "commit_success" | "unsupported" | "corruption";

export function classifyAssistantSettlement(
	message: AssistantMessage,
	intendedOutputLimit: number,
	control: "running" | "cancel_requested",
): AssistantSettlementClassification {
	const hasToolCall = message.content.some((content) => content.type === "toolCall");
	if (message.stopReason === "aborted") return control === "running" ? "corruption" : "unsupported";
	if (hasToolCall || message.stopReason === "toolUse" || message.deferred !== undefined) return "unsupported";
	if (message.stopReason === "stop") return "commit_success";
	if (message.stopReason === "length" && message.usage.output >= intendedOutputLimit) return "commit_success";
	return "unsupported";
}
