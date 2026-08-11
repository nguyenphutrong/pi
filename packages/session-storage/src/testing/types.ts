import type { Storage } from "../types.ts";

export interface StorageConformanceFixture extends AsyncDisposable {
	readonly storage: Storage;
}

export type StorageConformanceFixtureFactory = () => Promise<StorageConformanceFixture>;

export interface StorageConformanceCase {
	readonly group: string;
	readonly name: string;
	run(): Promise<void>;
}
