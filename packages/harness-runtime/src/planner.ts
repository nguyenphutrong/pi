import type { RuntimeAttachment } from "./session.ts";

export type ActionInfo =
	| { kind: "start_assistant_step"; operationId: string; triggerEntryId: string }
	| { kind: "prepare_assistant_effect"; operationId: string; stepId: string; nextAttempt: number }
	| { kind: "dispatch_assistant_effect"; operationId: string; effectKey: string }
	| { kind: "await_assistant_effect"; operationId: string; effectKey: string }
	| { kind: "settle_assistant_effect"; operationId: string; effectKey: string }
	| { kind: "recover_assistant_effect"; operationId: string; stepId: string; attempt: number }
	| { kind: "wait_assistant_retry"; operationId: string; stepId: string; nextAttempt: number; notBefore: number }
	| { kind: "release_assistant_retry"; operationId: string; stepId: string; nextAttempt: number; notBefore: number }
	| { kind: "repair_materialized_assistant"; operationId: string; responseEntryId: string; usageId: string }
	| {
			kind: "prepare_tool_call";
			operationId: string;
			assistantEntryId: string;
			sourceIndex: number;
			resultEntryId: string;
	  }
	| { kind: "finish_run"; operationId: string; triggerEntryId: string }
	| { kind: "finish_failed_run"; operationId: string; responseEntryId: string };

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
		readonly retryElapsed?: (operationId: string, stepId: string, nextAttempt: number, notBefore: number) => boolean;
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
	if (phase.kind === "failure_drain") {
		info = {
			kind: "finish_failed_run",
			operationId: operation.value.operationId,
			responseEntryId: phase.provenance.entryId,
		};
	} else if (phase.kind === "checkpoint") {
		info =
			phase.continuation.kind === "need_assistant"
				? {
						kind: "start_assistant_step",
						operationId: operation.value.operationId,
						triggerEntryId: phase.triggerEntryId,
					}
				: { kind: "finish_run", operationId: operation.value.operationId, triggerEntryId: phase.triggerEntryId };
	} else if (phase.kind === "tools") {
		const call = phase.batch.calls.find((candidate) => candidate.status !== "completed");
		if (!call) return undefined;
		if (call.status !== "planned") return undefined;
		info = {
			kind: "prepare_tool_call",
			operationId: operation.value.operationId,
			assistantEntryId: phase.batch.assistantEntryId,
			sourceIndex: call.sourceIndex,
			resultEntryId: call.resultEntryId,
		};
	} else if (phase.generation.status === "ready") {
		info = {
			kind: "prepare_assistant_effect",
			operationId: operation.value.operationId,
			stepId: phase.generation.context.stepId,
			nextAttempt: phase.generation.nextAttempt,
		};
	} else if (phase.generation.status === "retry_wait") {
		const generation = phase.generation;
		info =
			inputs.retryElapsed?.(
				operation.value.operationId,
				generation.context.stepId,
				generation.nextAttempt,
				generation.notBefore,
			) === true
				? {
						kind: "release_assistant_retry",
						operationId: operation.value.operationId,
						stepId: generation.context.stepId,
						nextAttempt: generation.nextAttempt,
						notBefore: generation.notBefore,
					}
				: {
						kind: "wait_assistant_retry",
						operationId: operation.value.operationId,
						stepId: generation.context.stepId,
						nextAttempt: generation.nextAttempt,
						notBefore: generation.notBefore,
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
