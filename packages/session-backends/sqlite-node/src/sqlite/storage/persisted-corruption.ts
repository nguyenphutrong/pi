import { StorageError } from "@nguyenphutrong/pi-session-storage";

const persistedCorruptions = new WeakSet<object>();

export function persistedCorruption(message: string): StorageError {
	const error = new StorageError("corruption", message);
	persistedCorruptions.add(error);
	return error;
}

export function throwPersistedCorruption(message: string): never {
	throw persistedCorruption(message);
}

export function isPersistedSqliteCorruption(error: unknown): boolean {
	return typeof error === "object" && error !== null && persistedCorruptions.has(error);
}
