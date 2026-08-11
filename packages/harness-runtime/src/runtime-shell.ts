import type { Message, Models, RetryPolicy } from "@earendil-works/pi-ai";
import { encodeMessage } from "./codec.ts";
import type { LaneConfiguration, StreamOptions } from "./durable.ts";
import { type ActionInfo, type PlannedAction, planAction } from "./planner.ts";
import { acceptPrompt, attachRuntime, startAssistantStep } from "./runtime-port.ts";
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

export class RuntimeShell {
	readonly #session: Session;
	readonly #settings: RuntimeSettingsOwner;
	readonly #models: Models | undefined;
	readonly #liveEffectKeys = new Set<string>();
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
			liveEffectKeys: this.#liveEffectKeys,
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
			if (action.info.kind !== "start_assistant_step")
				throw new RuntimeShellError("unavailable", `Action ${action.info.kind} is not executable in Phase 1`);
			const info = action.info;
			return this.#settings.withSnapshot(async (settings) => {
				if (settings.revision !== action.expected.settingsRevision)
					throw new RuntimeShellError("stale", "Runtime settings changed before action execution");
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
		this.#closePromise = this.#admissionLine.then(() => this.#session.close());
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
