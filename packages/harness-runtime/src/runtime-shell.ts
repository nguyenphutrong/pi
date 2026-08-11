import type {
	Context,
	Message,
	ModelRequestLease,
	Models,
	ModelsSimpleStreamOptions,
	RetryPolicy,
} from "@earendil-works/pi-ai";
import { encodeMessage } from "./codec.ts";
import type { LaneConfiguration, StreamOptions } from "./durable.ts";
import { type ActionInfo, assistantEffectKey, type PlannedAction, planAction } from "./planner.ts";
import { acceptPrompt, attachRuntime, prepareAssistantEffect, startAssistantStep } from "./runtime-port.ts";
import { RuntimeSettingsOwner } from "./runtime-settings.ts";
import type { RuntimeAttachment } from "./session.ts";
import type { Session } from "./types.ts";

export type RuntimeShellErrorCode = "unavailable" | "busy" | "stale" | "closed";

export class RuntimeShellError extends Error {
	readonly code: RuntimeShellErrorCode;

	constructor(code: RuntimeShellErrorCode, message: string) {
		super(message);
		this.name = "RuntimeShellError";
		this.code = code;
	}
}

export interface RuntimeShellOptions {
	readonly streamOptions?: StreamOptions;
	readonly retryPolicy?: RetryPolicy;
	readonly models?: Models;
}

interface AssistantEffectPlan {
	readonly key: string;
	readonly lease: ModelRequestLease;
	readonly context: Context;
	readonly options: ModelsSimpleStreamOptions;
	readonly operationId: string;
	readonly stepId: string;
	readonly attempt: number;
	readonly responseEntryId: string;
	readonly usageId: string;
	readonly intendedOutputLimit: number;
	readonly contextWindow: number;
}

export class RuntimeShell {
	readonly #session: Session;
	readonly #settings: RuntimeSettingsOwner;
	readonly #models: Models | undefined;
	readonly #assistantEffects = new Map<string, AssistantEffectPlan>();
	#current: RuntimeAttachment;
	#sealed = false;
	#admissionLine: Promise<void> = Promise.resolve();
	#closePromise: Promise<void> | undefined;

	constructor(session: Session, settings: RuntimeSettingsOwner, attachment: RuntimeAttachment, models?: Models) {
		this.#session = session;
		this.#settings = settings;
		this.#current = attachment;
		this.#models = models;
	}

	#plan(): PlannedAction | undefined {
		return planAction(this.#current, {
			settingsRevision: this.#settings.peek().revision,
			assistantEffects: this.#assistantEffects,
		});
	}

	#admit<T>(operation: () => Promise<T> | T): Promise<T> {
		if (this.#sealed) return Promise.reject(new RuntimeShellError("closed", "Runtime shell is closed"));
		const admitted = this.#admissionLine.then(operation);
		this.#admissionLine = admitted.then(
			() => undefined,
			() => undefined,
		);
		return admitted;
	}

	peekAction(): Promise<ActionInfo | undefined> {
		return this.#admit(() => this.#plan()?.info);
	}

	executeAction(): Promise<ActionInfo | undefined> {
		return this.#admit(async () => {
			const action = this.#plan();
			if (!action) return undefined;
			if (action.info.kind !== "start_assistant_step" && action.info.kind !== "prepare_assistant_effect")
				throw new RuntimeShellError("unavailable", `Action ${action.info.kind} is not executable in Phase 1`);
			const info = action.info;
			return this.#settings.withSnapshot(async (settings) => {
				if (settings.revision !== action.expected.settingsRevision)
					throw new RuntimeShellError("stale", "Runtime settings changed before action execution");
				if (info.kind === "prepare_assistant_effect") {
					const state = this.#current.runState?.value;
					const operation = this.#current.runOperation?.value;
					const phase = state?.phase;
					if (!operation || phase?.kind !== "assistant" || phase.generation.status !== "ready")
						throw new RuntimeShellError("stale", "Assistant generation is no longer ready");
					const generation = phase.generation;
					const provider = generation.context.configuration.model.provider;
					const modelId = generation.context.configuration.model.modelId;
					let lease: ModelRequestLease | undefined;
					try {
						lease = this.#models?.lease(provider, modelId);
					} catch {
						lease = undefined;
					}
					const model = lease?.model;
					const intendedOutputLimit = model?.maxTokens;
					const contextWindow = model?.contextWindow;
					if (
						!lease ||
						!model ||
						model.provider !== provider ||
						model.id !== modelId ||
						typeof intendedOutputLimit !== "number" ||
						!Number.isSafeInteger(intendedOutputLimit) ||
						intendedOutputLimit <= 0 ||
						typeof contextWindow !== "number" ||
						!Number.isSafeInteger(contextWindow) ||
						contextWindow <= 0
					)
						throw new RuntimeShellError("unavailable", "Captured provider/model lease is unavailable");
					const messages = structuredClone(await this.#session.projectBuiltinContext());
					const context: Context = {
						messages,
						...(operation.intent.systemPromptOverride === undefined
							? {}
							: { systemPrompt: operation.intent.systemPromptOverride }),
					};
					const options: ModelsSimpleStreamOptions = {
						...structuredClone(generation.context.streamOptions),
						...(generation.context.configuration.thinkingLevel === "off"
							? {}
							: { reasoning: generation.context.configuration.thinkingLevel }),
					};
					const result = await prepareAssistantEffect(this.#session, {
						operationId: info.operationId,
						stepId: info.stepId,
						attempt: info.nextAttempt,
						expectedOperationStateSeq: action.expected.operationStateSeq,
						expectedLaneStateSeq: action.expected.laneStateSeq,
						expectedConfigurationSeq: action.expected.configurationSeq,
						expectedLeafSeq: this.#current.mainLeaf.seq,
						expectedLeafId: this.#current.mainLeaf.value,
						expectedProvider: provider,
						expectedModelId: modelId,
						intendedOutputLimit,
						contextWindow,
					});
					this.#current = result.attachment;
					if (!result.committed) throw new RuntimeShellError("stale", "Action no longer matches durable state");
					const key = assistantEffectKey(info.operationId, info.stepId, info.nextAttempt);
					this.#assistantEffects.set(key, {
						key,
						lease,
						context,
						options,
						operationId: info.operationId,
						stepId: info.stepId,
						attempt: info.nextAttempt,
						responseEntryId: result.responseEntryId,
						usageId: result.usageId,
						intendedOutputLimit,
						contextWindow,
					});
					return info;
				}
				const result = await startAssistantStep(this.#session, {
					operationId: info.operationId,
					triggerEntryId: info.triggerEntryId,
					expectedOperationStateSeq: action.expected.operationStateSeq,
					expectedLaneStateSeq: action.expected.laneStateSeq,
					expectedConfigurationSeq: action.expected.configurationSeq,
					streamOptions: settings.streamOptions,
					retryPolicy: settings.retryPolicy,
				});
				this.#current = result.attachment;
				if (!result.committed) throw new RuntimeShellError("stale", "Action no longer matches durable state");
				return info;
			});
		});
	}

	prompt(input: Message | readonly Message[]): Promise<RuntimeAttachment> {
		if (this.#sealed) return Promise.reject(new RuntimeShellError("closed", "Runtime shell is closed"));
		let messages: Message[];
		try {
			const values = Array.isArray(input) ? input : [input];
			if (values.length === 0)
				throw new RuntimeShellError("unavailable", "Prompt must contain at least one message");
			messages = Array.from(values, (message) => encodeMessage(message) as unknown as Message);
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#admit(() => {
			const expected = this.#current;
			return this.#settings.withSnapshot(async () => {
				let identityAvailable = false;
				try {
					identityAvailable =
						this.#models?.lease(
							expected.laneConfiguration.value.model.provider,
							expected.laneConfiguration.value.model.modelId,
						) !== undefined;
				} catch {
					identityAvailable = false;
				}
				const result = await acceptPrompt(this.#session, {
					messages,
					expectedConfigurationSeq: expected.laneConfiguration.seq,
					expectedLaneStateSeq: expected.laneState.seq,
					expectedLeafSeq: expected.mainLeaf.seq,
					expectedProvider: expected.laneConfiguration.value.model.provider,
					expectedModelId: expected.laneConfiguration.value.model.modelId,
					identityAvailable,
				});
				this.#current = result.attachment;
				if (result.status === "stale") throw new RuntimeShellError("stale", "Prompt attachment is stale");
				if (result.status === "busy") throw new RuntimeShellError("busy", "Main lane is busy");
				if (result.status === "unavailable")
					throw new RuntimeShellError("unavailable", "Configured provider/model is unavailable");
				return result.attachment;
			});
		});
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#sealed = true;
		this.#closePromise = this.#admissionLine.then(() => {
			this.#assistantEffects.clear();
			return this.#session.close();
		});
		return this.#closePromise;
	}
}

export async function createRuntimeShell(
	session: Session,
	seed: LaneConfiguration,
	options: RuntimeShellOptions = {},
): Promise<RuntimeShell> {
	const settings = new RuntimeSettingsOwner(options.streamOptions, options.retryPolicy);
	return new RuntimeShell(session, settings, await attachRuntime(session, seed), options.models);
}
