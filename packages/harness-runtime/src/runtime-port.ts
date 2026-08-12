import type { LaneConfiguration } from "./durable.ts";
import {
	type AcceptPromptResult,
	type AcceptPromptTransition,
	type FinishRunResult,
	type FinishRunTransition,
	MemorySession,
	type PrepareAssistantEffectResult,
	type PrepareAssistantEffectTransition,
	type RuntimeAttachment,
	type RuntimeTransitionResult,
	type SettleAssistantEffectResult,
	type SettleAssistantEffectTransition,
	type StartAssistantStepTransition,
} from "./session.ts";
import type { Session } from "./types.ts";
import { SessionError } from "./types.ts";

export function attachRuntime(session: Session, seed: LaneConfiguration): Promise<RuntimeAttachment> {
	if (!(session instanceof MemorySession))
		return Promise.reject(new SessionError("storage", "Session does not support an internal runtime attachment"));
	return session.attachRuntime(seed);
}

export function startAssistantStep(
	session: Session,
	transition: StartAssistantStepTransition,
): Promise<RuntimeTransitionResult> {
	if (!(session instanceof MemorySession))
		return Promise.reject(new SessionError("storage", "Session does not support internal runtime transitions"));
	return session.startAssistantStep(transition);
}

export function acceptPrompt(session: Session, transition: AcceptPromptTransition): Promise<AcceptPromptResult> {
	if (!(session instanceof MemorySession))
		return Promise.reject(new SessionError("storage", "Session does not support internal runtime transitions"));
	return session.acceptPrompt(transition);
}

export function prepareAssistantEffect(
	session: Session,
	transition: PrepareAssistantEffectTransition,
): Promise<PrepareAssistantEffectResult> {
	if (!(session instanceof MemorySession))
		return Promise.reject(new SessionError("storage", "Session does not support internal runtime transitions"));
	return session.prepareAssistantEffect(transition);
}

export function settleAssistantEffect(
	session: Session,
	transition: SettleAssistantEffectTransition,
): Promise<SettleAssistantEffectResult> {
	if (!(session instanceof MemorySession))
		return Promise.reject(new SessionError("storage", "Session does not support internal runtime transitions"));
	return session.settleAssistantEffect(transition);
}

export function finishRun(session: Session, transition: FinishRunTransition): Promise<FinishRunResult> {
	if (!(session instanceof MemorySession))
		return Promise.reject(new SessionError("storage", "Session does not support internal runtime transitions"));
	return session.finishRun(transition);
}
