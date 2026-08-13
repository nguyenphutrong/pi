import {
	type Entry,
	type JsonValue,
	MemoryStorage,
	type Storage,
	type UsageRow,
	type Write,
} from "@nguyenphutrong/pi-session-storage";
import { instrumentStorage } from "@nguyenphutrong/pi-session-storage/testing";
import { describe, expect, it } from "vitest";
import type { LaneConfiguration } from "../src/durable.ts";
import { attachRuntime } from "../src/runtime-port.ts";
import { StoredSession, validateMainLane } from "../src/session.ts";
import { CURRENT_STORAGE_VERSION } from "../src/types.ts";
import { assistant, id, toolResult, user, ZERO_USAGE } from "./fixtures.ts";

const seed = (): LaneConfiguration => ({
	model: { provider: "test", modelId: "seed" },
	thinkingLevel: "low",
	activeToolNames: [],
});

function metadata() {
	return Object.freeze({ id: id(), createdAt: 1, storageVersion: CURRENT_STORAGE_VERSION });
}

function json(value: unknown): JsonValue {
	return value as JsonValue;
}

async function storageWith(writes: Write[] = []): Promise<MemoryStorage> {
	const storage = new MemoryStorage();
	await storage.commit({
		writes: [
			{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
			{
				kind: "register",
				op: "set",
				namespace: "lane.state",
				key: "main",
				value: { currentOperationId: null, pendingNextRun: [] },
			},
			...writes,
		],
	});
	return storage;
}

function session(storage: Storage): StoredSession {
	return new StoredSession(metadata(), storage, () => undefined);
}

type Position = "need_assistant" | "ready" | "effect_pending" | "retry_wait" | "failure_drain" | "may_finish";

function operationFixture(position: Position = "need_assistant", materialized = false) {
	const operationId = id();
	const source = id();
	const prompt = id();
	const response = id();
	const usage = id();
	const finished = position === "may_finish" || position === "failure_drain";
	const trigger = finished ? response : prompt;
	const context = {
		stepId: id(),
		triggerEntryId: trigger,
		configuration: seed(),
		streamOptions: {},
		retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
		overflowRecoveryUsed: false,
	};
	const phase =
		position === "failure_drain"
			? {
					kind: "failure_drain",
					error: { code: "provider_interrupted", message: "Provider outcome unknown after interruption" },
					provenance: { kind: "response", entryId: response },
				}
			: position === "retry_wait"
				? {
						kind: "assistant",
						generation: {
							status: "retry_wait",
							context: { ...context, retryPolicy: { maxAttempts: 3, baseDelayMs: 10 } },
							nextAttempt: 2,
							notBefore: 100,
							errorMessage: "Provider outcome unknown after interruption",
						},
					}
				: position === "ready"
					? { kind: "assistant", generation: { status: "ready", context, nextAttempt: 1 } }
					: position === "effect_pending"
						? {
								kind: "assistant",
								generation: {
									status: "effect_pending",
									context,
									attempt: 1,
									responseEntryId: response,
									usageId: usage,
									intendedOutputLimit: 1,
									contextWindow: 2,
								},
							}
						: {
								kind: "checkpoint",
								continuation: finished
									? { kind: "may_finish", includeFinalAssistant: true }
									: { kind: "need_assistant", overflowRecoveryUsed: false },
								triggerEntryId: trigger,
							};
	const responseWrites: Write[] =
		finished || (position === "effect_pending" && materialized)
			? [
					{
						kind: "entry",
						entry: {
							id: response,
							parentId: prompt,
							type: "message",
							payload: json(
								position === "failure_drain"
									? {
											...assistant("error"),
											content: [],
											api: "harness",
											usage: structuredClone(ZERO_USAGE),
											errorMessage: "Provider outcome unknown after interruption",
										}
									: assistant(),
							),
						},
					},
				]
			: [];
	const usageWrites: Write[] =
		position === "effect_pending" && materialized
			? [{ kind: "usage", row: { id: usage, entryId: response, adjustment: false, usage: ZERO_USAGE } }]
			: [];
	const writes: Write[] = [
		{ kind: "entry", entry: { id: source, parentId: null, type: "message", payload: json(user("source")) } },
		{ kind: "entry", entry: { id: prompt, parentId: source, type: "message", payload: json(user("prompt")) } },
		...responseWrites,
		...usageWrites,
		{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: trigger },
		{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: seed() as unknown as JsonValue },
		{
			kind: "register",
			op: "set",
			namespace: "lane.state",
			key: "main",
			value: { currentOperationId: operationId, pendingNextRun: [] },
		},
		{
			kind: "register",
			op: "set",
			namespace: "op.meta",
			key: operationId,
			value: json({
				operationId,
				lane: "main",
				sourceLeafId: source,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [prompt] },
			}),
		},
		{
			kind: "register",
			op: "set",
			namespace: "op.state",
			key: operationId,
			value: json({
				kind: "run",
				control: { status: "running" },
				settings: {
					compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 200 },
					steeringMode: "all",
					followUpMode: "all",
					toolExecution: "sequential",
				},
				phase,
				inbox: { steer: [], followUp: [], writes: [] },
				latestAssistantEntryId: finished ? response : null,
			}),
		},
	];
	return { operationId, source, prompt, trigger, response, usage, writes };
}

function replaceEffectPendingReservation(
	writes: Write[],
	replacement: { responseEntryId?: string; usageId?: string },
): Write[] {
	return writes.map((write): Write => {
		if (write.kind !== "register" || write.op !== "set" || write.namespace !== "op.state") return write;
		const state = write.value as Record<string, JsonValue>;
		const phase = state.phase as Record<string, JsonValue>;
		const generation = phase.generation as Record<string, JsonValue>;
		return {
			...write,
			value: {
				...state,
				phase: { ...phase, generation: { ...generation, ...replacement } },
			},
		};
	});
}

function forbidScansAndRecordLookups(storage: Storage) {
	const wrapped = instrumentStorage(storage);
	const entryLookups: string[][] = [];
	const usageLookups: string[][] = [];
	wrapped.getEntries = async (ids) => {
		entryLookups.push([...ids]);
		return storage.getEntries(ids);
	};
	wrapped.getUsageRows = async (ids) => {
		usageLookups.push([...ids]);
		return storage.getUsageRows(ids);
	};
	wrapped.listRegisters = async () => {
		throw new Error("register scan forbidden");
	};
	wrapped.scanEntries = async () => {
		throw new Error("entry scan forbidden");
	};
	wrapped.scanBranch = async () => {
		throw new Error("branch scan forbidden");
	};
	wrapped.scanBranchStructure = async () => {
		throw new Error("branch structure scan forbidden");
	};
	wrapped.getStats = async () => {
		throw new Error("usage scan forbidden");
	};
	return { wrapped, entryLookups, usageLookups };
}

describe("runtime attachment boundary", () => {
	it("validates the seed before consuming the exclusive attachment claim", async () => {
		const runtimeSession = session(await storageWith());
		const malformed = { ...seed(), unknown: true } as unknown as LaneConfiguration;
		await expect(attachRuntime(runtimeSession, malformed)).rejects.toMatchObject({ code: "corruption" });
		await expect(attachRuntime(runtimeSession, seed())).resolves.toBeDefined();
		await runtimeSession.close();
	});

	it("rejects a second attachment by its immediate promise", async () => {
		const runtimeSession = session(await storageWith());
		const first = attachRuntime(runtimeSession, seed());
		await expect(attachRuntime(runtimeSession, seed())).rejects.toMatchObject({ code: "active" });
		await expect(first).resolves.toBeDefined();
		await runtimeSession.close();
	});

	it("shares the Session mutation line and seeds exactly one config write when absent and idle", async () => {
		const instrumented = instrumentStorage(await storageWith());
		const runtimeSession = session(instrumented);
		const append = runtimeSession.appendMessage(user("before attach"));
		const attachment = attachRuntime(runtimeSession, seed());
		const entryId = await append;
		const attached = await attachment;
		expect(instrumented.committedTransactions).toHaveLength(2);
		expect(instrumented.committedTransactions[0].writes.map((write) => write.kind)).toEqual(["entry", "register"]);
		expect(instrumented.committedTransactions[1].writes).toEqual([
			expect.objectContaining({ kind: "register", namespace: "lane.config", key: "main" }),
		]);
		expect(attached.laneConfiguration.seq).toBeGreaterThan((await runtimeSession.getEntry(entryId))?.seq ?? 0);
		await runtimeSession.close();
	});

	it("keeps existing config authoritative and detached from seed and returned mutations", async () => {
		const existing = { ...seed(), model: { provider: "existing", modelId: "authoritative" } };
		const instrumented = instrumentStorage(
			await storageWith([{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: existing }]),
		);
		const runtimeSession = session(instrumented);
		const mutableSeed = seed();
		const attached = await attachRuntime(runtimeSession, mutableSeed);
		mutableSeed.model.modelId = "mutated";
		attached.laneConfiguration.value.model.modelId = "returned mutation";
		expect(instrumented.committedTransactions).toHaveLength(0);
		expect((await instrumented.getRegister("lane.config", "main"))?.value).toEqual(existing);
		await runtimeSession.close();
	});

	it("rejects an open operation without configuration", async () => {
		const fixture = operationFixture();
		const writes = fixture.writes.filter(
			(write) => !(write.kind === "register" && write.namespace === "lane.config"),
		);
		const runtimeSession = session(await storageWith(writes));
		await expect(attachRuntime(runtimeSession, seed())).rejects.toMatchObject({ code: "corruption" });
		await runtimeSession.close();
	});

	it("returns detached exact hydration maps and all current register sequences", async () => {
		const fixture = operationFixture("effect_pending", true);
		const storage = await storageWith(fixture.writes);
		const runtimeSession = session(storage);
		const attached = await attachRuntime(runtimeSession, seed());
		for (const current of [
			attached.laneConfiguration,
			attached.laneState,
			attached.mainLeaf,
			attached.runOperation,
			attached.runState,
		])
			expect(current).toMatchObject({ seq: expect.any(Number) });
		expect([...attached.entries.keys()].sort()).toEqual([fixture.prompt, fixture.response, fixture.source].sort());
		expect([...attached.usageRows.keys()]).toEqual([fixture.usage]);

		const returnedEntries = attached.entries as unknown as Map<string, { message: { content: unknown } }>;
		const returnedUsage = attached.usageRows as unknown as Map<string, { usage: { input: number } }>;
		returnedEntries.get(fixture.prompt)!.message.content = "mutated";
		returnedUsage.get(fixture.usage)!.usage.input = 99;
		returnedEntries.clear();
		returnedUsage.clear();
		expect((await storage.getEntries([fixture.prompt])).get(fixture.prompt)?.payload).toEqual(user("prompt"));
		expect((await storage.getUsageRows([fixture.usage])).get(fixture.usage)?.usage.input).toBe(0);
		await runtimeSession.close();
	});

	it("attaches idle state with one empty exact batch per kind and no scans", async () => {
		const storage = await storageWith();
		const { wrapped, entryLookups, usageLookups } = forbidScansAndRecordLookups(storage);
		const runtimeSession = session(wrapped);
		await expect(attachRuntime(runtimeSession, seed())).resolves.toBeDefined();
		expect(entryLookups).toEqual([[]]);
		expect(usageLookups).toEqual([[]]);
		await runtimeSession.close();
	});

	it.each(["need_assistant", "ready", "effect_pending", "retry_wait", "failure_drain", "may_finish"] as const)(
		"restores the valid %s closure with one unique exact batch per kind and no scans",
		async (position) => {
			const fixture = operationFixture(position);
			const storage = await storageWith(fixture.writes);
			const { wrapped, entryLookups, usageLookups } = forbidScansAndRecordLookups(storage);
			const runtimeSession = session(wrapped);
			await expect(attachRuntime(runtimeSession, seed())).resolves.toBeDefined();
			const expectedEntries = [
				fixture.source,
				fixture.prompt,
				...(position === "may_finish" || position === "failure_drain" ? [fixture.response] : []),
				...(position === "effect_pending" ? [fixture.response, fixture.usage] : []),
			];
			expect(entryLookups).toHaveLength(1);
			expect(new Set(entryLookups[0])).toEqual(new Set(expectedEntries));
			expect(entryLookups[0]).toHaveLength(new Set(entryLookups[0]).size);
			const expectedUsage = position === "effect_pending" ? [fixture.response, fixture.usage] : [];
			expect(usageLookups).toHaveLength(1);
			expect(new Set(usageLookups[0])).toEqual(new Set(expectedUsage));
			expect(usageLookups[0]).toHaveLength(new Set(usageLookups[0]).size);
			await runtimeSession.close();
		},
	);

	it("hydrates retry_wait without old reservation ids or lane.lastResult and writes nothing", async () => {
		const fixture = operationFixture("retry_wait");
		const instrumented = instrumentStorage(await storageWith(fixture.writes));
		const reads: string[] = [];
		const getRegister = instrumented.getRegister.bind(instrumented);
		instrumented.getRegister = async (namespace, key) => {
			reads.push(`${namespace}/${key}`);
			return getRegister(namespace, key);
		};
		const entryLookups: string[][] = [];
		const usageLookups: string[][] = [];
		const getEntries = instrumented.getEntries.bind(instrumented);
		const getUsageRows = instrumented.getUsageRows.bind(instrumented);
		instrumented.getEntries = async (ids) => {
			entryLookups.push([...ids]);
			return getEntries(ids);
		};
		instrumented.getUsageRows = async (ids) => {
			usageLookups.push([...ids]);
			return getUsageRows(ids);
		};
		const runtimeSession = session(instrumented);
		await expect(attachRuntime(runtimeSession, seed())).resolves.toBeDefined();
		expect(entryLookups.flat()).not.toContain(fixture.response);
		expect(entryLookups.flat()).not.toContain(fixture.usage);
		expect(usageLookups).toEqual([[]]);
		expect(reads).not.toContain("lane.lastResult/main");
		expect(instrumented.committedTransactions).toEqual([]);
		await runtimeSession.close();
	});

	it("accepts the D-025 failure_drain boundary with alternate typed entry-owned identity fields", async () => {
		const fixture = operationFixture("failure_drain");
		const writes = fixture.writes.map((write): Write => {
			if (write.kind !== "entry" || write.entry.id !== fixture.response) return write;
			return {
				...write,
				entry: {
					...write.entry,
					payload: {
						...(write.entry.payload as Record<string, JsonValue>),
						provider: "alternate-provider",
						model: "alternate-model",
						timestamp: 1234.5,
					},
				},
			};
		});
		await expect(validateMainLane(await storageWith(writes))).resolves.toBeUndefined();
	});

	it.each([
		"missing response",
		"wrong role",
		"wrong stop reason",
		"wrong provenance",
		"wrong phase error code",
		"wrong phase error message",
		"wrong response error message",
		"missing response error message",
		"wrong response api",
		"non-empty response content",
		"nonzero response usage",
		"optional response usage field",
		"optional response field",
	])("rejects failure_drain corruption: %s", async (kind) => {
		const fixture = operationFixture("failure_drain");
		const writes = fixture.writes
			.filter(
				(write) => kind !== "missing response" || write.kind !== "entry" || write.entry.id !== fixture.response,
			)
			.map((write): Write => {
				if (write.kind === "entry" && write.entry.id === fixture.response) {
					if (kind === "wrong role") return { ...write, entry: { ...write.entry, payload: json(user("wrong")) } };
					if (kind === "wrong stop reason")
						return { ...write, entry: { ...write.entry, payload: json(assistant("stop")) } };
					const payload = structuredClone(write.entry.payload) as Record<string, JsonValue>;
					if (kind === "wrong response error message") payload.errorMessage = "different";
					if (kind === "missing response error message") delete payload.errorMessage;
					if (kind === "wrong response api") payload.api = "anthropic-messages";
					if (kind === "non-empty response content") payload.content = [{ type: "text", text: "unexpected" }];
					if (kind === "nonzero response usage") (payload.usage as Record<string, JsonValue>).input = 1;
					if (kind === "optional response usage field") (payload.usage as Record<string, JsonValue>).reasoning = 0;
					if (kind === "optional response field") payload.responseId = "response-1";
					return { ...write, entry: { ...write.entry, payload } };
				}
				if (write.kind === "register" && write.op === "set" && write.namespace === "op.state") {
					const value = structuredClone(write.value) as Record<string, JsonValue>;
					const phase = value.phase as Record<string, JsonValue>;
					if (kind === "wrong provenance") {
						phase.provenance = { kind: "response", entryId: fixture.prompt };
						value.latestAssistantEntryId = fixture.prompt;
					}
					if (kind === "wrong phase error code")
						(phase.error as Record<string, JsonValue>).code = "provider_error";
					if (kind === "wrong phase error message")
						(phase.error as Record<string, JsonValue>).message = "different";
					return { ...write, value };
				}
				return write;
			});
		await expect(validateMainLane(await storageWith(writes))).rejects.toMatchObject({ code: "corruption" });
	});
});

describe("bounded Phase 1 closure validation", () => {
	it.each(["completed-prefix hole", "mismatched completed source"] as const)(
		"rejects direct tools-state corruption write-free: %s",
		async (kind) => {
			const fixture = operationFixture();
			const firstResult = id();
			const secondResult = id();
			const writes = fixture.writes.map((write): Write => {
				if (write.kind === "entry" && write.entry.id === fixture.prompt)
					return {
						...write,
						entry: {
							...write.entry,
							payload: json({
								...assistant("toolUse"),
								content: [
									{ type: "toolCall", id: "call-a", name: "read", arguments: {} },
									{ type: "toolCall", id: "call-b", name: "write", arguments: {} },
								],
							}),
						},
					};
				if (write.kind === "register" && write.op === "set" && write.namespace === "lane.leaf")
					return { ...write, value: kind === "completed-prefix hole" ? secondResult : firstResult };
				if (write.kind === "register" && write.op === "set" && write.namespace === "op.state")
					return {
						...write,
						value: json({
							...(write.value as Record<string, JsonValue>),
							latestAssistantEntryId: fixture.prompt,
							phase: {
								kind: "tools",
								batch: {
									assistantEntryId: fixture.prompt,
									configuration: seed(),
									turnId: id(),
									calls:
										kind === "completed-prefix hole"
											? [
													{ status: "planned", sourceIndex: 0, resultEntryId: firstResult },
													{ status: "completed", sourceIndex: 1, resultEntryId: secondResult },
												]
											: [
													{ status: "completed", sourceIndex: 0, resultEntryId: firstResult },
													{ status: "planned", sourceIndex: 1, resultEntryId: secondResult },
												],
								},
							},
						}),
					};
				return write;
			});
			writes.push({
				kind: "entry",
				entry: {
					id: kind === "completed-prefix hole" ? secondResult : firstResult,
					parentId: kind === "mismatched completed source" ? fixture.source : fixture.prompt,
					type: "message",
					payload: json({
						...toolResult(),
						toolCallId: kind === "mismatched completed source" ? "wrong-call" : "call-b",
						toolName: kind === "mismatched completed source" ? "wrong-tool" : "write",
					}),
				},
			});
			const instrumented = instrumentStorage(await storageWith(writes));
			await expect(attachRuntime(session(instrumented), seed())).rejects.toMatchObject({ code: "corruption" });
			expect(instrumented.committedTransactions).toEqual([]);
		},
	);

	it.each([
		["assistant", assistant()],
		["toolResult", toolResult()],
	])("accepts a pre-settlement need_assistant closure with a caller-provided %s prompt", async (_role, payload) => {
		const fixture = operationFixture();
		const writes = fixture.writes.map(
			(write): Write =>
				write.kind === "entry" && write.entry.id === fixture.prompt
					? { ...write, entry: { ...write.entry, payload: json(payload) } }
					: write,
		);
		await expect(validateMainLane(await storageWith(writes))).resolves.toBeUndefined();
	});

	it.each(["lane leaf", "source leaf", "prompt", "current trigger", "latest assistant"])(
		"rejects a missing required %s reference",
		async (missing) => {
			const position = missing === "latest assistant" ? "may_finish" : "need_assistant";
			const fixture = operationFixture(position);
			const omitted =
				missing === "lane leaf" || missing === "current trigger" || missing === "prompt"
					? fixture.prompt
					: missing === "source leaf"
						? fixture.source
						: fixture.response;
			const writes = fixture.writes.filter(
				(write) => missing === "source leaf" || write.kind !== "entry" || write.entry.id !== omitted,
			);
			if (missing === "lane leaf") {
				const leaf = writes.find(
					(write) => write.kind === "register" && write.op === "set" && write.namespace === "lane.leaf",
				) as Extract<Write, { kind: "register"; op: "set" }>;
				leaf.value = id();
			}
			const delegate = await storageWith(writes);
			if (missing === "source leaf") {
				const storage = instrumentStorage(delegate);
				storage.getEntries = async (ids) => {
					const rows = new Map(await delegate.getEntries(ids));
					rows.delete(fixture.source);
					return rows;
				};
				await expect(validateMainLane(storage)).rejects.toMatchObject({ code: "corruption" });
			} else await expect(validateMainLane(delegate)).rejects.toMatchObject({ code: "corruption" });
		},
	);

	it("rejects a latest-assistant reference whose message role is not assistant", async () => {
		const fixture = operationFixture("may_finish");
		const writes = fixture.writes.map(
			(write): Write =>
				write.kind === "entry" && write.entry.id === fixture.response
					? { ...write, entry: { ...write.entry, payload: json(user("wrong role")) } }
					: write,
		);
		await expect(validateMainLane(await storageWith(writes))).rejects.toMatchObject({ code: "corruption" });
	});

	it("accepts effect_pending before response and usage reservations materialize", async () => {
		const fixture = operationFixture("effect_pending");
		await expect(validateMainLane(await storageWith(fixture.writes))).resolves.toBeUndefined();
	});

	it.each(["source", "prompt"] as const)(
		"rejects an effect_pending usage reservation occupied by the rooted %s entry",
		async (occupiedBy) => {
			const fixture = operationFixture("effect_pending");
			const writes = replaceEffectPendingReservation(fixture.writes, { usageId: fixture[occupiedBy] });
			await expect(validateMainLane(await storageWith(writes))).rejects.toMatchObject({ code: "corruption" });
		},
	);

	it("rejects an effect_pending response reservation occupied by an existing usage row", async () => {
		const fixture = operationFixture("effect_pending");
		const writes: Write[] = [
			...fixture.writes,
			{
				kind: "usage",
				row: { id: fixture.response, entryId: fixture.prompt, adjustment: false, usage: ZERO_USAGE },
			},
		];
		await expect(validateMainLane(await storageWith(writes))).rejects.toMatchObject({ code: "corruption" });
	});

	it.each(["mismatched meta id", "missing state register", "malformed state"])(
		"rejects an open operation with %s",
		async (kind) => {
			const fixture = operationFixture();
			const writes = fixture.writes
				.filter(
					(write) =>
						kind !== "missing state register" || write.kind !== "register" || write.namespace !== "op.state",
				)
				.map((write): Write => {
					if (
						write.kind === "register" &&
						write.op === "set" &&
						write.namespace === "op.meta" &&
						kind === "mismatched meta id"
					)
						return {
							...write,
							value: { ...(write.value as Record<string, JsonValue>), operationId: id() },
						};
					if (
						write.kind === "register" &&
						write.op === "set" &&
						write.namespace === "op.state" &&
						kind === "malformed state"
					)
						return { ...write, value: { ...(write.value as Record<string, JsonValue>), extra: true } };
					return write;
				});
			await expect(validateMainLane(await storageWith(writes))).rejects.toMatchObject({ code: "corruption" });
		},
	);

	it.each([
		"response only",
		"usage only",
		"wrong response role",
		"wrong response parent",
		"adjustment",
		"wrong usage entry",
	])("rejects effect_pending reservation corruption: %s", async (kind) => {
		const fixture = operationFixture("effect_pending", true);
		const writes = fixture.writes
			.filter((write) =>
				kind === "response only"
					? write.kind !== "usage"
					: kind === "usage only"
						? write.kind !== "entry" || write.entry.id !== fixture.response
						: true,
			)
			.map((write): Write => {
				if (write.kind === "entry" && write.entry.id === fixture.response) {
					if (kind === "wrong response role")
						return { ...write, entry: { ...write.entry, payload: json(user("wrong")) } };
					if (kind === "wrong response parent")
						return { ...write, entry: { ...write.entry, parentId: fixture.source } };
				}
				if (write.kind === "usage") {
					if (kind === "adjustment") return { ...write, row: { ...write.row, adjustment: true } };
					if (kind === "wrong usage entry") return { ...write, row: { ...write.row, entryId: fixture.prompt } };
				}
				return write;
			});
		const delegate = await storageWith(kind === "usage only" ? fixture.writes : writes);
		if (kind === "usage only") {
			const storage = instrumentStorage(delegate);
			storage.getEntries = async (ids) => {
				const rows = new Map(await delegate.getEntries(ids));
				rows.delete(fixture.response);
				return rows;
			};
			await expect(validateMainLane(storage)).rejects.toMatchObject({ code: "corruption" });
		} else await expect(validateMainLane(delegate)).rejects.toMatchObject({ code: "corruption" });
	});

	it("rejects a usage lookup row whose map key/id does not match the reserved id", async () => {
		const fixture = operationFixture("effect_pending", true);
		const delegate = await storageWith(fixture.writes);
		const wrongId = id();
		const storage = instrumentStorage(delegate);
		storage.getUsageRows = async (): Promise<ReadonlyMap<string, UsageRow>> => {
			const row = (await delegate.getUsageRows([fixture.usage])).get(fixture.usage)!;
			return new Map([[fixture.usage, { ...row, id: wrongId }]]);
		};
		await expect(validateMainLane(storage)).rejects.toMatchObject({ code: "corruption" });
	});

	it("rejects an entry lookup whose map key/id does not match the requested id", async () => {
		const fixture = operationFixture();
		const delegate = await storageWith(fixture.writes);
		const storage = instrumentStorage(delegate);
		storage.getEntries = async (ids): Promise<ReadonlyMap<string, Entry>> => {
			const rows = new Map(await delegate.getEntries(ids));
			const prompt = rows.get(fixture.prompt)!;
			rows.set(fixture.prompt, { ...prompt, id: id() });
			return rows;
		};
		await expect(validateMainLane(storage)).rejects.toMatchObject({ code: "corruption" });
	});
});
