import type { LaneConfiguration } from "./durable.ts";
import { MemorySession, type RuntimeAttachment } from "./session.ts";
import type { Session } from "./types.ts";
import { SessionError } from "./types.ts";

export function attachRuntime(session: Session, seed: LaneConfiguration): Promise<RuntimeAttachment> {
	if (!(session instanceof MemorySession))
		return Promise.reject(new SessionError("storage", "Session does not support an internal runtime attachment"));
	return session.attachRuntime(seed);
}
