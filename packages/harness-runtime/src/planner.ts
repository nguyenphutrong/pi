import type { RuntimeAttachment } from "./session.ts";

export type ActionInfo =
	| { kind: "start_assistant_step"; operationId: string; triggerEntryId: string }
	| { kind: "prepare_assistant_effect"; operationId: string; stepId: string; nextAttempt: number }
	| { kind: "dispatch_assistant_effect"; operationId: string; effectKey: string }
	| { kind: "await_assistant_effect"; operationId: string; effectKey: string }
	| { kind: "settle_assistant_effect"; operationId: string; effectKey: string }
	| { kind: "recover_assistant_effect"; operationId: string; stepId: string; attempt: number }
	| { kind: "repair_materialized_assistant"; operationId: string; responseEntryId: string; usageId: string }
	| { kind: "finish_run"; operationId: string; triggerEntryId: string };

export interface PlannedAction {
	readonly info: ActionInfo;
	readonly expected: {
		readonly operationStateSeq: number;
		readonly laneStateSeq: number;
		readonly configurationSeq: number;
		readonly settingsRevision: number;
	};
}

export function assistantEffectKey(operationId: string, stepId: string, attempt: number): string {
	return `assistant:${operationId}:${stepId}:${attempt}`;
}

export function planAction(
	attachment: RuntimeAttachment,
	inputs: {
		readonly settingsRevision: number;
		readonly assistantEffectStatus: (key: string) => "planned" | "running" | "settled" | undefined;
	},
): PlannedAction | undefined {
	const operation = attachment.runOperation;
	const state = attachment.runState;
	if (!operation || !state) return undefined;
	const expected = Object.freeze({
		operationStateSeq: state.seq,
		laneStateSeq: attachment.laneState.seq,
		configurationSeq: attachment.laneConfiguration.seq,
		settingsRevision: inputs.settingsRevision,
	});
	const phase = state.value.phase;
	let info: ActionInfo;
	if (phase.kind === "checkpoint") {
		info =
			phase.continuation.kind === "need_assistant"
				? {
						kind: "start_assistant_step",
						operationId: operation.value.operationId,
						triggerEntryId: phase.triggerEntryId,
					}
				: { kind: "finish_run", operationId: operation.value.operationId, triggerEntryId: phase.triggerEntryId };
	} else if (phase.generation.status === "ready") {
		info = {
			kind: "prepare_assistant_effect",
			operationId: operation.value.operationId,
			stepId: phase.generation.context.stepId,
			nextAttempt: phase.generation.nextAttempt,
		};
	} else {
		const generation = phase.generation;
		const key = assistantEffectKey(operation.value.operationId, generation.context.stepId, generation.attempt);
		if (attachment.entries.has(generation.responseEntryId) && attachment.usageRows.has(generation.usageId)) {
			info = {
				kind: "repair_materialized_assistant",
				operationId: operation.value.operationId,
				responseEntryId: generation.responseEntryId,
				usageId: generation.usageId,
			};
		} else {
			const localStatus = inputs.assistantEffectStatus(key);
			if (localStatus === "planned")
				info = { kind: "dispatch_assistant_effect", operationId: operation.value.operationId, effectKey: key };
			else if (localStatus === "running")
				info = { kind: "await_assistant_effect", operationId: operation.value.operationId, effectKey: key };
			else if (localStatus === "settled")
				info = { kind: "settle_assistant_effect", operationId: operation.value.operationId, effectKey: key };
			else
				info = {
					kind: "recover_assistant_effect",
					operationId: operation.value.operationId,
					stepId: generation.context.stepId,
					attempt: generation.attempt,
				};
		}
	}
	return Object.freeze({ info: Object.freeze(info), expected });
}
