import { type ImageContent, type TextContent, type Usage, validateToolArguments } from "@earendil-works/pi-ai";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import {
	type AgentTool,
	normalizeAfterToolCallResult,
	normalizeBeforeToolCallResult,
} from "@nguyenphutrong/pi-agent-loop";
import { assertJsonValue, type JsonValue } from "@nguyenphutrong/pi-session-storage";

export interface BeforeToolHookInvocation {
	readonly lane: "main";
	readonly runId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: Readonly<Record<string, JsonValue>>;
}

export interface AfterToolHookInvocation extends BeforeToolHookInvocation {
	readonly content: readonly (TextContent | ImageContent)[];
	readonly details?: JsonValue;
	readonly isError: boolean;
	readonly usage?: Usage;
}

export interface BeforeToolHookResult {
	readonly args?: Record<string, JsonValue>;
	readonly block?: { readonly reason: string; readonly terminate?: boolean };
}

export interface AfterToolHookResult {
	readonly content?: (TextContent | ImageContent)[];
	readonly details?: JsonValue;
	readonly isError?: boolean;
	readonly usage?: Usage;
	readonly terminate?: boolean;
}

export interface ToolHookMap {
	readonly before_tool: {
		readonly event: BeforeToolHookInvocation;
		readonly result: BeforeToolHookResult | undefined;
	};
	readonly after_tool: {
		readonly event: AfterToolHookInvocation;
		readonly result: AfterToolHookResult | undefined;
	};
}

export type ToolHookName = keyof ToolHookMap;
export type ToolHookHandler<Name extends ToolHookName> = (
	event: ToolHookMap[Name]["event"],
) => ToolHookMap[Name]["result"] | Promise<ToolHookMap[Name]["result"]>;

export interface ToolHooks {
	on<Name extends ToolHookName>(
		name: Name,
		handler: ToolHookHandler<Name>,
		options?: { readonly id?: string },
	): () => void;
}

interface HookRegistration<Name extends ToolHookName> {
	readonly name: Name;
	readonly handler: ToolHookHandler<Name>;
	readonly id?: string;
	active: boolean;
}

interface HookHandlerError {
	readonly kind: "hook";
	readonly hook: ToolHookName;
	readonly lane: "main";
	readonly runId: string;
	readonly registrationId?: string;
	readonly error: string;
	readonly stack?: string;
}

type HookHandlerErrorReporter = (metadata: HookHandlerError) => void | Promise<void>;

function detachedFrozen<T>(value: T): T {
	const clone = structuredClone(value);
	const freeze = (candidate: unknown): void => {
		if (candidate === null || typeof candidate !== "object" || Object.isFrozen(candidate)) return;
		for (const child of Object.values(candidate)) freeze(child);
		Object.freeze(candidate);
	};
	freeze(clone);
	return clone;
}

function exactJsonRecord(value: unknown): Record<string, JsonValue> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Hook args must be an object");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("Hook args must be a plain object");
	if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
		throw new Error("Hook args have unsupported properties");
	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Hook args have unsupported properties");
	}
	assertJsonValue(value);
	return value as Record<string, JsonValue>;
}

function safeErrorText(error: unknown): { error: string; stack?: string } {
	let message = "Hook handler failed";
	let stack: string | undefined;
	try {
		if (error instanceof Error) {
			try {
				if (typeof error.message === "string" && error.message.length > 0) message = error.message;
			} catch {}
			try {
				if (typeof error.stack === "string") stack = error.stack;
			} catch {}
		} else if (typeof error === "string") message = error;
		else {
			try {
				message = String(error);
			} catch {}
		}
	} catch {}
	return { error: message, ...(stack === undefined ? {} : { stack }) };
}

function errorMetadata(
	name: ToolHookName,
	runId: string,
	registrationId: string | undefined,
	error: unknown,
): HookHandlerError {
	return detachedFrozen({
		kind: "hook",
		hook: name,
		lane: "main",
		runId,
		...(registrationId === undefined ? {} : { registrationId }),
		...safeErrorText(error),
	});
}

export class ToolHookRegistry implements ToolHooks {
	readonly #assertRegistrationOpen: () => void;
	readonly #telemetryContext: TelemetryContext;
	readonly #reportHandlerError: HookHandlerErrorReporter;
	readonly #registrations: { [Name in ToolHookName]: HookRegistration<Name>[] } = {
		before_tool: [],
		after_tool: [],
	};

	constructor(
		assertRegistrationOpen: () => void,
		telemetryContext: TelemetryContext,
		reportHandlerError: HookHandlerErrorReporter = () => {},
	) {
		this.#assertRegistrationOpen = assertRegistrationOpen;
		this.#telemetryContext = telemetryContext;
		this.#reportHandlerError = reportHandlerError;
	}

	on<Name extends ToolHookName>(
		name: Name,
		handler: ToolHookHandler<Name>,
		options: { readonly id?: string } = {},
	): () => void {
		this.#assertRegistrationOpen();
		if (name !== "before_tool" && name !== "after_tool") throw new TypeError("Unsupported tool hook name");
		if (typeof handler !== "function") throw new TypeError("Tool hook handler must be a function");
		if (options === null || typeof options !== "object" || Array.isArray(options))
			throw new TypeError("Tool hook options must be an object");
		const prototype = Object.getPrototypeOf(options);
		if (prototype !== Object.prototype && prototype !== null)
			throw new TypeError("Tool hook options must be a plain object");
		const keys = Reflect.ownKeys(options);
		if (keys.some((key) => key !== "id")) throw new TypeError("Tool hook options are invalid");
		const idDescriptor = Object.getOwnPropertyDescriptor(options, "id");
		if (idDescriptor && (!idDescriptor.enumerable || !("value" in idDescriptor)))
			throw new TypeError("Tool hook id must be a data property");
		const id = idDescriptor?.value;
		if (id !== undefined && typeof id !== "string") throw new TypeError("Tool hook id must be a string");
		const registration: HookRegistration<Name> = {
			name,
			handler,
			...(id === undefined ? {} : { id }),
			active: true,
		};
		this.#registrations[name].push(registration);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			registration.active = false;
		};
	}

	async #runHandler<Name extends ToolHookName, Result>(
		registration: HookRegistration<Name>,
		runId: string,
		invoke: () => Result | Promise<Result>,
		outcome: (result: Result) => "completed" | "skipped" | "blocked",
	): Promise<Result> {
		return this.#telemetryContext.startSpan(
			{
				name: "pi.harness.hook",
				attributes: {
					"pi.lane.name": "main",
					"pi.operation.id": runId,
					"pi.hook.name": registration.name,
					...(registration.id === undefined ? {} : { "pi.hook.registration_id": registration.id }),
				},
			},
			async (span) => {
				try {
					const result = await invoke();
					span.setAttributes({ "pi.hook.outcome": outcome(result) });
					return result;
				} catch (error) {
					span.setAttributes({ "pi.hook.outcome": "failed" });
					throw error;
				}
			},
		);
	}

	#report(name: ToolHookName, runId: string, registrationId: string | undefined, error: unknown): void {
		let metadata: HookHandlerError;
		try {
			metadata = errorMetadata(name, runId, registrationId, error);
		} catch {
			metadata = Object.freeze({ kind: "hook", hook: name, lane: "main", runId, error: "Hook handler failed" });
		}
		try {
			void Promise.resolve(this.#reportHandlerError(metadata)).catch(() => {});
		} catch {}
	}

	async invokeBefore(
		runId: string,
		toolCallId: string,
		toolName: string,
		initialArgs: unknown,
		tool: AgentTool,
	): Promise<BeforeToolHookResult | undefined> {
		const snapshot = this.#registrations.before_tool.filter((registration) => registration.active).slice();
		let args = detachedFrozen(exactJsonRecord(initialArgs));
		let changed = false;
		for (const registration of snapshot) {
			const event = detachedFrozen({ lane: "main" as const, runId, toolCallId, toolName, args });
			try {
				const normalized = await this.#runHandler(
					registration,
					runId,
					async () => {
						const output = normalizeBeforeToolCallResult(await registration.handler(event));
						if (output.kind === "invalid") throw new Error("Invalid before tool hook output");
						const value = output.value;
						if (value && Object.hasOwn(value, "args")) {
							const replacement = exactJsonRecord(value.args);
							args = detachedFrozen(
								exactJsonRecord(
									validateToolArguments(tool, {
										type: "toolCall",
										id: toolCallId,
										name: toolName,
										arguments: replacement,
									}),
								),
							);
							changed = true;
						}
						return output;
					},
					(result) =>
						result.kind === "valid" && result.value?.block !== undefined
							? "blocked"
							: result.kind === "valid" && result.value === undefined
								? "skipped"
								: "completed",
				);
				const result = normalized.value;
				if (result?.block) return detachedFrozen({ ...(changed ? { args } : {}), block: result.block });
			} catch (error) {
				this.#report("before_tool", runId, registration.id, error);
				return { block: { reason: safeErrorText(error).error } };
			}
		}
		return changed ? { args } : undefined;
	}

	async invokeAfter(eventSource: AfterToolHookInvocation): Promise<AfterToolHookResult | undefined> {
		const snapshot = this.#registrations.after_tool.filter((registration) => registration.active).slice();
		let aggregate: AfterToolHookResult = {};
		let changed = false;
		let current = detachedFrozen(eventSource);
		for (const registration of snapshot) {
			const event = detachedFrozen(current);
			try {
				const normalized = await this.#runHandler(
					registration,
					event.runId,
					async () => {
						const output = normalizeAfterToolCallResult(await registration.handler(event));
						if (output.kind === "invalid") throw new Error("Invalid after tool hook output");
						return output;
					},
					(result) => (result.kind === "valid" && result.value === undefined ? "skipped" : "completed"),
				);
				const patch = normalized.value;
				if (!patch) continue;
				if (Reflect.ownKeys(patch).length > 0) changed = true;
				aggregate = { ...aggregate, ...patch } as AfterToolHookResult;
				current = detachedFrozen({
					...current,
					...(Object.hasOwn(patch, "content") ? { content: patch.content } : {}),
					...(Object.hasOwn(patch, "details") ? { details: patch.details as JsonValue } : {}),
					...(Object.hasOwn(patch, "isError") ? { isError: patch.isError } : {}),
					...(Object.hasOwn(patch, "usage") ? { usage: patch.usage } : {}),
				});
			} catch (error) {
				this.#report("after_tool", event.runId, registration.id, error);
			}
		}
		return changed ? detachedFrozen(aggregate) : undefined;
	}
}
