import { AsyncLocalStorage } from "node:async_hooks";
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
	type AfterToolCallCallback,
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeToolCallCallback,
	type ExecutedToolCallOutcome,
	executeToolCall,
	type FinalizedToolCallOutcome,
	finalizeToolCall,
	type PreparedToolCall,
	prepareToolCall,
} from "@nguyenphutrong/pi-agent-loop";
import { isUuidV7, type JsonValue } from "@nguyenphutrong/pi-session-storage";
import { decodePendingEntry, encodeMessage, encodePendingEntry } from "./codec.ts";
import type { LaneConfiguration, StreamOptions } from "./durable.ts";
import { type ActionInfo, assistantEffectKey, type PlannedAction, planAction, toolEffectKey } from "./planner.ts";
import {
	acceptPrompt,
	cancelQueued,
	claimRuntime,
	clearToolCall,
	consumeOperationQueue,
	finishRun,
	nextRun,
	placeRuntimeWrites,
	prepareAssistantEffect,
	queueOperationInput,
	recoverAssistantEffect,
	refreshRuntimeAttachment,
	releaseAssistantRetry,
	requestAbort,
	settleAssistantEffect,
	settleToolCall,
	startAssistantEffect,
	startAssistantStep,
	startToolEffect,
} from "./runtime-port.ts";
import { RuntimeSettingsOwner } from "./runtime-settings.ts";
import {
	type ClearToolCallOutcome,
	captureEntryId,
	captureEntryIds,
	captureEntryQuery,
	type RuntimeAppendResult,
	type RuntimeAttachment,
	type RuntimeOwner,
} from "./session.ts";
import type { EntryProjector, ProjectableCustomEntry, Session, SessionTree } from "./types.ts";

export type RuntimeShellErrorCode = "unavailable" | "busy" | "active" | "stale" | "closed" | "fault";

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
	readonly steeringMode?: "all" | "one-at-a-time";
	readonly followUpMode?: "all" | "one-at-a-time";
	readonly models?: Models;
	readonly tools?: readonly RuntimeToolDefinition<TContext>[];
	readonly toolContext?: RuntimeToolContextSource<TContext>;
	readonly beforeToolCall?: BeforeToolCallCallback;
	readonly afterToolCall?: AfterToolCallCallback;
	readonly entryProjectors?: Record<string, EntryProjector>;
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

interface ToolEffectPlan {
	readonly key: string;
	readonly operationId: string;
	readonly assistantEntryId: string;
	readonly turnId: string;
	readonly sourceIndex: number;
	readonly resultEntryId: string;
	readonly prepared: PreparedToolCall;
}

type ObservedToolResult =
	| { readonly status: "fulfilled"; readonly outcome: ExecutedToolCallOutcome }
	| { readonly status: "rejected"; readonly error: RuntimeShellError };

type ToolEffectState =
	| { readonly status: "planned"; readonly plan: ToolEffectPlan }
	| {
			readonly status: "running";
			readonly plan: ToolEffectPlan;
			readonly controller: AbortController;
			readonly observed: Promise<ObservedToolResult>;
	  }
	| {
			readonly status: "raw";
			readonly plan: ToolEffectPlan;
			readonly controller: AbortController;
			readonly outcome: ExecutedToolCallOutcome;
	  }
	| {
			readonly status: "finalizing";
			readonly plan: ToolEffectPlan;
			readonly finalizing: Promise<FinalizedToolCallOutcome>;
	  }
	| { readonly status: "finalized"; readonly plan: ToolEffectPlan; readonly finalized: FinalizedToolCallOutcome };

interface IdleWaiter {
	eligible: boolean;
	readonly resolve: () => void;
	readonly reject: (error: RuntimeShellError) => void;
}

interface IdleCallback {
	eligible: boolean;
	started: boolean;
	readonly callback: () => void | Promise<void>;
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

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

function captureEntryProjectors(source: Record<string, EntryProjector>): ReadonlyMap<string, EntryProjector> {
	const captured = new Map<string, EntryProjector>();
	for (const [customType, projector] of Object.entries(source)) {
		if (customType.length === 0 || customType.includes("\u0000") || typeof projector !== "function")
			throw new RuntimeShellError("unavailable", "Invalid entry projector registry");
		captured.set(customType, projector);
	}
	return captured;
}

export class RuntimeShell<TContext extends object | undefined = object | undefined> {
	readonly #session: Session;
	readonly #owner: RuntimeOwner;
	readonly session: SessionTree;
	readonly #settings: RuntimeSettingsOwner;
	readonly #models: Models | undefined;
	readonly #entryProjectors: ReadonlyMap<string, EntryProjector>;
	readonly #toolDefinitions: ReadonlyMap<string, RuntimeToolDefinition<TContext>>;
	readonly #toolContext: RuntimeToolContextSource<TContext> | undefined;
	readonly #beforeToolCall: BeforeToolCallCallback | undefined;
	readonly #afterToolCall: AfterToolCallCallback | undefined;
	readonly #toolBatches = new Map<string, ReadonlyMap<string, AgentTool>>();
	readonly #preparedTools = new Map<string, PreparedToolCall>();
	readonly #toolEffects = new Map<string, ToolEffectState>();
	readonly #assistantEffects = new Map<string, AssistantEffectState>();
	readonly #retryElapsed = new Set<string>();
	#current: RuntimeAttachment;
	#sealed = false;
	#fault: RuntimeShellError | undefined;
	#admissionLine: Promise<void> = Promise.resolve();
	#reservation: Promise<void> | undefined;
	readonly #idleCallbackContext = new AsyncLocalStorage<symbol>();
	readonly #idleCallbackToken = Symbol("idle callback");
	readonly #idleWaiters: IdleWaiter[] = [];
	readonly #idleCallbacks: IdleCallback[] = [];
	#runningIdleBatch: readonly IdleCallback[] = [];
	readonly #trackedReads = new Set<Promise<unknown>>();
	readonly #trackedAborts = new Set<Promise<unknown>>();
	#closePromise: Promise<void> | undefined;
	readonly #shutdownNotice: Promise<void>;
	readonly #notifyShutdown: () => void;

	constructor(
		session: Session,
		settings: RuntimeSettingsOwner,
		owner: RuntimeOwner,
		options: RuntimeShellOptions<TContext>,
	) {
		this.#session = session;
		this.#owner = owner;
		const facade: SessionTree = {
			getLeafId: () => this.#admitRead(() => session.getLeafId()),
			getEntry: (id) =>
				this.#captureThenRead(
					() => captureEntryId(id),
					(captured) => session.getEntry(captured),
				),
			getEntries: (ids) =>
				this.#captureThenRead(
					() => captureEntryIds(ids),
					(captured) => session.getEntries(captured),
				),
			getStats: () => this.#admitRead(() => session.getStats()),
			findEntries: (query) =>
				this.#captureThenRead(
					() => captureEntryQuery(query === undefined ? {} : query, false),
					(captured) => session.findEntries(captured),
				),
			findEntry: (query) =>
				this.#captureThenRead(
					() => captureEntryQuery(query === undefined ? {} : query, false),
					(captured) => session.findEntry(captured),
				),
			findEntriesOnBranch: (query) =>
				this.#captureThenRead(
					() => captureEntryQuery(query === undefined ? {} : query, true),
					(captured) => session.findEntriesOnBranch(captured),
				),
			findEntryOnBranch: (query) =>
				this.#captureThenRead(
					() => captureEntryQuery(query === undefined ? {} : query, true),
					(captured) => session.findEntryOnBranch(captured),
				),
			appendMessage: (message) =>
				this.#captureThenAdmit(
					() => encodeMessage(message) as unknown as Message,
					(captured) => this.#append(() => owner.appendMessage(captured)),
				),
			appendCustomEntry: (customType, data) =>
				this.#captureThenAdmit(
					() => {
						const captured = decodePendingEntry(
							encodePendingEntry(
								data === undefined
									? { type: "custom", customType }
									: { type: "custom", customType, payload: data },
							),
						);
						if (captured.type !== "custom") throw new Error("Captured custom entry changed type");
						return {
							customType: captured.customType,
							data: Object.hasOwn(captured, "payload") ? captured.payload : undefined,
						};
					},
					(captured) => this.#append(() => owner.appendCustomEntry(captured.customType, captured.data)),
				),
		};
		this.session = Object.freeze(facade);
		this.#settings = settings;
		this.#current = owner.attachment;
		this.#models = options.models;
		this.#entryProjectors = captureEntryProjectors(options.entryProjectors ?? {});
		this.#toolDefinitions = captureToolDefinitions(options.tools ?? []);
		this.#toolContext = options.toolContext;
		this.#beforeToolCall = options.beforeToolCall;
		this.#afterToolCall = options.afterToolCall;
		let notifyShutdown!: () => void;
		this.#shutdownNotice = new Promise((resolve) => {
			notifyShutdown = resolve;
		});
		this.#notifyShutdown = notifyShutdown;
	}

	async #projectCustomEntry(entry: ProjectableCustomEntry): Promise<readonly Message[]> {
		const projector = this.#entryProjectors.get(entry.customType);
		if (!projector) return [];
		const output = await projector(entry);
		if (output === undefined) return [];
		if (!Array.isArray(output)) throw new Error("Entry projector must return an array or undefined");
		return Object.freeze(output.map((message) => Object.freeze(encodeMessage(message) as unknown as Message)));
	}

	async #projectContext(leafId: string | null): Promise<Message[]> {
		if (leafId === null) return [];
		const entries = await this.#session.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
		const messages: Message[] = [];
		for (const entry of entries) {
			if (entry.type === "message") {
				if (
					entry.message.role !== "assistant" ||
					!["error", "aborted", "deferred"].includes(entry.message.stopReason)
				)
					messages.push(Object.freeze(encodeMessage(entry.message) as unknown as Message));
				continue;
			}
			const projectable = Object.freeze({
				id: entry.id,
				parentId: entry.parentId,
				type: "custom" as const,
				customType: entry.customType,
				...(Object.hasOwn(entry, "data") ? { data: structuredClone(entry.data) } : {}),
			});
			messages.push(...(await this.#projectCustomEntry(projectable)));
		}
		return messages;
	}

	#plan(): PlannedAction | undefined {
		return planAction(this.#current, {
			settingsRevision: this.#settings.peek().revision,
			assistantEffectStatus: (key) => this.#assistantEffects.get(key)?.status,
			toolEffectStatus: (key) => this.#toolEffects.get(key)?.status,
			retryElapsed: (operationId, stepId, nextAttempt, notBefore) =>
				this.#retryElapsed.has(`${operationId}:${stepId}:${nextAttempt}:${notBefore}`),
		});
	}

	#publish(attachment: RuntimeAttachment): void {
		const highWaterMark = (candidate: RuntimeAttachment): number =>
			Math.max(
				candidate.laneConfiguration.seq,
				candidate.laneState.seq,
				candidate.mainLeaf.seq,
				candidate.runOperation?.seq ?? 0,
				candidate.runState?.seq ?? 0,
				...Array.from(candidate.entries.values(), (entry) => entry.seq),
				...Array.from(candidate.usageRows.values(), (usage) => usage.seq),
			);
		if (highWaterMark(attachment) >= highWaterMark(this.#current)) this.#current = attachment;
		this.#pumpIdle();
	}

	#abortRunningEffects(): void {
		for (const effect of this.#assistantEffects.values()) if (effect.status === "running") effect.controller.abort();
		for (const effect of this.#toolEffects.values()) if (effect.status === "running") effect.controller.abort();
	}

	#faultShell(effectKey: string | undefined, cause: unknown, message: string): RuntimeShellError {
		if (!this.#fault) this.#fault = new RuntimeShellError("fault", message, cause);
		this.#sealed = true;
		this.#rejectIdleRecords(this.#fault);
		this.#notifyShutdown();
		this.#abortRunningEffects();
		if (effectKey !== undefined) this.#assistantEffects.delete(effectKey);
		if (effectKey !== undefined) this.#toolEffects.delete(effectKey);
		this.#toolBatches.clear();
		this.#preparedTools.clear();
		this.#toolEffects.clear();
		return this.#fault;
	}

	#assistantFailure(effectKey: string, cause: unknown): RuntimeShellError {
		return this.#fault
			? this.#fault
			: this.#sealed
				? new RuntimeShellError("closed", "Runtime shell is closed")
				: this.#faultShell(effectKey, cause, "Assistant stream violated its runtime contract");
	}

	#toolFailure(effectKey: string, cause: unknown): RuntimeShellError {
		return this.#fault
			? this.#fault
			: this.#sealed
				? new RuntimeShellError("closed", "Runtime shell is closed")
				: this.#faultShell(effectKey, cause, "Tool effect violated its runtime contract");
	}

	#transitionFailure(cause: unknown): RuntimeShellError {
		if (this.#fault) return this.#fault;
		if (this.#sealed) return new RuntimeShellError("closed", "Runtime shell is closed");
		return this.#faultShell(undefined, cause, "Runtime transition failed");
	}

	async #append(append: () => Promise<RuntimeAppendResult>): Promise<string> {
		try {
			const result = await append();
			this.#publish(result.attachment);
			return result.entryId;
		} catch (cause) {
			throw this.#transitionFailure(cause);
		}
	}

	#captureThenAdmit<TCapture, TResult>(
		capture: () => TCapture,
		operation: (captured: TCapture) => Promise<TResult>,
	): Promise<TResult> {
		const lifecycleError = this.#lifecycleError();
		if (lifecycleError) return Promise.reject(lifecycleError);
		try {
			const captured = capture();
			return this.#admit(() => operation(captured));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	#captureThenRead<TCapture, TResult>(
		capture: () => TCapture,
		operation: (captured: TCapture) => Promise<TResult>,
	): Promise<TResult> {
		const lifecycleError = this.#lifecycleError();
		if (lifecycleError) return Promise.reject(lifecycleError);
		try {
			const captured = capture();
			return this.#admitRead(() => operation(captured));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	#lifecycleError(): RuntimeShellError | undefined {
		if (this.#fault) return this.#fault;
		if (this.#sealed) return new RuntimeShellError("closed", "Runtime shell is closed");
		return undefined;
	}

	#admit<T>(operation: () => Promise<T> | T): Promise<T> {
		const lifecycleError = this.#lifecycleError();
		if (lifecycleError) return Promise.reject(lifecycleError);
		if (this.#idleCallbackContext.getStore() === this.#idleCallbackToken)
			return Promise.reject(new RuntimeShellError("active", "Idle callback cannot mutate runtime state"));
		return this.#admitMarker(operation);
	}

	#admitMarker<T>(operation: () => Promise<T> | T): Promise<T> {
		const admitted = this.#admissionLine.then(async () => {
			if (this.#fault) throw this.#fault;
			if (this.#reservation) await this.#reservation;
			if (this.#fault) throw this.#fault;
			return operation();
		});
		this.#admissionLine = admitted.then(
			() => undefined,
			() => undefined,
		);
		return admitted;
	}

	#admitRead<T>(operation: () => Promise<T> | T): Promise<T> {
		const lifecycleError = this.#lifecycleError();
		if (lifecycleError) return Promise.reject(lifecycleError);
		const read = Promise.resolve().then(() => {
			if (this.#fault) throw this.#fault;
			return operation();
		});
		this.#trackedReads.add(read);
		void read.then(
			() => this.#trackedReads.delete(read),
			() => this.#trackedReads.delete(read),
		);
		return read;
	}

	#rejectIdleRecords(error: RuntimeShellError): void {
		for (const waiter of this.#idleWaiters.splice(0)) waiter.reject(error);
		for (const record of this.#idleCallbacks.splice(0)) if (!record.started) record.reject(error);
		for (const record of this.#runningIdleBatch) if (!record.started) record.reject(error);
	}

	#pumpIdle(): void {
		if (this.#sealed || this.#fault || this.#reservation || this.#current.laneState.value.currentOperationId !== null)
			return;
		for (let index = this.#idleWaiters.length - 1; index >= 0; index--) {
			const waiter = this.#idleWaiters[index];
			if (!waiter?.eligible) continue;
			this.#idleWaiters.splice(index, 1);
			waiter.resolve();
		}
		const batch: IdleCallback[] = [];
		while (this.#idleCallbacks[0]?.eligible) {
			const record = this.#idleCallbacks.shift();
			if (record) batch.push(record);
		}
		if (batch.length === 0) return;
		let release!: () => void;
		this.#reservation = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.#runningIdleBatch = batch;
		void Promise.resolve().then(async () => {
			try {
				for (const record of batch) {
					const lifecycleError = this.#lifecycleError();
					if (lifecycleError) {
						record.reject(lifecycleError);
						continue;
					}
					record.started = true;
					try {
						await this.#idleCallbackContext.run(this.#idleCallbackToken, record.callback);
						record.resolve();
					} catch (error) {
						record.reject(error);
					}
				}
			} finally {
				this.#runningIdleBatch = [];
				this.#reservation = undefined;
				release();
				this.#pumpIdle();
			}
		});
	}

	waitForIdle(): Promise<void> {
		const lifecycleError = this.#lifecycleError();
		if (lifecycleError) return Promise.reject(lifecycleError);
		let resolve!: () => void;
		let reject!: (error: RuntimeShellError) => void;
		const promise = new Promise<void>((onResolve, onReject) => {
			resolve = onResolve;
			reject = onReject;
		});
		const record: IdleWaiter = { eligible: false, resolve, reject };
		this.#idleWaiters.push(record);
		void this.#admitMarker(async () => {
			const attachment = await refreshRuntimeAttachment(this.#session).catch((cause: unknown) => {
				throw this.#transitionFailure(cause);
			});
			this.#publish(attachment);
			record.eligible = true;
			this.#pumpIdle();
		}).catch((error: unknown) => {
			const index = this.#idleWaiters.indexOf(record);
			if (index >= 0) this.#idleWaiters.splice(index, 1);
			reject(error instanceof RuntimeShellError ? error : this.#transitionFailure(error));
		});
		return promise;
	}

	runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		const lifecycleError = this.#lifecycleError();
		if (lifecycleError) return Promise.reject(lifecycleError);
		if (typeof callback !== "function") return Promise.reject(new TypeError("Idle callback must be a function"));
		let resolve!: () => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<void>((onResolve, onReject) => {
			resolve = onResolve;
			reject = onReject;
		});
		const record: IdleCallback = { eligible: false, started: false, callback, resolve, reject };
		this.#idleCallbacks.push(record);
		void this.#admitMarker(async () => {
			const attachment = await refreshRuntimeAttachment(this.#session).catch((cause: unknown) => {
				throw this.#transitionFailure(cause);
			});
			this.#publish(attachment);
			record.eligible = true;
			this.#pumpIdle();
		}).catch((error: unknown) => {
			const index = this.#idleCallbacks.indexOf(record);
			if (index >= 0) this.#idleCallbacks.splice(index, 1);
			reject(error instanceof RuntimeShellError ? error : this.#transitionFailure(error));
		});
		return promise;
	}

	peekAction(): Promise<ActionInfo | undefined> {
		return this.#admitRead(() => this.#plan()?.info);
	}

	executeAction(): Promise<ActionInfo | undefined> {
		return this.#admit(async () => {
			const action = this.#plan();
			if (!action) return undefined;
			if (action.info.kind === "apply_deferred_writes") {
				const classifications: { entryId: string; projection: "projecting" | "unprojected" }[] = [];
				const plannedLeaf = this.#current.mainLeaf;
				let parentId = plannedLeaf.value;
				try {
					for (const entryId of action.info.entryIds) {
						const pending = this.#current.pendingEntries.get(entryId);
						if (!pending) throw new Error("Planned pending entry is missing");
						let projection: "projecting" | "unprojected" = "projecting";
						if (pending.type === "custom") {
							const projectable = Object.freeze({
								id: entryId,
								parentId,
								type: "custom" as const,
								customType: pending.customType,
								...(Object.hasOwn(pending, "payload") ? { data: structuredClone(pending.payload) } : {}),
							});
							projection =
								(await this.#projectCustomEntry(projectable)).length > 0 ? "projecting" : "unprojected";
						}
						classifications.push({ entryId, projection });
						parentId = entryId;
					}
				} catch (cause) {
					throw this.#transitionFailure(cause);
				}
				const result = await placeRuntimeWrites(this.#session, {
					operationId: action.info.operationId,
					expectedOperationStateSeq: action.expected.operationStateSeq,
					expectedLeafSeq: plannedLeaf.seq,
					expectedLeafId: plannedLeaf.value,
					entryIds: action.info.entryIds,
					classifications,
				}).catch((cause: unknown) => {
					throw this.#transitionFailure(cause);
				});
				this.#publish(result.attachment);
				if (result.status === "obsolete") throw new RuntimeShellError("stale", "Deferred writes are obsolete");
				return action.info;
			}
			if (action.info.kind === "consume_queue") {
				const result = await consumeOperationQueue(this.#session, {
					operationId: action.info.operationId,
					kind: action.info.queue,
					entryIds: action.info.entryIds,
					expectedOperationStateSeq: action.expected.operationStateSeq,
				}).catch((cause: unknown) => {
					throw this.#transitionFailure(cause);
				});
				this.#publish(result.attachment);
				if (!result.committed) throw new RuntimeShellError("stale", "Queue consumption is no longer authoritative");
				return action.info;
			}
			if (action.info.kind === "cancel_planned_tool") {
				const info = action.info;
				const assistant = this.#current.entries.get(info.assistantEntryId);
				const source =
					assistant?.type === "message" && assistant.message.role === "assistant"
						? assistant.message.content.filter((content) => content.type === "toolCall")[info.sourceIndex]
						: undefined;
				if (!source) throw this.#faultShell(undefined, undefined, "Cancelled tool source is missing");
				const result = await clearToolCall(this.#session, {
					operationId: info.operationId,
					assistantEntryId: info.assistantEntryId,
					turnId: info.turnId,
					sourceIndex: info.sourceIndex,
					resultEntryId: info.resultEntryId,
					expectedOperationStateSeq: action.expected.operationStateSeq,
					expectedLaneStateSeq: action.expected.laneStateSeq,
					expectedLeafSeq: this.#current.mainLeaf.seq,
					expectedLeafId: this.#current.mainLeaf.value,
					outcome: {
						kind: "immediate",
						toolCall: structuredClone(source),
						result: { content: [{ type: "text", text: "Operation aborted" }], details: {} },
						isError: true,
						terminate: false,
					},
				}).catch((cause: unknown) => {
					throw this.#transitionFailure(cause);
				});
				this.#publish(result.attachment);
				if (result.status === "obsolete") throw new RuntimeShellError("stale", "Cancelled tool is obsolete");
				return info;
			}
			if (action.info.kind === "cancel_tool_effect") {
				const effectKey = action.info.effectKey;
				const effect = this.#toolEffects.get(effectKey);
				if (effect?.status !== "planned") throw new RuntimeShellError("stale", "Tool effect is no longer planned");
				const plan = effect.plan;
				const result = await settleToolCall(this.#session, {
					operationId: plan.operationId,
					assistantEntryId: plan.assistantEntryId,
					turnId: plan.turnId,
					sourceIndex: plan.sourceIndex,
					resultEntryId: plan.resultEntryId,
					replay: plan.prepared.replay,
					toolCall: structuredClone(plan.prepared.toolCall),
					args: structuredClone(plan.prepared.args) as Record<string, JsonValue>,
					content: [{ type: "text", text: "Operation aborted" }],
					details: {},
					isError: true,
					terminate: false,
				}).catch((cause: unknown) => {
					throw this.#toolFailure(effectKey, cause);
				});
				this.#publish(result.attachment);
				this.#toolEffects.delete(effectKey);
				this.#preparedTools.delete(`${plan.assistantEntryId}:${plan.sourceIndex}`);
				if (result.status === "obsolete") throw new RuntimeShellError("stale", "Cancelled tool is obsolete");
				return action.info;
			}
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
					assistant?.type === "message" && assistant.message.role === "assistant"
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
				this.#publish(result.attachment);
				if (result.status === "obsolete")
					throw new RuntimeShellError("stale", "Tool clearance is no longer authoritative");
				if (this.#sealed) throw new RuntimeShellError("closed", "Runtime shell is closed");
				if (outcome.kind === "prepared") {
					const preparedKey = `${info.assistantEntryId}:${info.sourceIndex}`;
					const key = toolEffectKey(info.operationId, phase.batch.turnId, info.sourceIndex);
					this.#preparedTools.set(preparedKey, outcome);
					this.#toolEffects.set(key, {
						status: "planned",
						plan: {
							key,
							operationId: info.operationId,
							assistantEntryId: info.assistantEntryId,
							turnId: phase.batch.turnId,
							sourceIndex: info.sourceIndex,
							resultEntryId: info.resultEntryId,
							prepared: outcome,
						},
					});
				}
				return info;
			}
			if (action.info.kind === "recover_tool_effect") {
				const info = action.info;
				const phase = this.#current.runState?.value.phase;
				const call = phase?.kind === "tools" ? phase.batch.calls[info.sourceIndex] : undefined;
				if (
					this.#current.runOperation?.value.operationId !== info.operationId ||
					phase?.kind !== "tools" ||
					phase.batch.assistantEntryId !== info.assistantEntryId ||
					phase.batch.turnId !== info.turnId ||
					call?.status !== "effect_pending" ||
					call.resultEntryId !== info.resultEntryId
				)
					throw new RuntimeShellError("stale", "Tool effect is no longer recoverable");
				const assistant = this.#current.entries.get(info.assistantEntryId);
				const source =
					assistant?.type === "message" && assistant.message.role === "assistant"
						? assistant.message.content.filter((content) => content.type === "toolCall")[info.sourceIndex]
						: undefined;
				const argsKey = `${info.operationId}:${info.turnId}:${info.sourceIndex}`;
				const args = this.#current.toolArguments.get(argsKey);
				if (!source || !args)
					throw this.#faultShell(undefined, undefined, "Recovered tool source or arguments are missing");
				if (!phase.batch.configuration.activeToolNames.includes(source.name))
					throw this.#faultShell(
						undefined,
						undefined,
						"Recovered tool source was not active in its captured batch",
					);
				const definition = call.replay === "safe" ? this.#toolDefinitions.get(source.name) : undefined;
				const currentReplay = definition?.replay ?? "never";
				if (
					this.#current.runState?.value.control.status === "running" &&
					call.replay === "safe" &&
					definition &&
					currentReplay === "safe"
				) {
					let context: TContext;
					try {
						context =
							typeof this.#toolContext === "function"
								? await this.#toolContext()
								: (this.#toolContext as TContext);
					} catch (cause) {
						throw this.#faultShell(undefined, cause, "Tool context callback violated its runtime contract");
					}
					const refreshed = await refreshRuntimeAttachment(this.#session).catch((cause: unknown) => {
						throw this.#transitionFailure(cause);
					});
					this.#publish(refreshed);
					if (this.#sealed) throw new RuntimeShellError("closed", "Runtime shell is closed");
					const currentPhase = refreshed.runState?.value.phase;
					const currentCall =
						currentPhase?.kind === "tools" ? currentPhase.batch.calls[info.sourceIndex] : undefined;
					const firstUnfinished =
						currentPhase?.kind === "tools"
							? currentPhase.batch.calls.findIndex((candidate) => candidate.status !== "completed")
							: undefined;
					if (
						refreshed.runOperation?.value.operationId !== info.operationId ||
						currentPhase?.kind !== "tools" ||
						currentPhase.batch.assistantEntryId !== info.assistantEntryId ||
						currentPhase.batch.turnId !== info.turnId ||
						firstUnfinished !== info.sourceIndex ||
						currentCall?.status !== "effect_pending" ||
						currentCall.sourceIndex !== info.sourceIndex ||
						currentCall.resultEntryId !== info.resultEntryId ||
						currentCall.replay !== "safe"
					)
						throw new RuntimeShellError("stale", "Tool effect is no longer recoverable");
					const currentAssistant = refreshed.entries.get(info.assistantEntryId);
					const currentSource =
						currentAssistant?.type === "message" && currentAssistant.message.role === "assistant"
							? currentAssistant.message.content.filter((content) => content.type === "toolCall")[
									info.sourceIndex
								]
							: undefined;
					const currentArgs = refreshed.toolArguments.get(argsKey);
					if (!currentSource || !currentArgs)
						throw this.#faultShell(undefined, undefined, "Recovered tool source or arguments are missing");
					if (!currentPhase.batch.configuration.activeToolNames.includes(currentSource.name))
						throw this.#faultShell(
							undefined,
							undefined,
							"Recovered tool source was not active in its captured batch",
						);
					const currentDefinition = this.#toolDefinitions.get(currentSource.name);
					if (!currentDefinition || (currentDefinition.replay ?? "never") !== "safe")
						throw new RuntimeShellError("stale", "Tool effect is no longer safely replayable");
					const prepared: PreparedToolCall = Object.freeze({
						kind: "prepared",
						toolCall: structuredClone(currentSource),
						tool: bindRuntimeTool(currentDefinition, context),
						args: structuredClone(currentArgs),
						replay: "safe",
					});
					const key = toolEffectKey(info.operationId, info.turnId, info.sourceIndex);
					this.#preparedTools.set(`${info.assistantEntryId}:${info.sourceIndex}`, prepared);
					this.#toolEffects.set(key, { status: "planned", plan: { key, ...info, prepared } });
					return info;
				}
				const result = await settleToolCall(this.#session, {
					operationId: info.operationId,
					assistantEntryId: info.assistantEntryId,
					turnId: info.turnId,
					sourceIndex: info.sourceIndex,
					resultEntryId: info.resultEntryId,
					replay: call.replay,
					toolCall: structuredClone(source),
					args: structuredClone(args),
					content: [{ type: "text", text: "Tool outcome unknown after interruption" }],
					details: {},
					isError: true,
					terminate: false,
				}).catch((cause: unknown) => {
					throw this.#toolFailure(toolEffectKey(info.operationId, info.turnId, info.sourceIndex), cause);
				});
				this.#publish(result.attachment);
				if (result.status === "obsolete")
					throw new RuntimeShellError("stale", "Tool effect is no longer authoritative");
				return info;
			}
			if (action.info.kind === "dispatch_tool_effect") {
				const effectKey = action.info.effectKey;
				const effect = this.#toolEffects.get(effectKey);
				if (effect?.status !== "planned") throw new RuntimeShellError("stale", "Tool effect is no longer planned");
				const phase = this.#current.runState?.value.phase;
				const call = phase?.kind === "tools" ? phase.batch.calls[effect.plan.sourceIndex] : undefined;
				if (
					this.#current.runOperation?.value.operationId !== effect.plan.operationId ||
					phase?.kind !== "tools" ||
					phase.batch.assistantEntryId !== effect.plan.assistantEntryId ||
					phase.batch.turnId !== effect.plan.turnId ||
					call?.status !== "effect_pending" ||
					call.resultEntryId !== effect.plan.resultEntryId ||
					call.replay !== effect.plan.prepared.replay
				)
					throw new RuntimeShellError("stale", "Tool effect is no longer authoritative");
				const preparedKey = `${effect.plan.assistantEntryId}:${effect.plan.sourceIndex}`;
				if (this.#preparedTools.get(preparedKey) !== effect.plan.prepared)
					throw this.#faultShell(effectKey, undefined, "Prepared tool ownership is inconsistent");
				const controller = new AbortController();
				let observe!: (result: ObservedToolResult) => void;
				const observed = new Promise<ObservedToolResult>((resolve) => {
					observe = resolve;
				});
				const result = await startToolEffect(
					this.#session,
					{ ...effect.plan, replay: effect.plan.prepared.replay },
					() => {
						this.#toolEffects.set(effectKey, { status: "running", plan: effect.plan, controller, observed });
						this.#preparedTools.delete(preparedKey);
						Promise.resolve(executeToolCall(effect.plan.prepared, controller.signal)).then(
							(outcome) => observe({ status: "fulfilled", outcome }),
							(cause) => observe({ status: "rejected", error: this.#toolFailure(effectKey, cause) }),
						);
					},
				).catch((cause: unknown) => {
					throw this.#toolFailure(effectKey, cause);
				});
				this.#publish(result.attachment);
				if (result.status === "obsolete") throw new RuntimeShellError("stale", "Tool effect is obsolete");
				if (result.status === "not_started") return action.info;
				return action.info;
			}
			if (action.info.kind === "await_tool_effect") {
				const effect = this.#toolEffects.get(action.info.effectKey);
				if (effect?.status === "finalizing") {
					const finalized = await effect.finalizing;
					this.#toolEffects.set(action.info.effectKey, { status: "finalized", plan: effect.plan, finalized });
					return action.info;
				}
				if (effect?.status !== "running") throw new RuntimeShellError("stale", "Tool effect is no longer running");
				const observed = await Promise.race([effect.observed, this.#shutdownNotice.then(() => undefined)]);
				if (this.#fault) throw this.#fault;
				if (this.#sealed || observed === undefined)
					throw new RuntimeShellError("closed", "Runtime shell is closed");
				if (observed.status === "rejected") throw observed.error;
				this.#toolEffects.set(action.info.effectKey, {
					status: "raw",
					plan: effect.plan,
					controller: effect.controller,
					outcome: observed.outcome,
				});
				return action.info;
			}
			if (action.info.kind === "finalize_tool_effect") {
				const effectKey = action.info.effectKey;
				const effect = this.#toolEffects.get(effectKey);
				if (effect?.status !== "raw") throw new RuntimeShellError("stale", "Tool effect has no raw result");
				let finalizing: Promise<FinalizedToolCallOutcome> | undefined;
				const result = await startToolEffect(
					this.#session,
					{ ...effect.plan, replay: effect.plan.prepared.replay },
					() => {
						finalizing = finalizeToolCall(
							effect.plan.prepared,
							effect.outcome,
							this.#afterToolCall,
							effect.controller.signal,
						);
						this.#toolEffects.set(effectKey, { status: "finalizing", plan: effect.plan, finalizing });
					},
				).catch((cause: unknown) => {
					throw this.#toolFailure(effectKey, cause);
				});
				this.#publish(result.attachment);
				if (result.status === "obsolete") throw new RuntimeShellError("stale", "Tool finalization is obsolete");
				const finalized =
					result.status === "started" && finalizing
						? await finalizing
						: { ...(await finalizeToolCall(effect.plan.prepared, effect.outcome)), terminate: false };
				if (this.#fault) throw this.#fault;
				if (this.#sealed) throw new RuntimeShellError("closed", "Runtime shell is closed");
				this.#toolEffects.set(effectKey, { status: "finalized", plan: effect.plan, finalized });
				return action.info;
			}
			if (action.info.kind === "settle_tool_effect") {
				const effectKey = action.info.effectKey;
				const effect = this.#toolEffects.get(effectKey);
				if (effect?.status !== "finalized") throw new RuntimeShellError("stale", "Tool effect is not finalized");
				let detached: Parameters<typeof settleToolCall>[1];
				try {
					detached = {
						operationId: effect.plan.operationId,
						assistantEntryId: effect.plan.assistantEntryId,
						turnId: effect.plan.turnId,
						sourceIndex: effect.plan.sourceIndex,
						resultEntryId: effect.plan.resultEntryId,
						replay: effect.plan.prepared.replay,
						toolCall: structuredClone(effect.plan.prepared.toolCall),
						args: structuredClone(effect.plan.prepared.args) as Record<string, JsonValue>,
						content: structuredClone(effect.finalized.result.content),
						details: structuredClone(effect.finalized.result.details) as JsonValue,
						...(effect.finalized.result.usage === undefined
							? {}
							: { usage: structuredClone(effect.finalized.result.usage) }),
						...(effect.finalized.result.addedToolNames === undefined
							? {}
							: { addedToolNames: structuredClone(effect.finalized.result.addedToolNames) }),
						isError: effect.finalized.isError,
						terminate: effect.finalized.terminate,
					};
				} catch (cause) {
					throw this.#toolFailure(effectKey, cause);
				}
				const result = await settleToolCall(this.#session, detached).catch((cause: unknown) => {
					throw this.#toolFailure(effectKey, cause);
				});
				this.#publish(result.attachment);
				this.#toolEffects.delete(effectKey);
				this.#preparedTools.delete(`${effect.plan.assistantEntryId}:${effect.plan.sourceIndex}`);
				if (result.status === "obsolete")
					throw new RuntimeShellError("stale", "Tool effect is no longer authoritative");
				return action.info;
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
				this.#publish(result.attachment);
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
				this.#publish(result.attachment);
				this.#assistantEffects.delete(assistantEffectKey(info.operationId, info.stepId, info.attempt));
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
				const result = await startAssistantEffect(this.#session, effect.plan, () => {
					this.#assistantEffects.set(effectKey, { status: "running", plan: effect.plan, controller, observed });
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
				}).catch((cause: unknown) => {
					throw this.#assistantFailure(effectKey, cause);
				});
				this.#publish(result.attachment);
				if (result.status === "obsolete") throw new RuntimeShellError("stale", "Assistant effect is obsolete");
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
				this.#publish(result.attachment);
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
			if (
				action.info.kind === "finish_run" ||
				action.info.kind === "finish_failed_run" ||
				action.info.kind === "finish_aborted_run"
			) {
				const result = await finishRun(this.#session, {
					operationId: action.info.operationId,
					expectedOperationStateSeq: action.expected.operationStateSeq,
				}).catch((cause: unknown) => {
					throw this.#transitionFailure(cause);
				});
				this.#publish(result.attachment);
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
					let messages: Message[];
					try {
						messages = await this.#projectContext(this.#current.mainLeaf.value);
					} catch (cause) {
						throw this.#transitionFailure(cause);
					}
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
					this.#publish(result.attachment);
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
				this.#publish(result.attachment);
				if (!result.committed) throw new RuntimeShellError("stale", "Action no longer matches durable state");
				return info;
			});
		});
	}

	async runToCompletion(): Promise<void> {
		for (;;) {
			if ((await this.executeAction()) === undefined) return;
		}
	}

	abort(): Promise<{
		readonly operationId: string;
		readonly drainedSteer: readonly Message[];
		readonly drainedFollowUp: readonly Message[];
	}> {
		const lifecycleError = this.#lifecycleError();
		if (lifecycleError) return Promise.reject(lifecycleError);
		if (this.#idleCallbackContext.getStore() === this.#idleCallbackToken)
			return Promise.reject(new RuntimeShellError("active", "Idle callback cannot abort the runtime"));
		const abort = (async () => {
			while (this.#reservation) await this.#reservation;
			if (this.#fault) throw this.#fault;
			const result = await requestAbort(this.#session, (attachment) => {
				this.#publish(attachment);
				this.#abortRunningEffects();
			}).catch((cause: unknown) => {
				throw this.#transitionFailure(cause);
			});
			this.#publish(result.attachment);
			if (result.status === "no_active") throw new RuntimeShellError("unavailable", "No active operation");
			return Object.freeze({
				operationId: result.operationId,
				drainedSteer: cloneFrozen(result.drainedSteer),
				drainedFollowUp: cloneFrozen(result.drainedFollowUp),
			});
		})();
		this.#trackedAborts.add(abort);
		void abort.then(
			() => this.#trackedAborts.delete(abort),
			() => this.#trackedAborts.delete(abort),
		);
		return abort;
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
			return this.#settings.withSnapshot(async (settings) => {
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
					expectedPendingNextRun: expected.laneState.value.pendingNextRun,
					expectedLeafSeq: expected.mainLeaf.seq,
					expectedProvider: expected.laneConfiguration.value.model.provider,
					expectedModelId: expected.laneConfiguration.value.model.modelId,
					identityAvailable,
					steeringMode: settings.steeringMode,
					followUpMode: settings.followUpMode,
				});
				this.#publish(result.attachment);
				if (result.status === "stale") throw new RuntimeShellError("stale", "Prompt attachment is stale");
				if (result.status === "busy") throw new RuntimeShellError("busy", "Main lane is busy");
				if (result.status === "unavailable")
					throw new RuntimeShellError("unavailable", "Configured provider/model is unavailable");
				return result.attachment;
			});
		});
	}

	nextRun(input: Message): Promise<{ readonly entryId: string }> {
		if (this.#fault) return Promise.reject(this.#fault);
		if (this.#sealed) return Promise.reject(new RuntimeShellError("closed", "Runtime shell is closed"));
		let message: Message;
		try {
			message = encodeMessage(input) as unknown as Message;
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#admit(async () => {
			const result = await nextRun(this.#session, message).catch((cause: unknown) => {
				throw this.#transitionFailure(cause);
			});
			this.#publish(result.attachment);
			if (!result.entryId) throw new RuntimeShellError("fault", "Next-run admission omitted its entry id");
			return Object.freeze({ entryId: result.entryId });
		});
	}

	steer(input: Message): Promise<{ readonly entryId: string }> {
		return this.#queueOperationInput("steer", input);
	}

	followUp(input: Message): Promise<{ readonly entryId: string }> {
		return this.#queueOperationInput("followUp", input);
	}

	#queueOperationInput(kind: "steer" | "followUp", input: Message): Promise<{ readonly entryId: string }> {
		if (this.#fault) return Promise.reject(this.#fault);
		if (this.#sealed) return Promise.reject(new RuntimeShellError("closed", "Runtime shell is closed"));
		let message: Message;
		try {
			message = encodeMessage(input) as unknown as Message;
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#admit(async () => {
			if (!this.#current.runState || this.#current.runState.value.control.status !== "running")
				throw new RuntimeShellError("unavailable", "Operation queue requires an active running run");
			const result = await queueOperationInput(this.#session, kind, message).catch((cause: unknown) => {
				throw this.#transitionFailure(cause);
			});
			this.#publish(result.attachment);
			if (!result.entryId) throw new RuntimeShellError("fault", "Operation queue admission omitted its entry id");
			return Object.freeze({ entryId: result.entryId });
		});
	}

	cancelQueued(entryId: string): Promise<{ readonly kind: "cancelled" | "already_consumed" | "not_found" }> {
		if (this.#fault) return Promise.reject(this.#fault);
		if (this.#sealed) return Promise.reject(new RuntimeShellError("closed", "Runtime shell is closed"));
		if (typeof entryId !== "string" || !isUuidV7(entryId))
			return Promise.reject(new RuntimeShellError("unavailable", "Queued entry id must be a UUIDv7"));
		return this.#admit(async () => {
			const result = await cancelQueued(this.#session, entryId).catch((cause: unknown) => {
				throw this.#transitionFailure(cause);
			});
			this.#publish(result.attachment);
			if (!result.outcome) throw new RuntimeShellError("fault", "Queue cancellation omitted its outcome");
			return Object.freeze({ kind: result.outcome });
		});
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		if (this.#idleCallbackContext.getStore() === this.#idleCallbackToken)
			return Promise.reject(new RuntimeShellError("active", "Idle callback cannot close the runtime"));
		this.#sealed = true;
		this.#rejectIdleRecords(new RuntimeShellError("closed", "Runtime shell is closed"));
		this.#notifyShutdown();
		this.#abortRunningEffects();
		this.#closePromise = this.#admissionLine.then(async () => {
			if (this.#reservation) await this.#reservation;
			await Promise.allSettled([...this.#trackedAborts]);
			await Promise.allSettled([...this.#trackedReads]);
			this.#abortRunningEffects();
			this.#assistantEffects.clear();
			this.#toolEffects.clear();
			this.#toolBatches.clear();
			this.#preparedTools.clear();
			this.#retryElapsed.clear();
			await this.#owner.close();
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
	const entryProjectors = Object.fromEntries(captureEntryProjectors(options.entryProjectors ?? {}));
	const settings = new RuntimeSettingsOwner(
		options.streamOptions,
		options.retryPolicy,
		options.steeringMode,
		options.followUpMode,
	);
	return new RuntimeShell(session, settings, await claimRuntime(session, seed), {
		...options,
		tools,
		entryProjectors,
	});
}
