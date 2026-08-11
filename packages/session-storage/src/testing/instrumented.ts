import type { CommitResult, Storage, Transaction } from "../types.ts";

export interface CommitAttempt {
	readonly transaction?: Transaction;
	status: "pending" | "committed" | "rejected";
}

/** Storage decorator that distinguishes invocation attempts from durable commits. */
export class InstrumentedStorage implements Storage {
	readonly attempts: CommitAttempt[] = [];
	readonly committedTransactions: Transaction[] = [];
	readonly transactions = this.committedTransactions;
	readonly delegate: Storage;

	constructor(delegate: Storage) {
		this.delegate = delegate;
	}

	commit(transaction: Transaction): Promise<CommitResult> {
		let snapshot: Transaction | undefined;
		try {
			snapshot = structuredClone(transaction);
		} catch {
			// The delegate owns admission and the typed error contract.
		}
		const attempt: CommitAttempt = {
			...(snapshot === undefined ? {} : { transaction: snapshot }),
			status: "pending",
		};
		this.attempts.push(attempt);
		let result: Promise<CommitResult>;
		try {
			result = this.delegate.commit(transaction);
		} catch (error) {
			attempt.status = "rejected";
			return Promise.reject(error);
		}
		return result.then(
			(value) => {
				attempt.status = "committed";
				if (snapshot !== undefined) this.committedTransactions.push(snapshot);
				return value;
			},
			(error: unknown) => {
				attempt.status = "rejected";
				throw error;
			},
		);
	}

	getEntries: Storage["getEntries"] = (ids) => this.delegate.getEntries(ids);
	getUsageRows: Storage["getUsageRows"] = (ids) => this.delegate.getUsageRows(ids);
	getRegister: Storage["getRegister"] = (namespace, key) => this.delegate.getRegister(namespace, key);
	listRegisters: Storage["listRegisters"] = (namespace) => this.delegate.listRegisters(namespace);
	scanBranch: Storage["scanBranch"] = (query) => this.delegate.scanBranch(query);
	scanBranchStructure: Storage["scanBranchStructure"] = (query) => this.delegate.scanBranchStructure(query);
	scanEntries: Storage["scanEntries"] = (query) => this.delegate.scanEntries(query);
	getStats: Storage["getStats"] = () => this.delegate.getStats();
	close: Storage["close"] = () => this.delegate.close();
}

export function instrumentStorage(delegate: Storage): InstrumentedStorage {
	return new InstrumentedStorage(delegate);
}
