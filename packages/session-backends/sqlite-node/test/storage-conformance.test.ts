import { createStorageConformance, type StorageConformanceFixture } from "@nguyenphutrong/pi-session-storage/testing";
import { describe, it } from "vitest";
import { createNodeSqliteFactory } from "../src/index.ts";
import type { TimerFactory, TimerHandle } from "../src/sqlite/storage/lifecycle.ts";
import { SqliteStorageRepository } from "../src/sqlite/storage/repository.ts";

const sessionId = "018f0000-0000-7000-8000-000000000001";

class DormantTimers implements TimerFactory {
	readonly handles = new Set<TimerHandle>();

	schedule(_callback: () => void, _delayMs: number): TimerHandle {
		const handle = {};
		this.handles.add(handle);
		return handle;
	}

	cancel(handle: TimerHandle): void {
		this.handles.delete(handle);
	}
}

async function fixture(): Promise<StorageConformanceFixture> {
	const database = await createNodeSqliteFactory().open(":memory:");
	const repository = new SqliteStorageRepository({
		factory: { open: async () => database },
		path: "storage-conformance",
		now: () => 100,
		ownerId: () => "storage-conformance-owner",
		timers: new DormantTimers(),
	});
	const handle = await repository.create({ id: sessionId });
	return {
		storage: handle,
		async [Symbol.asyncDispose]() {
			await handle.close().catch(() => undefined);
			await repository.close().catch(() => undefined);
		},
	};
}

const conformance = createStorageConformance(fixture);

describe("SQLite storage conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group))
				it(testCase.name, () => testCase.run());
		});
	}
});
