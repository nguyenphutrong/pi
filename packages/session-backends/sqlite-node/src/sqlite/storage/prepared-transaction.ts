import { assertTransaction, type EntryType, type Transaction } from "@nguyenphutrong/pi-session-storage";

export type PreparedWrite =
	| {
			readonly kind: "entry";
			readonly id: string;
			readonly parentId: string | null;
			readonly type: EntryType;
			readonly customType: string | null;
			readonly payload: string | null;
	  }
	| {
			readonly kind: "usage";
			readonly id: string;
			readonly entryId: string | null;
			readonly usageJson: string;
			readonly adjustment: boolean;
			readonly details: string | null;
	  }
	| {
			readonly kind: "register";
			readonly op: "set";
			readonly namespace: string;
			readonly key: string;
			readonly value: string;
	  }
	| { readonly kind: "register"; readonly op: "delete"; readonly namespace: string; readonly key: string };

export interface PreparedTransaction {
	readonly writes: readonly PreparedWrite[];
}

export function hasPreparedEntries(transaction: PreparedTransaction): boolean {
	return transaction.writes.some((write) => write.kind === "entry");
}

/** Validates, detaches, and serializes a transaction before it reaches a queue or SQLite. */
export function prepareTransaction(transaction: Transaction): PreparedTransaction {
	assertTransaction(transaction);
	const detached = structuredClone(transaction);
	const writes = detached.writes.map((write): PreparedWrite => {
		if (write.kind === "entry") {
			return Object.freeze({
				kind: "entry",
				id: write.entry.id,
				parentId: write.entry.parentId,
				type: write.entry.type,
				customType: write.entry.customType ?? null,
				payload: Object.hasOwn(write.entry, "payload") ? JSON.stringify(write.entry.payload) : null,
			});
		}
		if (write.kind === "usage") {
			return Object.freeze({
				kind: "usage",
				id: write.row.id,
				entryId: write.row.entryId ?? null,
				usageJson: JSON.stringify(write.row.usage),
				adjustment: write.row.adjustment,
				details: Object.hasOwn(write.row, "details") ? JSON.stringify(write.row.details) : null,
			});
		}
		return Object.freeze(
			write.op === "set"
				? {
						kind: "register",
						op: "set",
						namespace: write.namespace,
						key: write.key,
						value: JSON.stringify(write.value),
					}
				: { kind: "register", op: "delete", namespace: write.namespace, key: write.key },
		);
	});
	return Object.freeze({ writes: Object.freeze(writes) });
}
