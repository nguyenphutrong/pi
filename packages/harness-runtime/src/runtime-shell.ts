import type {
	AssistantMessage,
	Context,
	Message,
	ModelRequestLease,
	Models,
	ModelsSimpleStreamOptions,
	RetryPolicy,
	Static,
	TSchema,
} from "@earendil-works/pi-ai";
import {
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeToolCallCallback,
	type PreparedToolCall,
	prepareToolCall,
} from "@nguyenphutrong/pi-agent-loop";
import type { JsonValue } from "@nguyenphutrong/pi-session-storage";
import { encodeMessage } from "./codec.ts";
import type { LaneConfiguration, StreamOptions } from "./durable.ts";
import { type ActionInfo, assistantEffectKey, type PlannedAction, planAction } from "./planner.ts";
import {
	acceptPrompt,
	attachRuntime,
	clearToolCall,
	finishRun,
	prepareAssistantEffect,
	recoverAssistantEffect,
	releaseAssistantRetry,
	settleAssistantEffect,
	startAssistantStep,
} from "./runtime-port.ts";
import { RuntimeSettingsOwner } from "./runtime-settings.ts";
import type { ClearToolCallOutcome, RuntimeAttachment } from "./session.ts";
import type { Session } from "./types.ts";

export type RuntimeShellErrorCode = "unavailable" | "busy" | "stale" | "closed" | "fault";

export class RuntimeShellError extends Error {
	readonly code: RuntimeShellErrorCode;

	constructor(code: RuntimeShellErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "RuntimeShellError";
		this.code = code;
	}
}

export interface RuntimeToolDefinition<
	TContext extends object | undefined,
	TParameters extends TSchema = TSchema,
	TDetails = unknown,
> extends Omit<AgentTool<TParameters, TDetails>, "execute"> {
	execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		context: TContext,
	): Promise<AgentToolResult<TDetails>>;
}

export type RuntimeToolContextSource<TContext extends object | undefined> =
	| TContext
	| (() => TContext | Promise<TContext>);

export interface RuntimeShellOptions<TContext extends object | undefined = object | undefined> {
	readonly streamOptions?: StreamOptions;
	readonly retryPolicy?: RetryPolicy;
	readonly models?: Models;
	readonly tools?: readonly RuntimeToolDefinition<TContext>[];
	readonly toolContext?: RuntimeToolContextSource<TContext>;
	readonly beforeToolCall?: BeforeToolCallCallback;
}

interface AssistantEffectPlan {
	readonly key: string;
	readonly lease: ModelRequestLease;
	readonly context: Context;
	readonly options: ModelsSimpleStreamOptions;
	readonly provider: string;
	readonly modelId: string;
	readonly operationId: string;
	readonly stepId: string;
	readonly attempt: number;
	readonly responseEntryId: string;
	readonly usageId: string;
	readonly triggerEntryId: string;
	readonly intendedOutputLimit: number;
	readonly contextWindow: number;
}

type ObservedAssistantResult =
	| { readonly status: "fulfilled"; readonly message: AssistantMessage }
	| { readonly status: "rejected"; readonly error: RuntimeShellError };

type AssistantEffectState =
	| { readonly status: "planned"; readonly plan: AssistantEffectPlan }
	| {
			readonly status: "running";
			readonly plan: AssistantEffectPlan;
			readonly controller: AbortController;
			readonly observed: Promise<ObservedAssistantResult>;
	  }
	| { readonly status: "settled"; readonly plan: AssistantEffectPlan; readonly message: AssistantMessage };

function bindRuntimeTool<TContext extends object | undefined, TParameters extends TSchema, TDetails>(
	definition: RuntimeToolDefinition<TContext, TParameters, TDetails>,
	context: TContext,
): AgentTool<TParameters, TDetails> {
	return Object.freeze({
		...definition,
		execute: (
			toolCallId: string,
			params: Static<TParameters>,
			signal?: AbortSignal,
			onUpdate?: AgentToolUpdateCallback<TDetails>,
		) => definition.execute(toolCallId, params, signal, onUpdate, context),
	});
}

function cloneFrozen<T>(value: T, clones = new WeakMap<object, object>()): T {
	if (value === null || typeof value !== "object") return value;
	const existing = clones.get(value);
	if (existing) return existing as T;
	const clone: object = Array.isArray(value)
		? new Array(value.length)
		: (Object.create(Object.getPrototypeOf(value)) as object);
	clones.set(value, clone);
	for (const key of Reflect.ownKeys(value)) {
		if (Array.isArray(value) && key === "length") continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor) continue;
		Object.defineProperty(
			clone,
			key,
			"value" in descriptor ? { ...descriptor, value: cloneFrozen(descriptor.value, clones) } : descriptor,
		);
	}
	return Object.freeze(clone) as T;
}

function captureToolDefinitions<TContext extends object | undefined>(
	definitions: readonly RuntimeToolDefinition<TContext>[],
): ReadonlyMap<string, RuntimeToolDefinition<TContext>> {
	const captured = new Map<string, RuntimeToolDefinition<TContext>>();
	for (const definition of definitions) {
		if (captured.has(definition.name))
			throw new RuntimeShellError("unavailable", `Duplicate runtime tool definition: ${definition.name}`);
		const copy = cloneFrozen(definition);
		captured.set(copy.name, copy);
	}
	return captured;
}

export class RuntimeShell<TContext extends object | undefined = object | undefined> {
	readonly #session: Session;
	readonly #settings: RuntimeSettingsOwner;
	readonly #models: Models | undefined;
	readonly #toolDefinitions: ReadonlyMap<string, RuntimeToolDefinition<TContext>>;
	readonly #toolContext: RuntimeToolContextSource<TContext> | undefined;
	readonly #beforeToolCall: BeforeToolCallCallback | undefined;
	readonly #toolBatches = new Map<string, ReadonlyMap<string, AgentTool>>();
	readonly #preparedTools = new Map<string, PreparedToolCall>();
	readonly #assistantEffects = new Map<string, AssistantEffectState>();
	readonly #retryElapsed = new Set<string>();
	#current: RuntimeAttachment;
	#sealed = false;
	#fault: RuntimeShellError | undefined;
	#admissionLine: Promise<void> = Promise.resolve();
	#closePromise: Promise<void> | undefined;
	readonly #shutdownNotice: Promise<void>;
	readonly #notifyShutdown: () => void;

	constructor(
		session: Session,
		settings: RuntimeSettingsOwner,
		attachment: RuntimeAttachment,
		options: RuntimeShellOptions<TContext>,
	) {
		this.#session = session;
		this.#settings = settings;
		this.#current = attachment;
		this.#models = options.models;
		this.#toolDefinitions = captureToolDefinitions(options.tools ?? []);
		this.#toolContext = options.toolContext;
		this.#beforeToolCall = options.beforeToolCall;
		let notifyShutdown!: () => void;
		this.#shutdownNotice = new Promise((resolve) => {
			notifyShutdown = resolve;
		});
		this.#notifyShutdown = notifyShutdown;
	}

	#plan(): PlannedAction | undefined {
		return planAction(this.#current, {
			settingsRevision: this.#settings.peek().revision,
			assistantEffectStatus: (key) => this.#assistantEffects.get(key)?.status,
			retryElapsed: (operationId, stepId, nextAttempt, notBefore) =>
				this.#retryElapsed.has(`${operationId}:${stepId}:${nextAttempt}:${notBefore}`),
		});
	}

	#abortRunningEffects(): void {
		for (const effect of this.#assistantEffects.values()) if (effect.status === "running") effect.controller.abort();
	}

	#faultShell(effectKey: string | undefined, cause: unknown, message: string): RuntimeShellError {
		if (!this.#fault) this.#fault = new RuntimeShellError("fault", message, cause);
		this.#sealed = true;
		this.#notifyShutdown();
		this.#abortRunningEffects();
		if (effectKey !== undefined) this.#assistantEffects.delete(effectKey);
		this.#toolBatches.clear();
		this.#preparedTools.clear();
		return this.#fault;
	}

	#assistantFailure(effectKey: string, cause: unknown): RuntimeShellError {
		return this.#fault
			? this.#fault
			: this.#sealed
				? new RuntimeShellError("closed", "Runtime shell is closed")
				: this.#faultShell(effectKey, cause, "Assistant stream violated its runtime contract");
	}

	#transitionFailure(cause: unknown): RuntimeShellError {
		if (this.#fault) return this.#fault;
		if (this.#sealed) return new RuntimeShellError("closed", "Runtime shell is closed");
		return this.#faultShell(undefined, cause, "Runtime transition failed");
	}

	#admit<T>(operation: () => Promise<T> | T): Promise<T> {
		if (this.#fault) return Promise.reject(this.#fault);
		if (this.#sealed) return Promise.reject(new RuntimeShellError("closed", "Runtime shell is closed"));
		const admitted = this.#admissionLine.then(() => {
			if (this.#fault) throw this.#fault;
			return operation();
		});
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
			if (action.info.kind === "prepare_tool_call") {
				const info = action.info;
				const phase = this.#current.runState?.value.phase;
				if (phase?.kind !== "tools" || phase.batch.assistantEntryId !== info.assistantEntryId)
					throw new RuntimeShellError("stale", "Tool batch is no longer current");
				let leases = this.#toolBatches.get(info.assistantEntryId);
				if (!leases) {
					const activeDefinitions = phase.batch.configuration.activeToolNames.map((name) =>
						this.#toolDefinitions.get(name),
					);
					if (activeDefinitions.some((definition) => definition === undefined))
						throw new RuntimeShellError("unavailable", "Captured active tool definition is unavailable");
					let context: TContext;
					try {
						context =
							typeof this.#toolContext === "function"
								? await this.#toolContext()
								: (this.#toolContext as TContext);
					} catch (cause) {
						throw this.#faultShell(undefined, cause, "Tool context callback violated its runtime contract");
					}
					leases = new Map(
						activeDefinitions.map((definition) => {
							if (!definition) throw new Error("Missing active tool definition after validation");
							return [definition.name, bindRuntimeTool(definition, context)];
						}),
					);
					this.#toolBatches.set(info.assistantEntryId, leases);
				}
				const assistant = this.#current.entries.get(info.assistantEntryId);
				const sourceCalls =
					assistant?.message.role === "assistant"
						? assistant.message.content.filter((content) => content.type === "toolCall")
						: [];
				const source = sourceCalls[info.sourceIndex];
				if (!source)
					throw this.#faultShell(undefined, undefined, "Tool source call is missing from its assistant entry");
				const outcome = await prepareToolCall(source, [...leases.values()], this.#beforeToolCall);
				let detachedOutcome: ClearToolCallOutcome;
				try {
					detachedOutcome =
						outcome.kind === "prepared"
							? {
									kind: "prepared" as const,
									toolCall: structuredClone(outcome.toolCall),
									args: structuredClone(outcome.args) as Record<string, JsonValue>,
									replay: outcome.replay,
								}
							: {
									kind: "immediate" as const,
									toolCall: structuredClone(outcome.toolCall),
									result: {
										content: structuredClone(outcome.result.content),
										details: structuredClone(outcome.result.details) as JsonValue,
										...(outcome.result.addedToolNames === undefined
											? {}
											: { addedToolNames: structuredClone(outcome.result.addedToolNames) }),
									},
									isError: true as const,
									terminate: outcome.terminate,
								};
				} catch (cause) {
					throw this.#faultShell(undefined, cause, "Tool clearance violated its runtime contract");
				}
				const result = await clearToolCall(this.#session, {
					operationId: info.operationId,
					assistantEntryId: info.assistantEntryId,
					turnId: phase.batch.turnId,
					sourceIndex: info.sourceIndex,
					resultEntryId: info.resultEntryId,
					expectedOperationStateSeq: action.expected.operationStateSeq,
					expectedLaneStateSeq: action.expected.laneStateSeq,
					expectedLeafSeq: this.#current.mainLeaf.seq,
					expectedLeafId: this.#current.mainLeaf.value,
					outcome: detachedOutcome,
				}).catch((cause: unknown) => {
					throw this.#transitionFailure(cause);
				});
				this.#current = result.attachment;
				if (result.status === "obsolete")
					throw new RuntimeShellError("stale", "Tool clearance is no longer authoritative");
				if (this.#sealed) throw new RuntimeShellError("closed", "Runtime shell is closed");
				if (outcome.kind === "prepared")
					this.#preparedTools.set(`${info.assistantEntryId}:${info.sourceIndex}`, outcome);
				return info;
			}
			if (action.info.kind === "wait_assistant_retry") {
				const info = action.info;
				let remaining = Math.max(0, info.notBefore - Date.now());
				while (remaining > 0) {
					const delay = Math.min(remaining, 2_147_483_647);
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([
							new Promise<void>((resolve) => {
								timer = setTimeout(resolve, delay);
							}),
							this.#shutdownNotice,
						]);
					} finally {
						if (timer !== undefined) clearTimeout(timer);
					}
					if (this.#fault) throw this.#fault;
					if (this.#sealed) throw new RuntimeShellError("closed", "Runtime shell is closed");
					remaining = Math.max(0, info.notBefore - Date.now());
				}
				if (this.#fault) throw this.#fault;
				if (this.#sealed) throw new RuntimeShellError("closed", "Runtime shell is closed");
				this.#retryElapsed.add(`${info.operationId}:${info.stepId}:${info.nextAttempt}:${info.notBefore}`);
				return info;
			}
			if (action.info.kind === "release_assistant_retry") {
				const info = action.info;
				const proof = `${info.operationId}:${info.stepId}:${info.nextAttempt}:${info.notBefore}`;
				const result = await releaseAssistantRetry(this.#session, {
					operationId: info.operationId,
					stepId: info.stepId,
					nextAttempt: info.nextAttempt,
					notBefore: info.notBefore,
					expectedOperationStateSeq: action.expected.operationStateSeq,
					expectedLaneStateSeq: action.expected.laneStateSeq,
				}).catch((cause: unknown) => {
					throw this.#transitionFailure(cause);
				});
				this.#current = result.attachment;
				this.#retryElapsed.delete(proof);
				if (result.status === "obsolete")
					throw new RuntimeShellError("stale", "Assistant retry wait is no longer authoritative");
				return info;
			}
			if (action.info.kind === "recover_assistant_effect") {
				const info = action.info;
				const phase = this.#current.runState?.value.phase;
				const generation = phase?.kind === "assistant" ? phase.generation : undefined;
				if (generation?.status !== "effect_pending")
					throw new RuntimeShellError("stale", "Assistant effect is no longer recoverable");
				const result = await recoverAssistantEffect(this.#session, {
					operationId: info.operationId,
					stepId: info.stepId,
					attempt: info.attempt,
					responseEntryId: generation.responseEntryId,
					usageId: generation.usageId,
					expectedOperationStateSeq: action.expected.operationStateSeq,
					expectedLaneStateSeq: action.expected.laneStateSeq,
				}).catch((cause: unknown) => {
					throw this.#transitionFailure(cause);
				});
				this.#current = result.attachment;
				if (result.status === "obsolete")
					throw new RuntimeShellError("stale", "Assistant effect is no longer authoritative");
				return info;
			}
			if (action.info.kind === "dispatch_assistant_effect") {
				if (this.#sealed) throw new RuntimeShellError("closed", "Runtime shell is closed");
				const effectKey = action.info.effectKey;
				const effect = this.#assistantEffects.get(effectKey);
				if (effect?.status !== "planned")
					throw new RuntimeShellError("stale", "Assistant effect is no longer planned");
				const controller = new AbortController();
				let observe!: (result: ObservedAssistantResult) => void;
				const observed = new Promise<ObservedAssistantResult>((resolve) => {
					observe = resolve;
				});
				this.#assistantEffects.set(effectKey, {
					status: "running",
					plan: effect.plan,
					controller,
					observed,
				});
				try {
					const stream = effect.plan.lease.streamSimple(effect.plan.context, {
						...effect.plan.options,
						signal: controller.signal,
					});
					Promise.resolve(stream.result()).then(
						(message) => observe({ status: "fulfilled", message }),
						(cause) => {
							observe({ status: "rejected", error: this.#assistantFailure(effectKey, cause) });
						},
					);
				} catch (cause) {
					controller.abort();
					throw this.#assistantFailure(effectKey, cause);
				}
				return action.info;
			}
			if (action.info.kind === "await_assistant_effect") {
				const effect = this.#assistantEffects.get(action.info.effectKey);
				if (effect?.status !== "running")
					throw new RuntimeShellError("stale", "Assistant effect is no longer running");
				const outcome = await Promise.race([effect.observed, this.#shutdownNotice.then(() => undefined)]);
				if (this.#fault) throw this.#fault;
				if (this.#sealed) throw new RuntimeShellError("closed", "Runtime shell is closed");
				if (outcome === undefined) {
					throw new RuntimeShellError("closed", "Runtime shell is closed");
				}
				if (outcome.status === "rejected") throw outcome.error;
				let message: AssistantMessage;
				try {
					message = encodeMessage(outcome.message) as unknown as AssistantMessage;
					if (
						message.role !== "assistant" ||
						message.provider !== effect.plan.provider ||
						message.model !== effect.plan.modelId ||
						message.stopReason === "pending"
					)
						throw new Error("Assistant stream returned a mismatched or non-terminal message");
				} catch (cause) {
					throw this.#faultShell(action.info.effectKey, cause, "Assistant stream violated its runtime contract");
				}
				this.#assistantEffects.set(action.info.effectKey, {
					status: "settled",
					plan: effect.plan,
					message: Object.freeze(message),
				});
				return action.info;
			}
			if (action.info.kind === "settle_assistant_effect") {
				const effectKey = action.info.effectKey;
				const effect = this.#assistantEffects.get(effectKey);
				if (effect?.status !== "settled")
					throw new RuntimeShellError("stale", "Assistant effect is no longer settled");
				const result = await settleAssistantEffect(this.#session, {
					operationId: effect.plan.operationId,
					stepId: effect.plan.stepId,
					attempt: effect.plan.attempt,
					responseEntryId: effect.plan.responseEntryId,
					usageId: effect.plan.usageId,
					provider: effect.plan.provider,
					modelId: effect.plan.modelId,
					triggerEntryId: effect.plan.triggerEntryId,
					intendedOutputLimit: effect.plan.intendedOutputLimit,
					contextWindow: effect.plan.contextWindow,
					message: effect.message,
				}).catch((cause: unknown) => {
					throw this.#assistantFailure(effectKey, cause);
				});
				this.#current = result.attachment;
				if (result.status === "unsupported")
					throw new RuntimeShellError(
						"unavailable",
						"Assistant settlement classification is unavailable in Phase 1",
					);
				this.#assistantEffects.delete(effectKey);
				if (result.status === "obsolete")
					throw new RuntimeShellError("stale", "Assistant effect is no longer authoritative");
				return action.info;
			}
			if (action.info.kind === "finish_run" || action.info.kind === "finish_failed_run") {
				const result = await finishRun(this.#session, {
					operationId: action.info.operationId,
					expectedOperationStateSeq: action.expected.operationStateSeq,
					expectedLaneStateSeq: action.expected.laneStateSeq,
				}).catch((cause: unknown) => {
					throw this.#transitionFailure(cause);
				});
				this.#current = result.attachment;
				if (result.status === "obsolete")
					throw new RuntimeShellError("stale", "Run finish is no longer authoritative");
				return action.info;
			}
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
						status: "planned",
						plan: {
							key,
							lease,
							context,
							options,
							provider,
							modelId,
							operationId: info.operationId,
							stepId: info.stepId,
							attempt: info.nextAttempt,
							responseEntryId: result.responseEntryId,
							usageId: result.usageId,
							triggerEntryId: generation.context.triggerEntryId,
							intendedOutputLimit,
							contextWindow,
						},
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
		if (this.#fault) return Promise.reject(this.#fault);
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
						) !== undefined &&
						expected.laneConfiguration.value.activeToolNames.every((name) => this.#toolDefinitions.has(name));
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
		this.#notifyShutdown();
		this.#abortRunningEffects();
		this.#closePromise = this.#admissionLine.then(() => {
			this.#abortRunningEffects();
			this.#assistantEffects.clear();
			this.#toolBatches.clear();
			this.#preparedTools.clear();
			this.#retryElapsed.clear();
			return this.#session.close();
		});
		return this.#closePromise;
	}
}

export async function createRuntimeShell<TContext extends object | undefined = object | undefined>(
	session: Session,
	seed: LaneConfiguration,
	options: RuntimeShellOptions<TContext> = {},
): Promise<RuntimeShell<TContext>> {
	const tools = [...captureToolDefinitions(options.tools ?? []).values()];
	const settings = new RuntimeSettingsOwner(options.streamOptions, options.retryPolicy);
	return new RuntimeShell(session, settings, await attachRuntime(session, seed), { ...options, tools });
}
