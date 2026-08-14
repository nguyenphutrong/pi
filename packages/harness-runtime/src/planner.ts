import { selectQueueDrain } from "./durable.ts";
import type { RuntimeAttachment } from "./session.ts";

export type ActionInfo =
	| { kind: "consume_queue"; operationId: string; queue: "steer" | "followUp"; entryIds: readonly string[] }
	| { kind: "apply_deferred_writes"; operationId: string; entryIds: readonly string[] }
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
	| { kind: "dispatch_tool_effect"; operationId: string; effectKey: string }
	| { kind: "await_tool_effect"; operationId: string; effectKey: string }
	| { kind: "finalize_tool_effect"; operationId: string; effectKey: string }
	| { kind: "settle_tool_effect"; operationId: string; effectKey: string }
	| {
			kind: "cancel_planned_tool";
			operationId: string;
			assistantEntryId: string;
			turnId: string;
			sourceIndex: number;
			resultEntryId: string;
	  }
	| { kind: "cancel_tool_effect"; operationId: string; effectKey: string }
	| {
			kind: "recover_tool_effect";
			operationId: string;
			assistantEntryId: string;
			turnId: string;
			sourceIndex: number;
			resultEntryId: string;
	  }
	| { kind: "finish_run"; operationId: string; triggerEntryId: string }
	| { kind: "finish_failed_run"; operationId: string; responseEntryId: string }
	| { kind: "finish_aborted_run"; operationId: string };

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

export function toolEffectKey(operationId: string, turnId: string, sourceIndex: number): string {
	return `tool:${operationId}:${turnId}:${sourceIndex}`;
}

export function planAction(
	attachment: RuntimeAttachment,
	inputs: {
		readonly settingsRevision: number;
		readonly assistantEffectStatus: (key: string) => "planned" | "running" | "settled" | undefined;
		readonly toolEffectStatus?: (
			key: string,
		) => "planned" | "running" | "raw" | "finalizing" | "finalized" | undefined;
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
	const deferredWrites = (): PlannedAction => {
		const entryIds = Object.freeze([...state.value.inbox.writes]);
		return Object.freeze({
			info: Object.freeze({ kind: "apply_deferred_writes", operationId: operation.value.operationId, entryIds }),
			expected,
		});
	};
	if (state.value.control.status === "cancel_requested") {
		if (phase.kind === "tools") {
			const call = phase.batch.calls.find((candidate) => candidate.status !== "completed");
			if (call) {
				if (call.status === "planned")
					info = {
						kind: "cancel_planned_tool",
						operationId: operation.value.operationId,
						assistantEntryId: phase.batch.assistantEntryId,
						turnId: phase.batch.turnId,
						sourceIndex: call.sourceIndex,
						resultEntryId: call.resultEntryId,
					};
				else {
					const key = toolEffectKey(operation.value.operationId, phase.batch.turnId, call.sourceIndex);
					const status = inputs.toolEffectStatus?.(key);
					if (status === "planned")
						info = { kind: "cancel_tool_effect", operationId: operation.value.operationId, effectKey: key };
					else if (status === "running" || status === "finalizing")
						info = { kind: "await_tool_effect", operationId: operation.value.operationId, effectKey: key };
					else if (status === "raw")
						info = { kind: "finalize_tool_effect", operationId: operation.value.operationId, effectKey: key };
					else if (status === "finalized")
						info = { kind: "settle_tool_effect", operationId: operation.value.operationId, effectKey: key };
					else
						info = {
							kind: "recover_tool_effect",
							operationId: operation.value.operationId,
							assistantEntryId: phase.batch.assistantEntryId,
							turnId: phase.batch.turnId,
							sourceIndex: call.sourceIndex,
							resultEntryId: call.resultEntryId,
						};
				}
				return Object.freeze({ info: Object.freeze(info), expected });
			}
		} else if (phase.kind === "assistant" && phase.generation.status === "effect_pending") {
			const generation = phase.generation;
			const key = assistantEffectKey(operation.value.operationId, generation.context.stepId, generation.attempt);
			const status = inputs.assistantEffectStatus(key);
			if (attachment.entries.has(generation.responseEntryId) && attachment.usageRows.has(generation.usageId))
				info = {
					kind: "repair_materialized_assistant",
					operationId: operation.value.operationId,
					responseEntryId: generation.responseEntryId,
					usageId: generation.usageId,
				};
			else if (status === "running")
				info = { kind: "await_assistant_effect", operationId: operation.value.operationId, effectKey: key };
			else if (status === "settled")
				info = { kind: "settle_assistant_effect", operationId: operation.value.operationId, effectKey: key };
			else
				info = {
					kind: "recover_assistant_effect",
					operationId: operation.value.operationId,
					stepId: generation.context.stepId,
					attempt: generation.attempt,
				};
			return Object.freeze({ info: Object.freeze(info), expected });
		}
		const eligibleForWrites =
			phase.kind === "checkpoint" ||
			phase.kind === "failure_drain" ||
			(phase.kind === "assistant" &&
				(phase.generation.status === "ready" || phase.generation.status === "retry_wait")) ||
			(phase.kind === "tools" && phase.batch.calls.every((call) => call.status === "completed"));
		if (eligibleForWrites && state.value.inbox.writes.length > 0) return deferredWrites();
		info = { kind: "finish_aborted_run", operationId: operation.value.operationId };
		return Object.freeze({ info: Object.freeze(info), expected });
	}
	if (phase.kind === "failure_drain") {
		if (state.value.inbox.writes.length > 0) return deferredWrites();
		const drain = selectQueueDrain(state.value);
		if (drain) {
			info = {
				kind: "consume_queue",
				operationId: operation.value.operationId,
				queue: drain.kind,
				entryIds: drain.entryIds,
			};
			return Object.freeze({ info: Object.freeze(info), expected });
		}
		info = {
			kind: "finish_failed_run",
			operationId: operation.value.operationId,
			responseEntryId: phase.provenance.entryId,
		};
	} else if (phase.kind === "checkpoint") {
		if (phase.skipInboxOnce !== true && state.value.inbox.writes.length > 0) return deferredWrites();
		const drain = selectQueueDrain(state.value);
		if (drain) {
			info = {
				kind: "consume_queue",
				operationId: operation.value.operationId,
				queue: drain.kind,
				entryIds: drain.entryIds,
			};
			return Object.freeze({ info: Object.freeze(info), expected });
		}
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
		if (call.status === "planned")
			info = {
				kind: "prepare_tool_call",
				operationId: operation.value.operationId,
				assistantEntryId: phase.batch.assistantEntryId,
				sourceIndex: call.sourceIndex,
				resultEntryId: call.resultEntryId,
			};
		else {
			const key = toolEffectKey(operation.value.operationId, phase.batch.turnId, call.sourceIndex);
			const status = inputs.toolEffectStatus?.(key);
			if (status === "planned")
				info = { kind: "dispatch_tool_effect", operationId: operation.value.operationId, effectKey: key };
			else if (status === "running")
				info = { kind: "await_tool_effect", operationId: operation.value.operationId, effectKey: key };
			else if (status === "raw")
				info = { kind: "finalize_tool_effect", operationId: operation.value.operationId, effectKey: key };
			else if (status === "finalized")
				info = { kind: "settle_tool_effect", operationId: operation.value.operationId, effectKey: key };
			else
				info = {
					kind: "recover_tool_effect",
					operationId: operation.value.operationId,
					assistantEntryId: phase.batch.assistantEntryId,
					turnId: phase.batch.turnId,
					sourceIndex: call.sourceIndex,
					resultEntryId: call.resultEntryId,
				};
		}
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
