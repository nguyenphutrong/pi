import type { TelemetryContext } from "@earendil-works/pi-telemetry";

export interface RunStartEvent {
	readonly type: "run_start";
	readonly lane: "main";
	readonly runId: string;
}

export interface HookHandlerErrorEvent {
	readonly type: "handler_error";
	readonly kind: "hook";
	readonly hook: string;
	readonly lane: "main";
	readonly error: string;
	readonly stack?: string;
}

export interface EventHandlerErrorEvent {
	readonly type: "handler_error";
	readonly kind: "event";
	readonly event: string;
	readonly lane: "main";
	readonly error: string;
	readonly stack?: string;
}

export type HandlerErrorEvent = HookHandlerErrorEvent | EventHandlerErrorEvent;
export type HarnessEvent = RunStartEvent | HandlerErrorEvent;
export type HarnessEventType = HarnessEvent["type"];
export type EventListener<Event extends HarnessEvent = HarnessEvent> = (event: Event) => void | Promise<void>;

export interface RuntimeEvents {
	on<Type extends HarnessEventType>(
		type: Type,
		listener: EventListener<Extract<HarnessEvent, { type: Type }>>,
	): () => void;
}

interface EventRegistration {
	readonly type: HarnessEventType;
	readonly invoke: (event: HarnessEvent) => void | Promise<void>;
	active: boolean;
}

interface HookErrorMetadata {
	readonly hook: string;
	readonly lane: "main";
	readonly error: string;
	readonly stack?: string;
}

function detachedFrozen<Event extends HarnessEvent>(event: Event): Event {
	const clone = structuredClone(event);
	const freeze = (value: unknown): void => {
		if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	};
	freeze(clone);
	return clone;
}

function safeError(error: unknown): { readonly error: string; readonly stack?: string } {
	let message = "Event listener failed";
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

export class RuntimeEventRegistry implements RuntimeEvents {
	readonly #assertRegistrationOpen: () => void;
	readonly #telemetryContext: TelemetryContext;
	readonly #registrations: EventRegistration[] = [];

	constructor(assertRegistrationOpen: () => void, telemetryContext: TelemetryContext) {
		this.#assertRegistrationOpen = assertRegistrationOpen;
		this.#telemetryContext = telemetryContext;
	}

	on<Type extends HarnessEventType>(
		type: Type,
		listener: EventListener<Extract<HarnessEvent, { type: Type }>>,
	): () => void {
		this.#assertRegistrationOpen();
		if (type !== "run_start" && type !== "handler_error") throw new TypeError("Unsupported runtime event name");
		if (typeof listener !== "function") throw new TypeError("Runtime event listener must be a function");
		const registration: EventRegistration = {
			type,
			invoke: (event) => listener(event as Extract<HarnessEvent, { type: Type }>),
			active: true,
		};
		this.#registrations.push(registration);
		let subscribed = true;
		return () => {
			if (!subscribed) return;
			subscribed = false;
			registration.active = false;
		};
	}

	publish(event: HarnessEvent): void {
		let published: HarnessEvent;
		try {
			published = detachedFrozen(event);
		} catch {
			return;
		}
		const snapshot = this.#registrations.filter(
			(registration) => registration.active && registration.type === published.type,
		);
		for (const registration of snapshot) this.#invoke(registration.invoke, published);
	}

	reportHookError(metadata: HookErrorMetadata): void {
		this.publish({
			type: "handler_error",
			kind: "hook",
			hook: metadata.hook,
			lane: metadata.lane,
			error: metadata.error,
			...(metadata.stack === undefined ? {} : { stack: metadata.stack }),
		});
	}

	#invoke(listener: EventListener, event: HarnessEvent): void {
		let listenerPromise: Promise<void> | undefined;
		const invokeOnce = (): Promise<void> => {
			if (listenerPromise) return listenerPromise;
			try {
				listenerPromise = Promise.resolve(listener(event));
			} catch (error) {
				listenerPromise = Promise.reject(error);
			}
			return listenerPromise;
		};
		try {
			void Promise.resolve(
				this.#telemetryContext.startSpan(
					{
						name: "pi.harness.event_handler",
						attributes: {
							"pi.event.type": event.type,
							...("lane" in event ? { "pi.lane.name": event.lane } : {}),
						},
					},
					invokeOnce,
				),
			).catch(() => {});
		} catch {}
		void invokeOnce().catch((error: unknown) => {
			if (event.type === "handler_error") return;
			let extracted: { readonly error: string; readonly stack?: string };
			try {
				extracted = safeError(error);
			} catch {
				extracted = { error: "Event listener failed" };
			}
			this.publish({
				type: "handler_error",
				kind: "event",
				event: event.type,
				lane: "main",
				...extracted,
			});
		});
	}
}
