import type { LaneConfiguration } from "./durable.ts";
import {
	type AcceptPromptResult,
	type AcceptPromptTransition,
	MemorySession,
	type RuntimeAttachment,
	type RuntimeTransitionResult,
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
