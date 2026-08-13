import { writeSync } from "node:fs";
import { createNodeSqliteFactory, SqliteStorageRepository } from "../src/index.ts";
import type { TimerFactory, TimerHandle } from "../src/sqlite/storage/lifecycle.ts";
import {
	baselineTransaction,
	CLOCK,
	CRASH_OWNER,
	type CrashMode,
	commitTransaction,
	createCrashFactory,
	createTransaction,
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

const mode = process.argv[2] as CrashMode | undefined;
const path = process.argv[3];
const cutArgument = process.argv[4];
const cut = cutArgument === "trace" ? undefined : cutArgument;
if ((mode !== "commit" && mode !== "create") || !path || !cutArgument)
	throw new Error("Expected mode, database path, and cut");
const timers = new DormantTimers();
if (mode === "create") {
	// Complete schema initialization before arming, without creating a session or baseline rows.
	const schema = new SqliteStorageRepository({ factory: createNodeSqliteFactory(), path, timers });
	await schema.list();
	await schema.close();
}
let metadata = { id: SESSION_ID, createdAt: CLOCK, storageVersion: 1 };
if (mode === "commit") {
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
	metadata = seeded.metadata;
	await seeded.close();
	await baseline.close();
}

const crash = createCrashFactory(createNodeSqliteFactory(), mode, cut, emit);
const repository = new SqliteStorageRepository({
	factory: crash.factory,
	path,
	now: () => CLOCK,
	ownerId: () => CRASH_OWNER,
	leaseTtlMs: TTL,
	heartbeatMs: 500,
	timers,
});
const opened = mode === "commit" ? await repository.open(metadata) : undefined;
crash.arm();
emit({ v: PROTOCOL_VERSION, event: "armed" });
const handle =
	mode === "create" ? await repository.create({ id: SESSION_ID, initialTransaction: createTransaction }) : opened!;
if (mode === "commit") await handle.commit(commitTransaction);
if (cut !== undefined) throw new Error(`Unknown cut was not reached: ${cut}`);
emit({ v: PROTOCOL_VERSION, event: "catalog", cuts: crash.catalog() });
emit({ v: PROTOCOL_VERSION, event: "complete" });
crash.disarm();
await handle.close();
await repository.close();
