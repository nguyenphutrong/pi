import type { RetryPolicy } from "@earendil-works/pi-ai";
import { encodeStreamOptions, type NormalizedRetryPolicy, type StreamOptions } from "./durable.ts";
import { SessionError } from "./types.ts";

export interface RuntimeSettingsSnapshot {
	readonly revision: number;
	readonly streamOptions: StreamOptions;
	readonly retryPolicy: NormalizedRetryPolicy;
}

function normalizeRetryPolicy(value: RetryPolicy | undefined): NormalizedRetryPolicy {
	const policy = value === undefined ? { enabled: false, maxRetries: 0, baseDelayMs: 1000 } : value;
	const prototype = policy === null || typeof policy !== "object" ? undefined : Object.getPrototypeOf(policy);
	const keys = policy === null || typeof policy !== "object" ? [] : Reflect.ownKeys(policy);
	if (
		policy === null ||
		typeof policy !== "object" ||
		Array.isArray(policy) ||
		(prototype !== Object.prototype && prototype !== null) ||
		keys.length !== 3 ||
		keys.some((key) => {
			if (typeof key !== "string") return true;
			const descriptor = Object.getOwnPropertyDescriptor(policy, key);
			return !descriptor?.enumerable || !("value" in descriptor);
		}) ||
		!Object.hasOwn(policy, "enabled") ||
		!Object.hasOwn(policy, "maxRetries") ||
		!Object.hasOwn(policy, "baseDelayMs") ||
		typeof policy.enabled !== "boolean" ||
		!Number.isSafeInteger(policy.maxRetries) ||
		policy.maxRetries < 0 ||
		!Number.isSafeInteger(policy.baseDelayMs) ||
		policy.baseDelayMs < 0
	)
		throw new SessionError(
			"invalid_query",
			"Retry policy must have exact, valid enabled, maxRetries, and baseDelayMs fields",
		);
	if (policy.maxRetries === Number.MAX_SAFE_INTEGER)
		throw new SessionError("invalid_query", "Retry policy maxAttempts would exceed the safe integer range");
	return Object.freeze({ maxAttempts: policy.enabled ? policy.maxRetries + 1 : 1, baseDelayMs: policy.baseDelayMs });
}

export class RuntimeSettingsOwner {
	#snapshot: RuntimeSettingsSnapshot;
	#mutationLine: Promise<void> = Promise.resolve();

	constructor(streamOptions: StreamOptions = {}, retryPolicy?: RetryPolicy) {
		this.#snapshot = Object.freeze({
			revision: 0,
			streamOptions: encodeStreamOptions(streamOptions),
			retryPolicy: normalizeRetryPolicy(retryPolicy),
		});
	}

	peek(): RuntimeSettingsSnapshot {
		return this.#snapshot;
	}

	withSnapshot<T>(operation: (snapshot: RuntimeSettingsSnapshot) => Promise<T>): Promise<T> {
		const admitted = this.#mutationLine.then(() => operation(this.#snapshot));
		this.#mutationLine = admitted.then(
			() => undefined,
			() => undefined,
		);
		return admitted;
	}
}
