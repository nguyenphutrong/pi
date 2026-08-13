import { writeSync } from "node:fs";
import { createNodeSqliteFactory, SqliteStorageRepository } from "../src/index.ts";
import type { TimerFactory, TimerHandle } from "../src/sqlite/storage/lifecycle.ts";
import {
	baselineTransaction,
	CLOCK,
	CRASH_OWNER,
	commitTransaction,
	createCrashFactory,
	PROTOCOL_VERSION,
	type ProtocolEvent,
	SESSION_ID,
	TTL,
} from "./process-crash-support.ts";

class DormantTimers implements TimerFactory {
	schedule(_callback: () => void, _delay: number): TimerHandle {
		return {};
	}
	cancel(_handle: TimerHandle): void {}
}

function emit(event: ProtocolEvent): void {
	writeSync(1, `${JSON.stringify(event)}\n`);
}

const path = process.argv[2];
const cut = process.argv[3] === "trace" ? undefined : process.argv[3];
if (!path || !process.argv[3]) throw new Error("Expected database path and cut");
const timers = new DormantTimers();
const baseline = new SqliteStorageRepository({
	factory: createNodeSqliteFactory(),
	path,
	now: () => CLOCK,
	ownerId: () => "baseline-owner",
	leaseTtlMs: TTL,
	heartbeatMs: 500,
	timers,
});
const seeded = await baseline.create({ id: SESSION_ID, initialTransaction: baselineTransaction });
const metadata = seeded.metadata;
await seeded.close();
await baseline.close();

const crash = createCrashFactory(createNodeSqliteFactory(), cut, emit);
const repository = new SqliteStorageRepository({
	factory: crash.factory,
	path,
	now: () => CLOCK,
	ownerId: () => CRASH_OWNER,
	leaseTtlMs: TTL,
	heartbeatMs: 500,
	timers,
});
const handle = await repository.open(metadata);
crash.arm();
emit({ v: PROTOCOL_VERSION, event: "armed" });
await handle.commit(commitTransaction);
if (cut !== undefined) throw new Error(`Unknown cut was not reached: ${cut}`);
emit({ v: PROTOCOL_VERSION, event: "catalog", cuts: crash.catalog() });
emit({ v: PROTOCOL_VERSION, event: "complete" });
crash.disarm();
await handle.close();
await repository.close();
