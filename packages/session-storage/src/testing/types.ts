import type { Storage, Transaction } from "../types.ts";

export type OrdinaryReadStorage = Pick<
	Storage,
	"getEntries" | "getUsageRows" | "getRegister" | "listRegisters" | "scanEntries" | "getStats" | "close"
>;

export interface OrdinaryReadConformanceFixture extends AsyncDisposable {
	readonly storage: OrdinaryReadStorage;
	seed(transaction: Transaction): Promise<void>;
}

export type OrdinaryReadConformanceFixtureFactory = () => Promise<OrdinaryReadConformanceFixture>;

export interface StorageConformanceFixture extends AsyncDisposable {
	readonly storage: Storage;
}

export type StorageConformanceFixtureFactory = () => Promise<StorageConformanceFixture>;

export interface StorageConformanceCase {
	readonly group: string;
	readonly name: string;
	run(): Promise<void>;
}
