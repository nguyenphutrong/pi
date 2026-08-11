import { uuidv7 } from "@earendil-works/pi-ai";
import { StorageError } from "./types.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(id: string): boolean {
	return UUID_V7.test(id);
}

export function uuidV7Timestamp(id: string): number {
	if (!isUuidV7(id)) throw new StorageError("invalid_id", `Invalid UUIDv7: ${id}`);
	return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

export interface IdGenerator {
	next(timestampMs?: number): string;
}

export function createIdGenerator(): IdGenerator {
	return {
		next(timestampMs) {
			if (timestampMs === undefined) return uuidv7();
			if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > 0xffffffffffff) {
				throw new StorageError("invalid_id", "Follower timestamp must be a 48-bit non-negative integer");
			}
			const fresh = uuidv7().replaceAll("-", "");
			const hex = timestampMs.toString(16).padStart(12, "0") + fresh.slice(12);
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		},
	};
}

export function createFollowerId(leaderId: string, generator: IdGenerator = createIdGenerator()): string {
	return generator.next(uuidV7Timestamp(leaderId));
}
